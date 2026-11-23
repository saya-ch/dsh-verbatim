// split.js —— 场景切分（M2）：把导出后的消息切成「那一场聊天」。
//
// 规格来源：IMPLEMENTATION.md §6（口径冲突时以它为准）
//   §6.1 方案 C（D-026）：满足任一即切
//     ① 相邻消息间隔 > 30 分钟
//     ② 当前场景已达 40 条（D-028）
//     ③ 跨过压缩点（compacted_at 由空变非空，或反向）
//   §6.1 防断裂（D-037）：即使满足上面，也强制并入前一场
//     ① 间隔 ≤ 2 分钟的连续回应
//     ② 沉默 > 30 分钟后，首条 < 10 字且不含话题引入词
//
// 三条容易被写错的地方，这里都按字面实现并留了开关：
//   1. 伪代码里 forceJoin **优先于** hardCut，也就是说「40 条上限」会被
//      「2 分钟内连续回应」否决——连聊 200 句就真的是一场 200 条的场景。
//     本文件默认照伪代码来（forceJoinOverridesMax = true），但把这件事
//     统计出来（stats.overridden.size），上层想改成硬上限就把开关关掉。
//   2. 「跨压缩点」本来是要切的，但它同样会被 2 分钟连续回应否决，
//      所以真实数据里**会有场景横跨压缩点**。这不是 bug，是规则优先级的结果，
//      用 scene.crossesCompaction 标出来给上层看。
//   3. 「含新专名」需要「知道之前聊过什么」才能判「新」，纯函数拿不到历史，
//      所以降级为「含专名标记」（书名号/引号内文本、年份、含大写的拉丁词）。
//      这条启发式只在「沉默 > 30 分钟且首条 < 10 字」时才被查询，影响面很小，
//      实际触发次数也统计在 stats.topicIntroBlocked.proper 里。
//
// 纯函数：不读数据库、不写文件、不修改入参；输入输出都是普通对象。
//
// 入参兼容两种字段名（T2 导出用 snake_case，T1 的 MsgRow 用 camelCase）：
//   compacted_at / compactedAt、in_surface / inSurface、excluded

/** 硬切：相邻消息间隔超过 30 分钟 */
export const GAP_CUT_MS = 30 * 60_000;

/** 防断裂：间隔 ≤ 2 分钟的连续回应强制同场 */
export const GAP_JOIN_MS = 2 * 60_000;

/** 防断裂封顶：沉默超过 2 小时后，短句不再并入前一场（保住跨 24 点热聊，挡住隔夜粘连） */
export const GAP_SILENCE_MAX_MS = 2 * 60 * 60_000;

/** 软切：单场消息数软上限（可被 2 分钟热聊短时顺延） */
export const MAX_SCENE_MSGS = 80;

/** 软切：单场总字数软上限（兼顾任务型长对话，陪伴短聊不受影响） */
export const MAX_SCENE_CHARS = 8_000;

/** 绝对硬上限：任何热聊都不能否决（防止滚出巨场） */
export const HARD_MAX_SCENE_MSGS = 150;
export const HARD_MAX_SCENE_CHARS = 15_000;

/** 语义精修（TextTiling）默认参数 */
export const SEMANTIC_MIN_MSGS = 40;
export const SEMANTIC_MIN_CHARS = 4_500;
export const SEMANTIC_MIN_SEGMENT = 12;
export const SEMANTIC_WINDOW = 4;
export const SEMANTIC_DEPTH_THRESHOLD = 0.20;
export const SEMANTIC_MAX_SIM = 0.72;

/** 碎片吸收：连续对话中 1~2 条孤儿场的最大合并间隔 */
export const ORPHAN_MAX_MSGS = 2;
export const ORPHAN_MERGE_GAP_MS = 15 * 60_000;

/** 防断裂：沉默后的「极短回复」字数阈值（严格小于） */
export const SHORT_REPLY_CHARS = 10;

/**
 * 话题引入词（IMPLEMENTATION.md §6.1 ② 列的 4 个）。
 * 注意「还记得 / 上次 / 那天」这类**指代词不在此列**：它们指向过去，是延续信号
 * 而不是话题引入信号（D-102），放进来会把本该并入的场景切碎。
 */
export const TOPIC_INTRO_WORDS = Object.freeze(['你知道', '那个', '说起来', '对了']);

