// @ts-check
/**
 * 场景索引 —— gist 生成
 *
 * 规格：BUILD-PLAN.md §4.2 ｜ 关键决策：D-029（三段式）/ D-035（永不注入）/ D-040（禁用词）
 *
 * 一句话原则：**gist 是给搜索用的索引，不是给人读的摘要。写不进去的锚点就不要写。**
 *
 * 三个角色分工必须记清楚：
 *   - `gist`        → 纯检索锚点，**永不注入给TA**（D-035）
 *   - `lead_in`     → 前一场尾部原文，注入时用（D-100）
 *   - `vec_scene`   → gist 的向量，参与语义路
 * 所以这里写得「不像人话」不是缺陷，是设计目标。写得像散文才是 bug。
 *
 * 不碰数据库：unresolved 词返回给上层。**注意**：原本要写进 `lexicon` 表，
 * 但梗词典已整块删除（D-240），所以这个字段目前**没有消费方**——留着是因为它是纯函数，
 * 不写库、不占资源；将来真要做"不懂的词"时可以直接用。
 */

import { GIST_SYSTEM, renderGistUser, GIST_BANNED_WORDS } from './prompts.js';
import { parseJsonLoose } from '../model/llm.js';

/**
 * 三段式的标签。顺序固定，不许改（D-029）。
 */
export const GIST_LABELS = Object.freeze({
  what: '【发生了什么】',
  quote: '【原话】',
  unknown: '【不懂的】',
});

/** 长度区间（D-040：30~60 字）。按「非空白字符数」算，中文一字计一 */
export const GIST_LIMITS = Object.freeze({ minChars: 30, maxChars: 60 });

/** 【不懂的】为空时的固定写法 */
const EMPTY_UNKNOWN = '无';

/**
 * 生成一个场景的 gist。
 *
 * @param {object} opts
 * @param {{complete: Function}} opts.llm
 * @param {{seq:number, speaker:string, text:string, at?:number}[]} opts.msgs 该场景的消息
 * @param {number} [opts.startAt]
 * @param {number} [opts.endAt]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   gist: string|null,
 *   unresolved: string[],
 *   ok: boolean,
 *   issues: string[],
 *   stats: {charCount:number, bannedRemoved:string[], lengthOk:boolean}
 * }>}
 */
export async function generateGist(opts) {
  const { llm, msgs, startAt, endAt, signal } = opts;

  if (!llm || typeof llm.complete !== 'function') {
    throw new TypeError('generateGist 需要提供 llm.complete');
  }
  if (!Array.isArray(msgs)) throw new TypeError('generateGist 需要 msgs 数组');

  // 空场景不生成 gist：没有原文就没有锚点，硬写只能编
  if (msgs.length === 0) {
    return {
      gist: null,
      unresolved: [],
      ok: false,
      issues: ['场景没有消息，跳过 gist'],
      stats: { charCount: 0, bannedRemoved: [], lengthOk: false },
    };
  }

  const user = renderGistUser(msgs, { startAt, endAt });

  const text = await llm.complete(
    [
      { role: 'system', content: GIST_SYSTEM },
      { role: 'user', content: user },
    ],
    { responseFormat: 'json', signal },
  );

  return finalizeGist(text, { msgs });
}

/**
 * 把模型输出规范成三段式。
 * 单独导出，便于测试直接喂字符串、也便于上层做「重建 gist」时复用。
 *
 * 处理顺序（每一步都可能让上一步的结果失效，所以顺序固定）：
 *   ① 解析 JSON（容忍 ``` 围栏）
 *   ② 校验三段标签齐全 —— 缺一段就判废，不做补写（补写就是编）
 *   ③ 清洗禁用词
 *   ④ 校正长度到 30~60 字
 *   ⑤ 抽 unresolved
 *
 * @param {string} text  模型原始输出
 * @param {object} [ctx]
 * @param {{seq:number,speaker:string,text:string}[]} [ctx.msgs] 原始消息，用于校验【原话】是否逐字出现
 * @returns {{gist:string|null, unresolved:string[], ok:boolean, issues:string[], stats:object}}
 */