/** 问号收尾（含全角） */
const QUESTION_TAIL = /[?？]\s*$/u;

/**
 * 「含专名」启发式——纯函数版的「含新专名」。
 * 认得三种标记：书名号/引号内文本、年份/日期、**含大写字母**的拉丁词。
 *
 * 为什么拉丁词要求含大写：中文闲聊里「ok / hhh / emmm」这种小写拉丁词极常见，
 * 它们不是专名。把它们算成专名会让「沉默后的短句」几乎永远不并入前一场，
 * 防断裂规则就废了。所以这里只认 Ok / OK / LeetCode 这种带大写的写法。
 */
const PROPER_NOUN_MARK = /[《「『“"][^》」』”"\n]{1,20}[》」』”"]|(?:19|20)\d{2}(?:[-/年])?\d{0,2}/u;

/** 拉丁词（≥2 字符），由调用方再判里面有没有大写字母 */
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9]+/g;

/* ============================ 小工具 ============================ */

/** 取第一个非 undefined 的字段（兼容 snake_case / camelCase） */
function pick(obj, ...names) {
  for (const n of names) {
    const v = obj?.[n];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** 消息的时刻（epoch ms）。必须有，没有就是入参坏了。 */
function atOf(m) {
  const at = m?.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new TypeError(`splitScenes: 消息缺少有效的 at（epoch ms），seq=${m?.seq}`);
  }
  return at;
}

/** 消息的 seq；缺失时退回 -1（只用于同刻排序，不参与业务判断） */
function seqOf(m) {
  const s = m?.seq;
  return typeof s === 'number' && Number.isFinite(s) ? s : -1;
}

/** 被压缩的时刻；没被压过返回 null（布尔化就是「是否已压缩」） */
function compactedAtOf(m) {
  const v = pick(m, 'compacted_at', 'compactedAt');
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 是否被软排除（D-169/170）。排除的消息照样参与切分，只是打个标记。 */
function isExcluded(m) {
  const v = pick(m, 'excluded');
  return v === 1 || v === true;
}

/**
 * 是否已掉出上下文（in_surface=0）。
 * T2 的导出里 in_surface 与 compacted_at 是同一件事的两种写法（有压缩就有 in_surface=0），
 * 所以字段缺失时按 compacted_at 兜底，避免上游少传一个字段就把标记全丢掉。
 */
function isOutOfSurface(m) {
  const v = pick(m, 'in_surface', 'inSurface');
  if (v === undefined || v === null) return compactedAtOf(m) !== null;
  return v === 0 || v === false;
}

/** 消息正文（缺失当空串） */
function textOf(m) {
  return typeof m?.text === 'string' ? m.text : '';
}

/** 会话 id（没有就 null；用于「绝不跨会话合并」的保护） */
function sessionOf(m) {
  const v = pick(m, 'session_id', 'sessionId');
  return typeof v === 'string' && v ? v : null;
}

/** 实际内容长度（不算首尾空白；纯空白消息等于 0 字） */
function contentLength(text) {
  return text.trim().length;
}

/**
 * 这条消息是不是在「引入话题」——是的话，沉默后的短句就不该并进前一场。
 *
 * 判定优先级：话题引入词 → 问号收尾 → 含专名标记。
 *
 * @param {string} text
 * @returns {{intro: boolean, via: 'word'|'question'|'proper'|null, matched?: string}}
 */
export function introducesTopic(text) {
  const t = typeof text === 'string' ? text : '';
  for (const w of TOPIC_INTRO_WORDS) {
    if (t.includes(w)) return { intro: true, via: 'word', matched: w };
  }
  if (QUESTION_TAIL.test(t)) return { intro: true, via: 'question' };

  const mark = PROPER_NOUN_MARK.exec(t);
  if (mark) return { intro: true, via: 'proper', matched: mark[0] };

  // 拉丁词里必须真有**大写字母**才算专名（「ok」不算，「OK」「LeetCode」算）
  for (const tok of t.match(LATIN_TOKEN) ?? []) {
    if (tok !== tok.toLowerCase()) return { intro: true, via: 'proper', matched: tok };
  }

  return { intro: false, via: null };
}

/**
 * 排序 + 校验：按时刻升序，同一时刻按 seq 升序（保证切分结果可复现）。
 * 只复制数组，不复制消息对象——场景里的 msgs 仍是调用方传进来的那些对象。
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
export function sortMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new TypeError('splitScenes: 入参必须是消息数组');
  }
  const copy = messages.slice();
  for (const m of copy) atOf(m); // 先全量校验，避免排到一半才炸
  copy.sort((a, b) => atOf(a) - atOf(b) || seqOf(a) - seqOf(b));
  return copy;
}

/* ============================ 场景派生字段 ============================ */

/**
 * 由一组消息造一个场景对象。
 *
 * 除了 IMPLEMENTATION.md §6.2 要求的 `msgs / start_at / end_at / msg_count`，
 * 这里额外派生几个纯标记给上层用（都是事实，不含任何解读，D-100）：
 *   - hasExcluded         该场是否含被软排除的消息（D-169/170，检索时不过滤它，
 *                         但要能告诉上层「这场里有被排除的内容」）
 *   - excludedCount       被排除的条数
 *   - hasOutOfSurface     该场是否含 in_surface=0 的消息（已被压缩掉的）
 *   - outOfSurfaceCount   同上，条数
 *   - crossesCompaction   该场是否横跨压缩点（既有压缩过的、也有没压缩的）——
 *                         正常应该为 false；为 true 说明「跨压缩点该切」这条
 *                         规则被「2 分钟连续回应」否决了，属预期行为，如实记录
 *   - seqFrom / seqTo     本场最小 / 最大 seq（T1 的 sceneAssign.assignSeqRange 用）
 *
 * @param {object[]} msgs 已按时间升序
 * @returns {object}
 */
function makeScene(msgs) {
  let excludedCount = 0;
  let outOfSurfaceCount = 0;
  let compactedCount = 0;
  let seqFrom = Infinity;
  let seqTo = -Infinity;

  for (const m of msgs) {
    if (isExcluded(m)) excludedCount++;
    if (isOutOfSurface(m)) outOfSurfaceCount++;
    if (compactedAtOf(m) !== null) compactedCount++;
    const s = seqOf(m);
    if (s >= 0) {
      if (s < seqFrom) seqFrom = s;
      if (s > seqTo) seqTo = s;
    }
  }

  const has = seqFrom !== Infinity;

  return {
    msgs,
    start_at: atOf(msgs[0]),
    end_at: atOf(msgs[msgs.length - 1]),
    msg_count: msgs.length,
    // 压缩点
    crossesCompaction: compactedCount > 0 && compactedCount < msgs.length,
    compactedCount,
    // 软排除（D-169/170）
    hasExcluded: excludedCount > 0,
    excludedCount,
    // 已掉出上下文（in_surface=0）
    hasOutOfSurface: outOfSurfaceCount > 0,
    outOfSurfaceCount,
    // seq 区间（回填 msg.scene_id 用）
    seqFrom: has ? seqFrom : null,
    seqTo: has ? seqTo : null,
  };
}

/** 发言方（用于轮次边界对齐，尽量不把「用户问 → 助手答」拆成两场） */
function speakerOf(m) {
  const s = m?.speaker;
  return typeof s === 'string' ? s : '';
}

/** 从 vectors（Map 或函数）取单条消息的向量 */
function vectorOf(vectors, m) {
  if (!vectors || !m) return null;
  const id = m.id;
  if (id === undefined || id === null) return null;
  const v = typeof vectors === 'function'
    ? vectors(id)
    : (typeof vectors.get === 'function' ? vectors.get(Number(id)) ?? vectors.get(id) : null);
  return v && v.length > 0 ? v : null;
}

/** 计算窗口内向量的归一化均值；缺向量时返回 null */
function meanUnitVector(msgs, start, end, vectors) {
  let sum = null;
  let count = 0;
  for (let i = start; i < end; i++) {
    const v = vectorOf(vectors, msgs[i]);
    if (!v) continue;
    if (!sum) sum = new Float64Array(v.length);
    if (v.length !== sum.length) continue;
    for (let d = 0; d < v.length; d++) sum[d] += v[d];
    count += 1;
  }
  if (!sum || count === 0) return null;
  let norm = 0;
  for (let d = 0; d < sum.length; d++) norm += sum[d] * sum[d];
  norm = Math.sqrt(norm);
  if (norm <= 1e-12) return null;
  for (let d = 0; d < sum.length; d++) sum[d] /= norm;
  return sum;
}

function dot(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 阶段 B：复用已有消息向量的 TextTiling 局部谷底精修（零 LLM 成本）。
 * 对超过软阈值的长连续段，在 user 发言候选点计算前后窗口余弦相似度，
 * 找出语义深谷（depth score >= 阈值且相似度 <= maxSim）切分真正的话题切换。
 */
export function refineGroupByVectors(group, vectors, opts = {}) {
  if (!vectors || !Array.isArray(group) || group.length < (opts.semanticMinMsgs ?? SEMANTIC_MIN_MSGS)) {
    const totalChars = Array.isArray(group)
      ? group.reduce((s, m) => s + contentLength(textOf(m)), 0)
      : 0;
    if (!vectors || !Array.isArray(group) || totalChars < (opts.semanticMinChars ?? SEMANTIC_MIN_CHARS)) {
      return { groups: [group], cuts: 0 };
    }
  }

  const minSeg = Math.max(3, opts.semanticMinSegment ?? SEMANTIC_MIN_SEGMENT);
  if (group.length < minSeg * 2) return { groups: [group], cuts: 0 };

  const win = Math.max(2, opts.semanticWindow ?? SEMANTIC_WINDOW);
  const depthThreshold = opts.semanticDepthThreshold ?? SEMANTIC_DEPTH_THRESHOLD;
  const maxSim = opts.semanticMaxSim ?? SEMANTIC_MAX_SIM;

  const hasSpeakers = group.some((m) => speakerOf(m) === 'user') && group.some((m) => speakerOf(m) === 'assistant');

  // ① 在合法候选点计算前后窗口余弦相似度
  const points = [];
  for (let k = minSeg; k <= group.length - minSeg; k++) {
    // 有明确双边角色时优先在 user 新起一轮处切，保住问答对完整
    if (hasSpeakers && speakerOf(group[k]) !== 'user') continue;
    const vL = meanUnitVector(group, Math.max(0, k - win), k, vectors);
    const vR = meanUnitVector(group, k, Math.min(group.length, k + win), vectors);
    const sim = dot(vL, vR);
    if (sim === null) continue;
    points.push({ k, sim });
  }
  if (points.length < 3) return { groups: [group], cuts: 0 };

  // ② 计算每个候选点的 TextTiling 局部谷深（depth score）
  const candidates = [];
  for (let i = 0; i < points.length; i++) {
    const curSim = points[i].sim;
    let leftPeak = curSim;
    for (let j = i - 1; j >= 0; j--) {
      if (points[j].sim >= leftPeak) leftPeak = points[j].sim;
      else break;
    }
    let rightPeak = curSim;
    for (let j = i + 1; j < points.length; j++) {
      if (points[j].sim >= rightPeak) rightPeak = points[j].sim;
      else break;
    }
    const depth = ((leftPeak - curSim) + (rightPeak - curSim)) / 2;
    if (depth >= depthThreshold && curSim <= maxSim) {
      candidates.push({ k: points[i].k, sim: curSim, depth });
    }
  }
  if (candidates.length === 0) return { groups: [group], cuts: 0 };

  // ③ 按谷深从大到小贪心选切点，保证每段至少 minSeg 条
  candidates.sort((a, b) => b.depth - a.depth);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.every((x) => Math.abs(x - c.k) >= minSeg)) {
      chosen.push(c.k);
    }
  }
  if (chosen.length === 0) return { groups: [group], cuts: 0 };

  chosen.sort((a, b) => a - b);
  const out = [];
  let start = 0;
  for (const cut of chosen) {
    out.push(group.slice(start, cut));
    start = cut;
  }
  out.push(group.slice(start));
  return { groups: out, cuts: chosen.length };
}

/**
 * 后处理：吸收连续对话中的 1~2 条碎片场（不跨会话、不跨压缩点、不跨 >15m 沉默）。
 */
function absorbOrphanGroups(groups, opts = {}) {
  if (groups.length < 3) return { groups, absorbed: 0 };
  const maxOrphan = opts.orphanMaxMsgs ?? ORPHAN_MAX_MSGS;
  const maxGap = opts.orphanMergeGapMs ?? ORPHAN_MERGE_GAP_MS;
  const hardMaxMsgs = opts.hardMaxMsgs ?? HARD_MAX_SCENE_MSGS;
  const hardMaxChars = opts.hardMaxChars ?? HARD_MAX_SCENE_CHARS;

  const charsOf = (g) => g.reduce((s, m) => s + contentLength(textOf(m)), 0);
  const canMerge = (a, b) => {
    const tail = a[a.length - 1];
    const head = b[0];
    if (sessionOf(tail) !== sessionOf(head) && sessionOf(tail) !== null && sessionOf(head) !== null) return false;
    if ((compactedAtOf(tail) !== null) !== (compactedAtOf(head) !== null)) return false;
    const gap = atOf(head) - atOf(tail);
    if (gap > maxGap) return false;
    if (a.length + b.length > hardMaxMsgs) return false;
    if (hardMaxChars > 0 && charsOf(a) + charsOf(b) > hardMaxChars) return false;
    return true;
  };

  const out = groups.map((g) => g.slice());
  let absorbed = 0;
  let i = 0;
  while (i < out.length) {
    if (out[i].length > maxOrphan || out.length <= 1) {
      i += 1;
      continue;
    }
    const prevOk = i > 0 && canMerge(out[i - 1], out[i]);
    const nextOk = i + 1 < out.length && canMerge(out[i], out[i + 1]);
    if (!prevOk && !nextOk) {
      i += 1;
      continue;
    }
    const prevGap = prevOk ? atOf(out[i][0]) - atOf(out[i - 1][out[i - 1].length - 1]) : Infinity;
    const nextGap = nextOk ? atOf(out[i + 1][0]) - atOf(out[i][out[i].length - 1]) : Infinity;
    if (prevGap <= nextGap) {
      out[i - 1].push(...out[i]);
      out.splice(i, 1);
      absorbed += 1;
    } else {
      out[i + 1].unshift(...out[i]);
      out.splice(i, 1);
      absorbed += 1;
    }
  }
  return { groups: out, absorbed };
}

/* ============================ 切分主函数 ============================ */

/**
 * 切分场景（带统计）。
 *
 * 两阶段切分：
 *   - 阶段 A（快规则，无向量时独立工作）：
 *       30 分钟沉默 / 40 条或 4000 字软上限 / 100 条或 8000 字硬上限 / 压缩点翻转 / 会话边界
 *       防断裂：2 分钟热聊顺延软上限（不突破硬上限）；30m~2h 沉默后极短无引入词归前场
 *       轮次对齐：字数/硬上限切分尽量落在 user 发言之前，避免劈开问答对
 *   - 阶段 B（可选语义精修）：传入 `opts.vectors` 时，对长段运行零 LLM 成本的 TextTiling
 *   - 后处理：吸收连续对话中的 1~2 条碎片场（不跨会话/压缩点/长沉默）
 *
 * @param {object[]} messages 消息数组，顺序无所谓（内部会按时间排）
 * @param {{
 *   gapCutMs?: number,              // 默认 30 分钟
 *   gapJoinMs?: number,             // 默认 2 分钟
 *   gapSilenceMaxMs?: number,       // 默认 2 小时（短句并入的最大沉默封顶）
 *   maxMsgs?: number,               // 默认 40（软上限）
 *   maxChars?: number,              // 默认 4000（软字数上限，0 = 关闭）
 *   hardMaxMsgs?: number,           // 默认 100（绝对条数硬上限）
 *   hardMaxChars?: number,          // 默认 8000（绝对字数硬上限，0 = 关闭）
 *   shortReplyChars?: number,       // 默认 10
 *   forceJoinOverridesMax?: boolean,// 默认 true
 *   alignUserTurn?: boolean,        // 默认 true：字数/硬上限优先在 user 发言处切
 *   absorbOrphans?: boolean,        // 默认 true（仅对 >=3 场的连续对话生效）
 *   vectors?: Map<number, Float32Array>|Function|null, // 可选：启用阶段 B 语义精修
 * }} [opts]
 * @returns {{ scenes: object[], stats: object }}
 */
export function splitScenesWithStats(messages, opts = {}) {
  const gapCutMs = opts.gapCutMs ?? GAP_CUT_MS;
  const gapJoinMs = opts.gapJoinMs ?? GAP_JOIN_MS;
  const gapSilenceMaxMs = opts.gapSilenceMaxMs ?? GAP_SILENCE_MAX_MS;
  const maxMsgs = opts.maxMsgs ?? MAX_SCENE_MSGS;
  const maxChars = opts.maxChars ?? MAX_SCENE_CHARS;
  const hardMaxMsgs = opts.hardMaxMsgs ?? HARD_MAX_SCENE_MSGS;
  const hardMaxChars = opts.hardMaxChars ?? HARD_MAX_SCENE_CHARS;
  const shortReplyChars = opts.shortReplyChars ?? SHORT_REPLY_CHARS;
  const forceJoinOverridesMax = opts.forceJoinOverridesMax !== false;
  const alignUserTurn = opts.alignUserTurn !== false;
  const absorbOrphans = opts.absorbOrphans !== false;
  const vectors = opts.vectors ?? null;

  const list = sortMessages(messages);

  const stats = {
    // 输入输出
    inputMessages: list.length,
    outputScenes: 0,
    // 实际用的阈值（回放 / 复现实验时能对上）
    gapCutMs,
    gapJoinMs,
    gapSilenceMaxMs,
    maxMsgs,
    maxChars,
    hardMaxMsgs,
    hardMaxChars,
    shortReplyChars,
    forceJoinOverridesMax,
    // 硬切：按原因分别计数
    cutByGap: 0,
    cutBySize: 0,
    cutByChars: 0,
    cutByHardCap: 0,
    cutByCompaction: 0,
    cutBySession: 0,
    cutBySemantic: 0,
    orphansAbsorbed: 0,
    // 防断裂生效次数（= 本该切、因为防断裂没切）
    forcedJoinQuickReply: 0,
    forcedJoinShortAfterSilence: 0,
    // 被防断裂否决掉的硬切原因分布（看清「谁被谁压住」）
    overridden: { gap: 0, size: 0, chars: 0, compaction: 0 },
    // 话题引入词阻止了「沉默后短句归前一场」的次数（按命中方式）
    topicIntroBlocked: { word: 0, question: 0, proper: 0 },
    // 检测到的压缩状态翻转次数（切 + 没切）
    compactionFlips: 0,
  };

  if (list.length === 0) return { scenes: [], stats };

  /** @type {object[][]} */
  let groups = [];
  /** @type {object[]} */
  let cur = [list[0]];
  let curChars = contentLength(textOf(list[0]));

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const m = list[i];
    const gap = atOf(m) - atOf(prev);
    const mChars = contentLength(textOf(m));

    // ── 切分条件 ──────────────────────────────────────────────
    const sessionChanged = sessionOf(prev) !== sessionOf(m) && sessionOf(prev) !== null && sessionOf(m) !== null;
    const gapCut = gap > gapCutMs;
    const sizeCut = cur.length >= maxMsgs;
    const charCut = maxChars > 0 && curChars >= maxChars;
    const hardCap = cur.length >= hardMaxMsgs || (hardMaxChars > 0 && curChars >= hardMaxChars);
    const compactedFlip = (compactedAtOf(prev) !== null) !== (compactedAtOf(m) !== null);
    if (compactedFlip) stats.compactionFlips++;

    // ── 防断裂条件 ────────────────────────────────────────────
    const quickReply = gap <= gapJoinMs;
    let shortAfterSilence = false;
    let intro = null;
    if (!quickReply && gap > gapCutMs && gap <= gapSilenceMaxMs && mChars < shortReplyChars) {
      intro = introducesTopic(textOf(m));
      shortAfterSilence = !intro.intro;
      // 命中了话题引入词 → 不并入，照切
      if (intro.intro) stats.topicIntroBlocked[intro.via]++;
    }

    // 哪些切分原因成立
    const reasons = [];
    if (sessionChanged) reasons.push('session');
    if (gapCut) reasons.push('gap');
    if (compactedFlip) reasons.push('compaction');
    if (hardCap) reasons.push('hardCap');
    if (sizeCut) reasons.push('size');
    if (charCut) reasons.push('chars');

    // 防断裂能不能否决这次切？
    //   会话边界与二级硬上限永不被否决；40 条软上限是否可被否决由 forceJoinOverridesMax 决定
    const joinReasons = [];
    if (quickReply) joinReasons.push('quickReply');
    if (shortAfterSilence) joinReasons.push('shortAfterSilence');

    const sizeLocked = reasons.includes('size') && !forceJoinOverridesMax;
    const canJoin = joinReasons.length > 0 && !sessionChanged && !sizeLocked && !hardCap;

    // 轮次边界对齐：仅因字数或硬上限切分时，如果刚好落在 user→assistant 之间，多留 1 条保住问答对
    const deferForQaPair = alignUserTurn
      && !sessionChanged
      && !gapCut
      && !compactedFlip
      && !sizeCut
      && (charCut || hardCap)
      && speakerOf(prev) === 'user'
      && speakerOf(m) === 'assistant'
      && cur.length <= hardMaxMsgs;

    if (reasons.length > 0 && !canJoin && !deferForQaPair) {
      // 真切
      groups.push(cur);
      cur = [m];
      curChars = mChars;
      // 记录切因（优先级：会话 > 压缩 > 间隔 > 硬上限 > 条数 > 字数）
      if (sessionChanged) stats.cutBySession++;
      else if (compactedFlip) stats.cutByCompaction++;
      else if (gapCut) stats.cutByGap++;
      else if (hardCap) stats.cutByHardCap++;
      else if (sizeCut) stats.cutBySize++;
      else if (charCut) stats.cutByChars++;
    } else {
      // 并入前一场
      if (reasons.length > 0 && canJoin) {
        if (joinReasons.includes('quickReply')) stats.forcedJoinQuickReply++;
        if (joinReasons.includes('shortAfterSilence')) stats.forcedJoinShortAfterSilence++;
        for (const r of reasons) {
          if (r in stats.overridden) stats.overridden[r]++;
        }
      }
      cur.push(m);
      curChars += mChars;
    }
  }
  groups.push(cur);

  // ── 阶段 B：可选语义精修（复用已有向量，零 LLM 成本） ──────────────
  if (vectors) {
    const refined = [];
    for (const g of groups) {
      const r = refineGroupByVectors(g, vectors, opts);
      refined.push(...r.groups);
      stats.cutBySemantic += r.cuts;
    }
    groups = refined;
  }

  // ── 后处理：吸收连续对话中的 1~2 条碎片场 ────────────────────────
  if (absorbOrphans && groups.length >= 3) {
    const merged = absorbOrphanGroups(groups, opts);
    groups = merged.groups;
    stats.orphansAbsorbed = merged.absorbed;
  }

  const scenes = groups.map((g) => makeScene(g));
  stats.outputScenes = scenes.length;
  return { scenes, stats };
}

/**
 * 切分场景（只要结果）。等价于 `splitScenesWithStats(messages, opts).scenes`。
 *
 * @param {object[]} messages
 * @param {object} [opts] 见 splitScenesWithStats
 * @returns {object[]} `{ msgs, start_at, end_at, msg_count, ...派生标记 }[]`
 */
export function splitScenes(messages, opts = {}) {
  return splitScenesWithStats(messages, opts).scenes;
}

/* ============================ 分布统计 ============================ */

/**
 * 给一组数字算 min / median / max（以及均值），用于验收打印。
 * 空数组返回全 null。
 *
 * @param {number[]} values
 * @returns {{count:number, min:number|null, median:number|null, max:number|null, mean:number|null}}
 */
export function describe(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return { count: 0, min: null, median: null, max: null, mean: null };
  const mid = xs.length >> 1;
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  const sum = xs.reduce((a, b) => a + b, 0);
  return { count: xs.length, min: xs[0], median, max: xs[xs.length - 1], mean: sum / xs.length };
}

/**
 * 场景集合的整体分布（时长 / 条数 / 跨压缩点 / 含排除）。
 * 纯统计，不做任何解读。
 *
 * @param {object[]} scenes splitScenes 的返回值（带或不带邻接回填都行）
 * @returns {object}
 */
export function sceneStats(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const durations = list.map((s) => s.end_at - s.start_at);
  const counts = list.map((s) => s.msg_count ?? s.msgs?.length ?? 0);
  return {
    scenes: list.length,
    messages: counts.reduce((a, b) => a + b, 0),
    durationMs: describe(durations),
    msgCount: describe(counts),
    crossesCompaction: list.filter((s) => s.crossesCompaction).length,
    withExcluded: list.filter((s) => s.hasExcluded).length,
    withOutOfSurface: list.filter((s) => s.hasOutOfSurface).length,
    // 超过 40 条的场次：说明「40 条上限」被「2 分钟连续回应」否决了
    overMaxMsgs: list.filter((s) => (s.msg_count ?? s.msgs?.length ?? 0) > MAX_SCENE_MSGS).length,
  };
}