export function finalizeGist(text, ctx = {}) {
  const issues = [];

  // ① 解析
  let parsed;
  try {
    parsed = parseJsonLoose(text);
  } catch (err) {
    return fail(`模型输出无法解析为 JSON：${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    return fail('模型输出不是对象');
  }

  const rawGist = typeof parsed.gist === 'string' ? parsed.gist : typeof parsed === 'string' ? parsed : '';
  if (!rawGist.trim()) return fail('模型输出缺少 gist 字段');

  // ② 解析三段
  const sections = parseSections(rawGist);
  if (!sections) {
    return fail(
      `三段式不完整，模型输出里缺少标签。原文：${rawGist.slice(0, 120)}`,
    );
  }

  // ③ 清洗禁用词（D-040）
  // 描述段整句删；【原话】只删「带禁用词、且不是原文逐字摘录」的引号句 ——
  // 用户真的这么说过，那它就是可检索的用词，抹掉反而是造假（D-029 一字不改）。
  const strippedWhat = stripBanned(sections.what);
  const strippedUnknown = stripBanned(sections.unknown);
  const cleanedQuote = cleanQuotes(sections.quote, ctx.msgs);
  const bannedRemoved = [
    ...strippedWhat.removed,
    ...strippedUnknown.removed,
    ...cleanedQuote.removed,
  ];

  // ④ 校正长度。清洗会让字数变少，所以长度校正放在清洗之后
  const adjusted = fixLength({
    what: strippedWhat.text,
    quote: cleanedQuote.text,
    unknown: strippedUnknown.text,
  });

  // ⑤ 抽 unresolved：以模型给的数组为准，再用【不懂的】段兜底
  let unresolved = normalizeUnresolvedList(parsed.unresolved);
  if (unresolved.length === 0) {
    unresolved = extractUnresolvedFromSection(adjusted.unknown);
  }

  // 额外校验：【原话】段里的引号内容是否真的在原文里逐字出现（防改写）
  const quoteIssues = checkQuotesVerbatim(adjusted.quote, ctx.msgs);
  issues.push(...quoteIssues);

  const gist = render(adjusted);
  const charCount = countChars(gist);

  const lengthOk = charCount >= GIST_LIMITS.minChars && charCount <= GIST_LIMITS.maxChars;
  if (!lengthOk) {
    issues.push(`gist 长度 ${charCount} 字，超出 ${GIST_LIMITS.minChars}~${GIST_LIMITS.maxChars}`);
  }

  return {
    gist,
    unresolved,
    // 长度不达标不算致命：gist 只做索引，稍长稍短都能用。
    // 真正致命的只有「三段不全」和「解析失败」——那两种返回 null。
    ok: lengthOk || charCount > 0,
    issues,
    stats: {
      charCount,
      bannedRemoved: [...new Set(bannedRemoved)],
      lengthOk,
      quoteCount: countQuotes(adjusted.quote),
    },
  };

  function fail(reason) {
    return {
      gist: null,
      unresolved: [],
      ok: false,
      issues: [reason],
      stats: { charCount: 0, bannedRemoved: [], lengthOk: false, quoteCount: 0 },
    };
  }
}

/**
 * 从三段式文本里拆出三段内容。
 * 缺任意一段 → 返回 null（不补、不猜）。
 *
 * @param {string} text
 * @returns {{what:string, quote:string, unknown:string}|null}
 */
export function parseSections(text) {
  if (typeof text !== 'string') return null;

  const idxWhat = text.indexOf(GIST_LABELS.what);
  const idxQuote = text.indexOf(GIST_LABELS.quote);
  const idxUnknown = text.indexOf(GIST_LABELS.unknown);

  // 三个标签都必须出现，且顺序必须是 what → quote → unknown
  if (idxWhat < 0 || idxQuote < 0 || idxUnknown < 0) return null;
  if (!(idxWhat < idxQuote && idxQuote < idxUnknown)) return null;

  const what = text.slice(idxWhat + GIST_LABELS.what.length, idxQuote).trim();
  const quote = text.slice(idxQuote + GIST_LABELS.quote.length, idxUnknown).trim();
  const unknown = text.slice(idxUnknown + GIST_LABELS.unknown.length).trim();

  return { what, quote, unknown };
}

/**
 * 拼回规范的三段式字符串。换行与标签固定，保证 gist 可被稳定检索/展示。
 *
 * @param {{what:string, quote:string, unknown:string}} s
 */
export function render(s) {
  return [
    `${GIST_LABELS.what}${s.what || EMPTY_UNKNOWN}`,
    `${GIST_LABELS.quote}${s.quote || EMPTY_UNKNOWN}`,
    `${GIST_LABELS.unknown}${s.unknown || EMPTY_UNKNOWN}`,
  ].join('\n');
}

/**
 * 清洗【原话】段里的禁用词。
 *
 * 规则比描述段更窄（因为原话受 D-029「一字不改」保护）：
 *   - 引号内的句子**如果确实逐字出自原文** → 原样保留，哪怕含禁用词
 *     （他真的说了「气氛微妙」，那这就是个真锚点）
 *   - 引号内的句子**在原文里找不到、又含禁用词** → 整句删掉（疑似模型的评价混进了原话）
 *   - 没有 msgs 可核对时 → 保守保留，只做长度校正
 *
 * @param {string} quote
 * @param {{text:string}[]|undefined} msgs
 * @returns {{text:string, removed:string[]}}
 */
export function cleanQuotes(quote, msgs) {
  if (!quote || quote === EMPTY_UNKNOWN) return { text: quote ?? '', removed: [] };
  if (!msgs || msgs.length === 0) return { text: quote, removed: [] };

  const full = msgs.map((m) => m.text).join('\n');
  const removed = [];

  // 把引号句与引号外的连接符分开处理：只对引号句做判断
  const parts = quote.split(/(「[^」]*」|"[^"]*"|“[^”]*”)/u);
  const kept = [];

  for (const part of parts) {
    const m = part.match(/^[「"“]([\s\S]*)[」"”]$/u);
    if (!m) {
      kept.push(part);
      continue;
    }
    const inner = m[1];
    const hit = GIST_BANNED_WORDS.find((w) => inner.includes(w));
    if (!hit) {
      kept.push(part);
      continue;
    }
    // 含禁用词：只有确认它逐字出自原文才留下
    if (full.includes(inner)) {
      kept.push(part);
    } else {
      removed.push(hit);
      // 整句删掉，不保留空引号
    }
  }

  const text = kept.join('').replace(/^[，,。；;、\s]+/, '').replace(/[，,。；;、\s]+$/u, '').trim();
  return { text, removed };
}

/**
 * 剔除禁用词。
 *
 * 策略选择：**优先删整个短句，而不是把词挖掉留个洞**。
 * 「气氛很微妙」挖掉禁用词会变成「很」，既不通顺也没变成锚点。
 * 按标点切句，整句删掉，剩下的才是真锚点。
 * 只有整段都被删空时才退回到「只挖词」的保底策略（避免整段消失）。
 *
 * @param {string} text
 * @returns {{text:string, removed:string[]}}
 */
export function stripBanned(text) {
  if (typeof text !== 'string' || !text.trim()) return { text: '', removed: [] };

  const removed = [];
  const clausified = text.split(/(?<=[，,。；;！!？?、\s])/u);

  const kept = [];
  for (const clause of clausified) {
    const hit = GIST_BANNED_WORDS.find((w) => clause.includes(w));
    if (hit) {
      removed.push(hit);
      continue; // 整句丢弃
    }
    kept.push(clause);
  }

  let out = kept.join('').trim();

  // 保底：整段被删空 → 退回到「只挖词」，至少留下些能搜的字
  if (!out) {
    out = text;
    for (const word of GIST_BANNED_WORDS) {
      if (out.includes(word)) {
        removed.push(word);
        out = out.replaceAll(word, '');
      }
    }
    out = out.trim();
  }

  // 清掉句首残留标点与多余空白
  out = out.replace(/^[，,。；;！!？?、\s]+/, '').replace(/\s+/g, ' ').trim();

  return { text: out, removed };
}

/**
 * 把总字数压进 30~60 字。
 *
 * 各段的弹性不同（凭经验初定，理由写在后面）：
 *   - 【发生了什么】最软：允许逐字截断，它还承担主要字数。但有个地板（16 字），
 *     再短就不像「发生了什么」，会丢掉检索价值
 *   - 【原话】次之：只按整句删，绝不截半句（截半句就变成改写了）
 *   - 【不懂的】最硬：它是唯一承载「不知道」的段，尽量保留
 *
 * 按这个优先级依次削，每轮削掉「超出量」，避免一字一字挪的低效与下限失控。
 *
 * @param {{what:string, quote:string, unknown:string}} s
 * @returns {{what:string, quote:string, unknown:string}}
 */
function fixLength(s) {
  const out = { ...s };
  const WHAT_FLOOR = 16;
  const UNKNOWN_FLOOR = 4;

  let guard = 0;
  while (countChars(render(out)) > GIST_LIMITS.maxChars && guard++ < 100) {
    const over = countChars(render(out)) - GIST_LIMITS.maxChars;

    // ① 先削【发生了什么】，但不低于地板
    const whatLen = countChars(out.what);
    if (whatLen > WHAT_FLOOR) {
      out.what = truncateChars(out.what, Math.max(WHAT_FLOOR, whatLen - over));
      continue;
    }

    // ② 再按整句删【原话】
    const quoteSentences = splitQuotes(out.quote);
    if (quoteSentences.length > 1) {
      quoteSentences.pop();
      out.quote = quoteSentences.join('');
      continue;
    }

    // ③ 再削【不懂的】，同样留地板
    const unknownLen = countChars(out.unknown);
    if (unknownLen > UNKNOWN_FLOOR) {
      out.unknown = truncateChars(out.unknown, Math.max(UNKNOWN_FLOOR, unknownLen - over));
      continue;
    }

    // ④ 兜底：所有地板都不管了，硬压
    if (whatLen > 2) {
      out.what = truncateChars(out.what, 2);
      continue;
    }
    if (unknownLen > 1) {
      out.unknown = truncateChars(out.unknown, 1);
      continue;
    }
    break;
  }

  // 清掉因截断产生的尾部残标点
  out.what = out.what.replace(/[，,。；;、\s]+$/u, '');
  out.quote = out.quote.replace(/[，,。；;、\s]+$/u, '');
  out.unknown = out.unknown.replace(/[，,。；;、\s]+$/u, '');

  // 太短：不补内容（补内容就是编）。只在【不懂的】空掉时补「无」
  if (!out.unknown) out.unknown = EMPTY_UNKNOWN;

  return out;
}

/** 【原话】段按「」切成整句，用于「只删整句」的长度调节 */
function splitQuotes(quote) {
  if (!quote) return [];
  // 匹配「...」或 "..."，保留分隔符
  const parts = quote.match(/「[^」]*」|"[^"]*"|“[^”]*”/gu);
  if (parts && parts.length > 0) {
    // 把非引号部分（如顿号、逗号）归到前一句
    return parts;
  }
  return quote ? [quote] : [];
}

/** 统计【原话】里摘了几句 */
function countQuotes(quote) {
  const parts = quote.match(/「[^」]*」|"[^"]*"|“[^”]*”/gu);
  return parts ? parts.length : quote && quote !== EMPTY_UNKNOWN ? 1 : 0;
}

/**
 * 校验【原话】段是否逐字出自原文。
 * 只报警不丢弃：引号外可能混了模型加的标点，硬丢会误伤。
 *
 * @param {string} quote
 * @param {{text:string}[]|undefined} msgs
 * @returns {string[]} issues
 */
export function checkQuotesVerbatim(quote, msgs) {
  if (!msgs || msgs.length === 0 || !quote || quote === EMPTY_UNKNOWN) return [];
  const full = msgs.map((m) => m.text).join('\n');

  const quoted = [...quote.matchAll(/「([^」]*)」/gu)].map((m) => m[1].trim()).filter(Boolean);
  const issues = [];
  for (const q of quoted) {
    if (!full.includes(q)) {
      issues.push(`【原话】里的「${q}」在原文中找不到，疑似改写`);
    }
  }
  return issues;
}

/** unresolved 数组规范化：去重、去空白、去「无」 */
function normalizeUnresolvedList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim().replace(/^[「"“]|[」"”]$/gu, '');
    if (!t || t === EMPTY_UNKNOWN || t === '没有') continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 从【不懂的】段里抽词：按顿号/逗号/空格切，去掉解释性括注 */
export function extractUnresolvedFromSection(text) {
  if (!text || text === EMPTY_UNKNOWN) return [];
  const out = [];
  for (const raw of text.split(/[、，,；;/\s]+/u)) {
    let t = raw.trim().replace(/^[「"“]|[」"”]$/gu, '');
    // 只转写不解释（D-029）：如果模型写了「词（解释）」，只留词
    t = t.replace(/[（(][^）)]*[）)]/gu, '').trim();
    if (!t || t === EMPTY_UNKNOWN) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 统计非空白字符数（码点） */
export function countChars(s) {
  return [...String(s).replace(/\s+/gu, '')].length;
}

/** 按码点截断到 n 个字 */
function truncateChars(s, n) {
  if (n <= 0) return '';
  return [...s].slice(0, n).join('');
}

/* ============================ 零 LLM 抽取式 gist（Tier 1） ============================ */

/** 纯寒暄/填充词（不宜单独做场景主题锚点） */
const FILLER_RE = /^(嗯+|好+的?|哦+|啊+|哈+|呵+|行|可以|收到|ok|okay|yes|no|好的+|谢谢|谢啦|明白了?|了解|没问题|是的?|对+)[!！。.~～?？]*$/iu;

/** 清洗单条消息为紧凑单行（去围栏代码块与 Markdown 装饰，不改实质用词） */
function cleanForGist(raw) {
  let s = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉开头重复的 [代码]
  s = s.replace(/^(\[代码\]\s*)+/, '[代码] ').trim();
  return s;
}

/** 提取一句干净短句（按句末标点截到首句，再按字数封顶） */
function clipClause(text, maxChars) {
  const s = cleanForGist(text);
  if (!s) return '';
  const firstSent = s.split(/[。！？!?；;\n]/u).map((x) => x.trim()).find(Boolean) ?? s;
  const pick = [...firstSent].length >= 4 ? firstSent : s;
  if ([...pick].length <= maxChars) return pick;
  return `${truncateChars(pick, Math.max(1, maxChars - 1))}…`;
}

function unitVec(v) {
  if (!v || !v.length) return null;
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n <= 1e-12) return null;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function cosineDot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 零 LLM 成本的抽取式 gist（Tier 1，确定性、零幻觉）。
 *
 * - 有 `opts.vectors`（复用已有 vec_msg）时：用整场质心相似度 + MMR 选出最能代表整场核心的 1~2 句；
 * - 无向量时：选首条实质性 user 发言 + 场内信息密度最高的补充句。
 * - 输出严格遵循 D-029 三段式（【发生了什么】/【原话】/【不懂的】），
 *   既可直接嵌入 `vec_scene` 做整场语义召回，又可供时间轴提取一句话目录标题。
 *
 * @param {Array<Record<string, any>>} msgs 场景内消息（按时间升序）
 * @param {{vectors?: Map<number, Float32Array>|Function|null}} [opts]
 * @returns {string|null}
 */
export function buildExtractiveGist(msgs, opts = {}) {
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const vectors = opts.vectors ?? null;

  const getVec = (m) => {
    if (!vectors || m?.id === undefined || m?.id === null) return null;
    const raw = typeof vectors === 'function'
      ? vectors(m.id)
      : (typeof vectors.get === 'function' ? vectors.get(Number(m.id)) ?? vectors.get(m.id) : null);
    return unitVec(raw);
  };

  // 构建候选句列表
  const cands = msgs.map((m, idx) => {
    const cleaned = cleanForGist(m?.text);
    const len = [...cleaned].length;
    const isFiller = !cleaned || cleaned === '[代码]' || (len <= 6 && FILLER_RE.test(cleaned));
    return {
      idx,
      msg: m,
      speaker: m?.speaker === 'user' ? 'user' : 'assistant',
      cleaned,
      len,
      isFiller,
      vec: getVec(m),
    };
  });

  const substantive = cands.filter((c) => !c.isFiller);
  const pool = substantive.length > 0 ? substantive : cands.filter((c) => c.cleaned.length > 0);
  if (pool.length === 0) return null;

  // 若存在向量，算整场质心并做 MMR 抽取
  const vecPool = pool.filter((c) => c.vec !== null);
  let primary = null;
  let secondary = null;

  if (vecPool.length >= 2) {
    const dim = vecPool[0].vec.length;
    const centroid = new Float64Array(dim);
    for (const c of vecPool) {
      if (c.vec.length !== dim) continue;
      for (let d = 0; d < dim; d++) centroid[d] += c.vec[d];
    }
    const unitCentroid = unitVec(centroid);
    if (unitCentroid) {
      const scored = vecPool.map((c) => {
        const sim = cosineDot(c.vec, unitCentroid);
        // 偏好 8~120 字实质句与 user 发起句（避免纯 2 字或超长复制日志占榜）
        const lenBonus = c.len >= 8 && c.len <= 120 ? 0.06 : (c.len > 120 ? 0.02 : -0.04);
        const userBonus = c.speaker === 'user' ? 0.07 : 0;
        const earlyBonus = c.idx < Math.max(3, msgs.length * 0.25) ? 0.03 : 0;
        return { c, score: sim + lenBonus + userBonus + earlyBonus, sim };
      });
      scored.sort((a, b) => b.score - a.score);
      primary = scored[0].c;

      // MMR 挑第二句：既贴近质心，又与第一句有足够差异（sim < 0.85）
      let bestSecond = null;
      let bestMmr = -Infinity;
      for (const item of scored.slice(1)) {
        const dup = cosineDot(item.c.vec, primary.vec);
        if (dup >= 0.85) continue;
        const mmr = 0.7 * item.score - 0.3 * dup;
        if (mmr > bestMmr) {
          bestMmr = mmr;
          bestSecond = item.c;
        }
      }
      secondary = bestSecond;
    }
  }

  // 无向量时的纯规则抽取：首条实质 user 句 + 信息密度最高的互补句
  if (!primary) {
    primary = pool.find((c) => c.speaker === 'user' && c.len >= 6)
      ?? pool.find((c) => c.speaker === 'user')
      ?? pool[0];
  }
  if (!secondary && pool.length > 1) {
    const rest = pool.filter((c) => c.idx !== primary.idx && c.cleaned !== primary.cleaned);
    if (rest.length > 0) {
      rest.sort((a, b) => {
        const scoreOf = (x) => Math.min(x.len, 80) + (x.speaker !== primary.speaker ? 15 : 0) + (x.idx > primary.idx ? 10 : 0);
        return scoreOf(b) - scoreOf(a);
      });
      secondary = rest[0];
    }
  }

  const headline = clipClause(primary.cleaned, 30);
  const q1 = clipClause(primary.cleaned, 24).replace(/[「」"“”]/g, '');
  const q2 = secondary ? clipClause(secondary.cleaned, 24).replace(/[「」"“”]/g, '') : '';
  const quoteBody = q2 && q2 !== q1 ? `「${q1}」；「${q2}」` : `「${q1}」`;

  return [
    `${GIST_LABELS.what}${headline}`,
    `${GIST_LABELS.quote}${quoteBody}`,
    `${GIST_LABELS.unknown}${EMPTY_UNKNOWN}`,
  ].join('\n');
}

/**
 * 从三段式（或任意格式）gist 中提取适合时间轴展示的一句话目录标题。
 * @param {string|null|undefined} gist
 * @param {number} [maxChars]
 * @returns {string|null}
 */
export function gistHeadline(gist, maxChars = 36) {
  if (typeof gist !== 'string' || !gist.trim()) return null;
  const firstLine = gist.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const cleaned = firstLine
    .replace(/^【发生了什么】\s*/, '')
    .replace(/^【原话】\s*/, '')
    .trim();
  if (!cleaned) return null;
  if ([...cleaned].length <= maxChars) return cleaned;
  return `${truncateChars(cleaned, Math.max(1, maxChars - 1))}…`;
}
