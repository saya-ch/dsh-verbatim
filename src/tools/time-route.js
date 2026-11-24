/**
 * time-route —— 时间路（memory_search 按时间翻对话的共享实现）
 *
 * 为什么单独一个文件：按时间翻对话（传标准化的 when，或留空看最近一次聊天）
 * 与关键词/语义检索共用同一套时间窗解析与渲染逻辑，保持行为一致。
 *
 * 用途：按时间把那一场场对话展开，包括已经被压缩掉、不在TA眼前的那些
 * （那些才是记忆库最值钱的部分，D-141）。
 *
 * 三条铁律：
 * ① 返回**纯文本**，不返回 JSON（BUILD-PLAN §3.4 的 ToolDef.handler）。
 * ② 只返回**原文**：不返回 gist、不写摘要、不做任何关系判断（D-035 / D-090 / D-101）。
 * ③ 不写 SQL：一切走 repo / extras（BUILD-PLAN §3.1）。
 *
 * 场景层的 excluded 语义（D-169/170，T1 接口）：scene 没有 excluded 概念，
 * 被整段排除的日子照样会切出场景，但 `msgsByScene(id)` 返回 [] ——
 * 所以**空场景必须跳过**，不然会输出「0 轮」的鬼场次。
 */

import {
  DAY_MS,
  MARK_COMPACTED,
  MARK_EXCLUDED_ONE,
  TZ_OFFSET_MS,
  buildMediaAnnotator,
  clipText,
  dayShift,
  emptyText,
  fmtCount,
  fmtDate,
  fmtLongDate,
  fmtSpan,
  leadInHeader,
  libraryLine,
  parseLeadIn,
  quoteLine,
  resolveTzOffsetMs,
  sceneHeader,
  shanghaiParts,
  startOfDay,
} from './format.js';
import { sessionStats } from './scope.js';

/** 单次时间窗最多取多少场（够用且不慢：scene 行很小） */
const FETCH_LIMIT = 500;

/** limit 的上下限：工具参数由模型给，必须夹住 */
const MIN_LIMIT = 1;
const MAX_LIMIT = 12;

/* ================================ 标准化时间解析 ================================ */

/**
 * 按「上海本地」年月日拼出当天 00:00 的 epoch ms。
 * **不能用 `new Date('2026-11-09')`**：JS 会把纯日期按 UTC 解释，差 8 小时（D-172）。
 *
 * @param {number} y
 * @param {number} mo
 * @param {number} d
 * @returns {number|null} 日期不存在时返回 null（比如 2 月 30 日）
 */
function makeDay(y, mo, d, tzOffsetMs) {
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const utcMidnight = Date.UTC(y, mo - 1, d);
  const probe = new Date(utcMidnight);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null; // 溢出了：02-30 之类
  }
  return utcMidnight - resolveTzOffsetMs(tzOffsetMs);
}

/**
 * 解析带时刻的 ISO 字符串（`YYYY-MM-DDTHH:mm...` / `YYYY-MM-DD HH:mm...`）。
 * 无时区后缀时默认按配置的时区偏移（默认上海时间 +08:00）解释，不依赖机器本地时区。
 *
 * @param {string} text
 * @param {number} [tzOffsetMs]
 * @returns {number|null}
 */
function parseIsoWithTime(text, tzOffsetMs) {
  const iso =
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      text,
    );
  if (!iso) return null;
  const y = Number(iso[1]);
  const mo = Number(iso[2]);
  const d = Number(iso[3]);
  const h = Number(iso[4]);
  const mi = Number(iso[5]);
  const s = iso[6] !== undefined ? Number(iso[6]) : 0;
  const ms = iso[7] !== undefined ? Number(iso[7].padEnd(3, '0').slice(0, 3)) : 0;
  if (makeDay(y, mo, d, tzOffsetMs) === null) return null;
  if (h > 23 || mi > 59 || s > 59) return null;

  let offsetMs = resolveTzOffsetMs(tzOffsetMs);
  if (iso[8]) {
    const tz = iso[8].toUpperCase();
    if (tz === 'Z') {
      offsetMs = 0;
    } else {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.slice(1).replace(':', '');
      const tzH = Number(digits.slice(0, 2));
      const tzM = Number(digits.slice(2, 4));
      if (tzH > 23 || tzM > 59) return null;
      offsetMs = sign * (tzH * 60 + tzM) * 60_000;
    }
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMs;
}

/**
 * 解析纯日期：`YYYY-MM-DD` / `YYYY/MM/DD` / `MM-DD` / `MM/DD`。
 * `MM-DD` / `MM/DD` 落在未来时回退一年。
 *
 * @param {string} text
 * @param {number} nowTs
 * @param {number} [tzOffsetMs]
 * @returns {{day: number, hasYear: boolean}|null}
 */
function parsePureDate(text, nowTs, tzOffsetMs) {
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (m) {
    const day = makeDay(Number(m[1]), Number(m[2]), Number(m[3]), tzOffsetMs);
    return day !== null ? { day, hasYear: true } : null;
  }

  m = /^(\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const year = shanghaiParts(nowTs, tzOffsetMs).y;
    let day = makeDay(year, mo, d, tzOffsetMs);
    if (day !== null && day > startOfDay(nowTs, tzOffsetMs)) day = makeDay(year - 1, mo, d, tzOffsetMs);
    return day !== null ? { day, hasYear: false } : null;
  }

  return null;
}

/**
 * 解析单月：`YYYY-MM` / `YYYY/MM`（校验月份 1..12）。
 *
 * @param {string} text
 * @param {number} [tzOffsetMs]
 * @returns {{start: number, end: number, label: string}|null}
 */
function parseYearMonth(text, tzOffsetMs) {
  const m = /^(\d{4})[-/](\d{1,2})$/.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!(mo >= 1 && mo <= 12)) return null;
  const start = makeDay(y, mo, 1, tzOffsetMs);
  const end = mo === 12 ? makeDay(y + 1, 1, 1, tzOffsetMs) : makeDay(y, mo + 1, 1, tzOffsetMs);
  if (start === null || end === null) return null;
  return { start, end, label: `${y}-${String(mo).padStart(2, '0')}` };
}

/**
 * 解析区间 `A..B` 的单侧端点（左闭右开 `[from, to)`）。
 *
 * @param {string} text
 * @param {boolean} isEnd
 * @param {number} nowTs
 * @param {number} [tzOffsetMs]
 * @returns {number|null}
 */
function parseEndpoint(text, isEnd, nowTs, tzOffsetMs) {
  const pure = parsePureDate(text, nowTs, tzOffsetMs);
  if (pure) return isEnd ? pure.day + DAY_MS : pure.day;

  const ym = parseYearMonth(text, tzOffsetMs);
  if (ym) return isEnd ? ym.end : ym.start;

  const isoTs = parseIsoWithTime(text, tzOffsetMs);
  if (isoTs !== null) return isoTs;

  if (/^\d{10,13}$/.test(text)) {
    const rawNum = Number(text);
    const ms = text.length === 10 ? rawNum * 1000 : rawNum;
    return Number.isFinite(ms) ? ms : null;
  }

  return null;
}

/**
 * 标准化 `when` 参数 → `[from, to)` 区间（默认上海时区 UTC+8，支持配置覆盖）。
 *
 * @param {string} when
 * @param {number} [now]
 * @param {{tzOffsetMs?: number}} [opts]
 * @returns {{kind:'day'|'span'|'range'|'latest'|'unknown', from:number|null, to:number|null, label:string}}
 */
export function parseWhen(when, now = Date.now(), opts = {}) {
  const tzOffsetMs = resolveTzOffsetMs(opts?.tzOffsetMs);
  const raw = String(when ?? '').trim();
  const nowTs = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  if (!raw) return { kind: 'latest', from: null, to: null, label: '最近一次聊天' };

  // 1. 相对天数：^(?:last:)?(\d+)d$（正整数）
  const daysMatch = /^(?:last:)?(\d+)d$/i.exec(raw);
  if (daysMatch) {
    const n = Number(daysMatch[1]);
    if (Number.isInteger(n) && n >= 1) {
      return {
        kind: 'span',
        from: dayShift(nowTs, -(n - 1), tzOffsetMs),
        to: dayShift(nowTs, 1, tzOffsetMs),
        label: `最近 ${n} 天`,
      };
    }
    return { kind: 'unknown', from: null, to: null, label: raw };
  }

  // 2. 标准区间：A..B（按第一处 .. 拆成左右两侧）
  if (raw.includes('..')) {
    const sepIdx = raw.indexOf('..');
    const leftText = raw.slice(0, sepIdx).trim();
    const rightText = raw.slice(sepIdx + 2).trim();
    if (!leftText && !rightText) {
      return { kind: 'unknown', from: null, to: null, label: raw };
    }
    const startVal = leftText ? parseEndpoint(leftText, false, nowTs, tzOffsetMs) : null;
    const endVal = rightText ? parseEndpoint(rightText, true, nowTs, tzOffsetMs) : null;
    if ((leftText && startVal === null) || (rightText && endVal === null)) {
      return { kind: 'unknown', from: null, to: null, label: raw };
    }

    if (!leftText) {
      const from = 0;
      const to = endVal;
      if (!(to > from)) return { kind: 'unknown', from: null, to: null, label: raw };
      return { kind: 'range', from, to, label: `截至 ${fmtDate(endVal - 1, tzOffsetMs)}` };
    }
    if (!rightText) {
      const from = startVal;
      const to = dayShift(nowTs, 1, tzOffsetMs);
      if (!(to > from)) return { kind: 'unknown', from: null, to: null, label: raw };
      return { kind: 'range', from, to, label: `${fmtDate(startVal, tzOffsetMs)} 起` };
    }

    const from = startVal;
    const to = endVal;
    if (!(to > from)) return { kind: 'unknown', from: null, to: null, label: raw };
    return { kind: 'range', from, to, label: fmtSpan(from, to - 1, tzOffsetMs) };
  }

  // 3. 单月：YYYY-MM / YYYY/MM
  const ym = parseYearMonth(raw, tzOffsetMs);
  if (ym) {
    return { kind: 'range', from: ym.start, to: ym.end, label: ym.label };
  }

  // 4. 单日：YYYY-MM-DD / YYYY/MM/DD / MM-DD / MM/DD
  const pure = parsePureDate(raw, nowTs, tzOffsetMs);
  if (pure) {
    return {
      kind: 'day',
      from: pure.day,
      to: pure.day + DAY_MS,
      label: pure.hasYear ? fmtLongDate(pure.day, tzOffsetMs) : fmtDate(pure.day, tzOffsetMs),
    };
  }

  // 5. 带时刻 ISO 或 epoch ms 单值传入 → 取该时刻所在自然日
  const isoTs = parseIsoWithTime(raw, tzOffsetMs);
  if (isoTs !== null) {
    const day = startOfDay(isoTs, tzOffsetMs);
    return { kind: 'day', from: day, to: day + DAY_MS, label: fmtLongDate(day, tzOffsetMs) };
  }
  if (/^\d{10,13}$/.test(raw)) {
    const ms = Number(raw);
    if (Number.isFinite(ms)) {
      const day = startOfDay(ms, tzOffsetMs);
      return { kind: 'day', from: day, to: day + DAY_MS, label: fmtLongDate(day, tzOffsetMs) };
    }
  }

  return { kind: 'unknown', from: null, to: null, label: raw };
}

/**
 * 把工具参数解析成统一的时间窗（只看 `args.when`）。
 *
 * @param {{when?: string}} args
 * @param {number} [now]
 * @param {{tzOffsetMs?: number}} [opts]
 * @returns {{kind:'day'|'span'|'range'|'latest'|'unknown', from:number|null, to:number|null,
 *            label:string, explicit:boolean}}
 */
export function resolveTimeWindow(args = {}, now = Date.now(), opts = {}) {
  const when = typeof args?.when === 'string' ? args.when : args?.when == null ? '' : String(args.when);
  const parsed = parseWhen(when, now, opts);
  return { ...parsed, explicit: parsed.kind !== 'latest' };
}

/* ================================ 摘录（D-053~055） ================================ */

/**
 * 信息密度打分（D-054 的维度）：专名/数字·日期、转折犹豫词、承诺、未解梗、情绪突变、承重的极短句。
 * 只用于「摘哪几轮」的选择，不进输出、不做任何解读。
 *
 * @param {string} text
 * @returns {number}
 */
export function density(text) {
  const t = String(text ?? '');
  if (!t) return 0;
  let score = 0;
  if (/[0-9０-９]/.test(t)) score += 8; // 数字/日期/时刻
  if (/\d{1,2}\s*[月日号点:时]/.test(t)) score += 6;
  if (/[「『《"“]/.test(t)) score += 4; // 引号里通常是专名或没懂的梗
  if (/(其实|算了|没事|但是|不过|可是|好像|有点|反正|不然|就是)/.test(t)) score += 8; // 转折/犹豫
  if (/(明天|下次|答应|一定|以后|说好|回头|记得|约定)/.test(t)) score += 8; // 承诺
  if (/(怕|难过|哭|生气|喜欢|想你|睡不着|讨厌|委屈|累|紧张|担心|舍不得|冷)/.test(t)) score += 7; // 情绪
  if (/(不要|别|必须|绝对|永远)/.test(t)) score += 4; // 边界/强调
  const len = Array.from(t).length;
  if (len <= 12) score += 6; // 承重的极短句（「算了」「嗯」）
  else if (len <= 20) score += 3;
  if (/[？?]/.test(t)) score += 3;
  if (/[…]|\.\.\./.test(t)) score += 3; // 话没说完
  return score;
}

/**
 * 摘录预算（D-055 原规则）。
 *
 * ## 为什么现在会「整场给」
 *
 * `memory_search` 的接缝渲染会把被省略的段落标成
 * `省略 20 轮（18:24–18:38，可传 when 精确补查）`，
 * 明确邀请 Agent 拿那个时间区间再查一次。
 *
 * 但如果这里仍然摘录，**再查一次只拿回 6~8 轮里的少数** —— 实测：
 * 用 `when` 精确补查 22 条被省略的消息，只找回 3 条（14%）。
 * 那个「逃生口」等于假的。
 *
 * 所以：**窄区间一律全给。** 判据见 `shouldShowAll`。
 *
 * 原始预算规则（宽区间仍沿用）：≤6 全给；7~20 给 4~6；>20 给 6~8。
 *
 * @param {object[]} msgs 按 seq/时间升序
 * @param {{from?: number, to?: number}} [opts] 查询区间（用来判断「窄」）
 * @returns {{picks:{index:number,msg:object}[], truncated:boolean}}
 */
export function pickExcerpt(msgs, opts = {}) {
  const n = Array.isArray(msgs) ? msgs.length : 0;
  if (n === 0) return { picks: [], truncated: false };
  if (n <= 6) return { picks: msgs.map((msg, index) => ({ index, msg })), truncated: false };

  // **窄区间不摘录**：Agent 是被明确邀请来补查的，给一半等于骗人
  if (shouldShowAll(msgs, opts)) {
    return { picks: msgs.map((msg, index) => ({ index, msg })), truncated: false };
  }

  const maxShow =
    n <= 20 ? Math.min(6, Math.max(4, Math.round(n * 0.35))) : n >= 40 ? 8 : n >= 30 ? 7 : 6;

  const chosen = new Set([0, n - 1]); // 首轮 + 尾轮是锚点（D-053）
  const partnerOf = (i) => {
    if (i <= 0 || i >= n - 1) return null;
    return msgs[i]?.speaker === 'user' ? i + 1 : i - 1;
  };

  // 首尾两轮先成对，保证「开头不是半句、结尾不是半句」
  for (const i of [1, n - 2]) {
    if (chosen.size >= maxShow) break;
    if (i > 0 && i < n - 1) chosen.add(i);
  }

  // 剩下的预算按密度从高到低选，选一条顺手带上它的对家
  const ranked = [];
  for (let i = 1; i < n - 1; i++) ranked.push({ index: i, score: density(msgs[i]?.text) });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  for (const item of ranked) {
    if (chosen.size >= maxShow) break;
    if (chosen.has(item.index)) continue;
    chosen.add(item.index);
    const partner = partnerOf(item.index);
    if (partner !== null && !chosen.has(partner) && chosen.size < maxShow) chosen.add(partner);
  }

  const indices = [...chosen].sort((a, b) => a - b);
  return {
    picks: indices.map((index) => ({ index, msg: msgs[index] })),
    truncated: indices.length < n,
  };
}

/* ================================ 内部工具 ================================ */

/**
 * **这个场景该不该整场全给**（不摘录）。
 *
 * 判据（任一满足即可）：
 *   ① 轮数少（≤ `FULL_SCENE_MAX_MSGS`）—— 本来就没多少，摘了反而丢信息
 *   ② 总字数小（≤ `FULL_SCENE_MAX_CHARS`）—— 整场给也撑不爆上下文
 *   ③ 查询区间很窄（≤ `FULL_SCENE_MAX_SPAN_MS`）—— 说明 Agent 是**定点补查**
 *
 * ③ 是关键：接缝渲染会把省略段标成「省略 20 轮（18:24–18:38，可传 when 精确补查）」，
 * Agent 照做时区间就是那 14 分钟 —— 这种情况**必须全给**，否则「补查」形同虚设。
 * 实测：不放开时，补查 22 条省略消息只找回 3 条（14%）。
 *
 * @param {object[]} msgs
 * @param {{from?: number, to?: number}} opts
 * @returns {boolean}
 */
export function shouldShowAll(msgs, opts = {}) {
  const list = Array.isArray(msgs) ? msgs : [];
  if (list.length === 0) return true;
  if (list.length <= FULL_SCENE_MAX_MSGS) return true;

  let chars = 0;
  for (const m of list) chars += String(m?.text ?? '').length;
  if (chars <= FULL_SCENE_MAX_CHARS) return true;

  const { from, to } = opts;
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    if (to - from <= FULL_SCENE_MAX_SPAN_MS) return true;
  }
  return false;
}

/** 整场给的轮数上限 */
export const FULL_SCENE_MAX_MSGS = 40;
/** 整场给的字数上限（约 3k 字，够一次读完且不爆上下文） */
export const FULL_SCENE_MAX_CHARS = 3000;
/** 查询区间 ≤ 这个时长 → 视为「定点补查」，整场全给 */
export const FULL_SCENE_MAX_SPAN_MS = 15 * 60 * 1000;

export function clampSceneLimit(limit) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return 3; // 默认 3 场（§7.1）
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
}

/**
 * 最近一次聊天：从最近的时间窗往前试，直到捞到场景
 * （库里可能整段都是被排除的日子，所以窗口要能放宽）。
 *
 * @param {object} repo
 * @param {number} now
 * @param {string|null} sessionId 只在这个会话里找（null = 单库模式，不过滤）
 * @returns {object[]} 按 startAt 升序，只含末尾一小段，交给上层逆序取
 */
function latestScenes(repo, now, sessionId = null) {
  for (const windowDays of [7, 30, 365, 3650]) {
    const scenes = repo.scenesByTimeRange(
      sessionId,
      dayShift(now, -(windowDays - 1)),
      dayShift(now, 1),
      FETCH_LIMIT,
    );
    if (scenes.length) return scenes.slice(-20); // 末尾 20 场足够挑出最近一场非空场景
  }
  return [];
}

/**
 * 模糊时段：「那阵子」按场景密度取前 N 场（§8.2），
 * 多取一倍候选，让"场景整段被排除"时还有后备。
 *
 * @param {object} repo
 * @param {{from:number, to:number}} parsed
 * @param {number} limit
 * @param {string|null} sessionId 只在这个会话里找（null = 单库模式）
 * @returns {object[]} 按 startAt 升序
 */
function spanScenes(repo, parsed, limit, sessionId = null) {
  const scenes = repo.scenesByTimeRange(sessionId, parsed.from, parsed.to, FETCH_LIMIT);
  // 返回的是「挑选顺序」（密度降序），显示顺序由上层再按时间升序排。
  // 多取一倍候选，让"场景整段被排除"时后面还有后备。
  return [...scenes]
    .sort((a, b) => b.msgCount - a.msgCount || b.startAt - a.startAt)
    .slice(0, Math.min(limit * 2, scenes.length));
}

/**
 * 分拣候选场景：**可见** 与 **整段被排除** 两类分开，这一步不讲 limit。
 *
 * 两条都是 P1 级（错报「记忆丢了」比查不到更糟）：
 * ① 被排除的场次**不能占 want 名额**。否则 `limit:1` 且第一场恰好整段被排除时，
 *    可见场次根本没机会被看一眼，最后报成「这一天被排除了」。
 * ② 「整天被排除」只有**可见场次真的为 0** 才能说；有可见场次时只报「另有 N 场被排除」。
 *
 * 判据：`msgsByScene(id)` 返回 `[]` ≠ 场景为空。scene 层没有 excluded 概念，
 * 被整段排除的日子照样切出场景，但可见消息全被过滤 → 用 `scene.msgCount`
 * （含被排除的条数，D-195 落库字段）判「这场有没有内容」。
 *
 * @param {object} repo
 * @param {object[]} candidates 按想要的优先顺序
 * @param {{includeExcluded:boolean}} opts
 * @returns {{visible:{scene:object, msgs:object[]}[],
 *            excluded:{scene:object, total:number}[]}}
 */
function classifyScenes(repo, candidates, { includeExcluded }) {
  const visible = [];
  const excluded = [];
  for (const scene of candidates) {
    const msgs = repo.msgsByScene(scene.id, includeExcluded);
    if (msgs.length > 0) {
      visible.push({ scene, msgs });
      continue;
    }
    if (includeExcluded) continue;
    const total = Number(scene.msgCount ?? 0) || repo.msgsByScene(scene.id, true).length;
    if (total > 0) excluded.push({ scene, total });
  }
  return { visible, excluded };
}

/**
 * 渲染一场：头 + 摘录 + 排除/压缩标记 + 前一场尾巴。
 * @param {{scene:object, msgs:object[]}} block
 * @param {{now:number, includeExcluded:boolean, prevRange:object|null, leadIn:object[]}} opts
 * @returns {string}
 */
function renderBlock(block, opts) {
  const { scene, msgs } = block;
  // 把查询区间传下去：窄区间（Agent 定点补查）不摘录，整场全给
  const { picks } = pickExcerpt(msgs, { from: opts?.from, to: opts?.to });
  // 总条数用 scene.msgCount（含被按日期排除的）：5 条里排除 2 条时，
  // 用 msgs.length 会显示「共 3 轮」且只贴 3 句、没有任何提示（P2-A）。
  const total = Number(scene.msgCount ?? 0) || msgs.length;
  const hidden = Math.max(0, total - msgs.length);
  const excludedHidden = Math.min(total, Math.max(hidden, Number(scene.excludedCount ?? 0)));
  const budgetCuts = picks.length < msgs.length; // 只有"摘录预算不够"才算「摘 M 轮」
  const lines = [];

  lines.push(
    sceneHeader(
      { startAt: scene.startAt, endAt: scene.endAt, msgCount: total },
      { shown: budgetCuts ? picks.length : null, now: opts.now },
    ),
  );
  lines.push('');

  let prevIndex = -1;
  for (const { index, msg } of picks) {
    if (prevIndex >= 0 && index > prevIndex + 1) lines.push('  ⋯');
    const baseClipped = clipText(msg.text);
    const annotated = opts.annotateMedia ? opts.annotateMedia(msg.id, baseClipped) : baseClipped;
    lines.push(quoteLine(annotated !== msg.text ? { ...msg, text: annotated } : msg, Infinity));
    if (opts.includeExcluded && msg.excluded === 1) lines.push(`    ${MARK_EXCLUDED_ONE}`);
    prevIndex = index;
  }

  // 部分被排除：必须说出来，不能静默（与整段排除同一口径）
  if (hidden > 0 && !opts.includeExcluded) {
    lines.push(
      '',
      `  （这场里另有 ${fmtCount(excludedHidden)} 条被按日期排除了，仅可在记忆库面板查看）`,
    );
  }

  // 这段已经装不进上下文，但原文还在（D-141）—— 场次末尾标一行
  // T3 的 scene.hasOutOfSurface 是权威口径（D-195 已落库，T1 映射成 0/1）；
  // 老库/未回填时是 0，此时按可见消息自己算，两者取「或」以免漏标。
  const surfaceFlag =
    typeof scene.hasOutOfSurface === 'boolean'
      ? scene.hasOutOfSurface
      : Number(scene.hasOutOfSurface ?? 0) > 0;
  const hasOutOfSurface = surfaceFlag || msgs.some((m) => m.inSurface === 0);
  if (hasOutOfSurface) lines.push('', `  ${MARK_COMPACTED}`);

  // 前一场的尾巴：只作背景补充，不做任何推断（D-098 / D-100）
  if (opts.leadIn.length > 0) {
    lines.push('', leadInHeader(opts.prevRange));
    for (const msg of opts.leadIn) {
      lines.push(quoteLine(msg));
      if (opts.includeExcluded && msg.excluded === 1) lines.push(`      ${MARK_EXCLUDED_ONE}`);
    }
  }

  return lines.join('\n');
}

/* ================================ 时间路主体 ================================ */

/**
 * 按时间窗渲染（选场景 → 分拣 → 渲染）。
 *
 * 调用方负责解析依赖与统计；这里只管按时间窗把场次展开。
 *
 * @param {{
 *   repo: object, sessionId: string|null, now: number,
 *   stats: object,                 // 空结果时要报的库范围
 *   window: {kind:string, from:number|null, to:number|null, label:string},
 *   limit: number, includeExcluded: boolean,
 * }} input
 * @returns {string}
 */
export function runTimelineRoute(input) {
  const { repo, sessionId = null, now, stats, window: parsed, limit, includeExcluded, extras = null } = input;

  // —— 没看懂的时间窗：给标准写法 + 库范围，绝不返回空白 ——
  if (parsed.kind === 'unknown') {
    return emptyText({
      head: `没看懂「${parsed.label}」指的是哪段时间。`,
      stats,
      tips: [
        '请用标准时间格式：例如 when: "2026-11-09"、"11-09"、"2026-11"、"2026-11-09..2026-11-12" 或 "7d"。',
        '不填 when 时，会返回最近一次聊天。',
      ],
    });
  }

  // —— 候选场景（先取区间内的全部候选，分拣时不讲 limit） ——
  let candidates;
  if (parsed.kind === 'latest') {
    // 留空 = 最近一次聊天：从最近的时间窗往前试，直到捞到场景
    candidates = latestScenes(repo, now, sessionId).reverse(); // 最近在前
  } else if (parsed.kind === 'span') {
    candidates = spanScenes(repo, parsed, limit, sessionId);
  } else {
    // 相交语义：当天开始/结束跨零点的场次也会命中（scene.start_at < to && end_at >= from）
    candidates = repo.scenesByTimeRange(sessionId, parsed.from, parsed.to, FETCH_LIMIT);
  }

  // —— 分拣（先分「可看 / 整段被排除」，再按 limit 截断可看的） ——
  const want = parsed.kind === 'latest' ? 1 : limit;
  const { visible, excluded } = classifyScenes(repo, candidates, { includeExcluded });
  const shown = visible.slice(0, want); // 被排除的场次不占名额（P1-A）

  // —— 一场可看的都没有 ——
  if (shown.length === 0) {
    if (excluded.length > 0) {
      // 数目必须准：分拣阶段已扫完整个区间，不用再猜「是不是被 limit 截断了」
      const msgTotal = excluded.reduce((sum, e) => sum + e.total, 0);
      const what =
        excluded.length === 1
          ? `${fmtDate(excluded[0].scene.startAt)} 有 1 场对话`
          : `${parsed.label} 有 ${fmtCount(excluded.length)} 场对话`;
      return [
        `${what}（共 ${fmtCount(msgTotal)} 条），但这天的记录被用户设为不回想/排除（不是没聊过）。`,
        '仅可在记忆库面板查看原文。',
        libraryLine(stats),
      ].join('\n');
    }
    return emptyText({
      head: `没有找到 ${parsed.label} 的记录。`,
      stats,
      tips: [
        '可以调整 when 的范围，例如 "2026-11-09..2026-11-12"、"2026-11" 或 "7d"。',
      ],
    });
  }

  // —— 渲染（一律按时间升序，不做叙事，§7.3） ——
  const ordered = [...shown].sort((a, b) => a.scene.startAt - b.scene.startAt);
  const rendered = [];
  /** 本次输出里已经贴过的场景 id —— 前一场就在这里的话，尾巴不必再贴一遍 */
  const shownSceneIds = new Set();
  const allMsgIds = [];
  for (const block of ordered) {
    for (const m of (block.msgs || [])) {
      if (m && m.id !== undefined && m.id !== null) allMsgIds.push(m.id);
    }
  }
  const annotateMedia = buildMediaAnnotator(extras, allMsgIds, input.dshHome ?? null);

  for (const block of ordered) {
    const prevId = block.scene.precededBy;
    let prevRange = null;
    let leadIn = [];

    if (prevId !== null && prevId !== undefined) {
      // 邻接链理论上只在同一会话里（sceneAssign 按 sessionId 清空/重建），
      // 但库里被手工改过或跨库导入时可能串会话 —— 串了就整段不要，
      // 不能把别的会话的场景/原文当成「前一场的尾巴」贴出来（A1）。
      const found = repo.sceneById(prevId);
      const prev = found && (!sessionId || found.sessionId === sessionId) ? found : null;
      if (prev) prevRange = { startAt: prev.startAt, endAt: prev.endAt };
      // 尾巴一律从**可见消息**里取，而不是直接用 T3 存的 lead_in 摘要：
      // 摘要不区分 excluded，前一场若是被排除的（D-169/170），
      // 直接贴摘要就把被排除的原文漏进了默认输出。
      if (prev && !shownSceneIds.has(prevId)) {
        leadIn = repo.msgsByScene(prevId, includeExcluded).slice(-2);
      }
    } else {
      // 前一场的行没了（重建过半截），退回 T3 存的摘要，但只在没被排除时用
      const rawDigest = parseLeadIn(block.scene.leadInMsgs ?? block.scene.leadIn).slice(-2);
      const digest = includeExcluded ? rawDigest : rawDigest.filter((m) => m.excluded !== 1);
      if (digest.length > 0) {
        leadIn = digest;
        prevRange = { startAt: digest[0].at, endAt: digest[digest.length - 1].at };
      }
    }

    rendered.push(renderBlock(block, { now, includeExcluded, prevRange, leadIn, from: parsed.from, to: parsed.to, annotateMedia }));
    shownSceneIds.add(block.scene.id);
  }

  // 明确日期查询才谈得上"这一天还有几场"；相对天数跨度是按密度挑的，说了会误导
  if (parsed.kind === 'day' || parsed.kind === 'range') {
    // 同一天里还有整段被排除的场次：说清"另有几场"，而不是让TA以为数据缺了
    if (excluded.length > 0) {
      rendered.push(
        `（这天另有 ${fmtCount(excluded.length)} 场被按日期排除了，仅可在记忆库面板查看）`,
      );
    }
    const rest = visible.length - shown.length;
    if (rest > 0) {
      rendered.push(`（这天还有 ${fmtCount(rest)} 场没列出来，要看得把 limit 调大一点。）`);
    }
  }
  return rendered.join('\n\n');
}

/**
 * 纯时间路快捷入口（供 memory_search 无 query 时调用）。
 *
 * @param {{
 *   repo: object, sessionId?: string|null, now: number, extras: object,
 *   window: {kind:string, from:number|null, to:number|null, label:string},
 *   limit?: number, includeExcluded?: boolean, dshHome?: string|null,
 * }} input
 * @returns {string}
 */
export function runTimeOnlyRoute({
  repo,
  sessionId = null,
  now,
  extras,
  window,
  limit,
  includeExcluded = false,
  dshHome = null,
}) {
  return runTimelineRoute({
    repo,
    sessionId,
    now,
    window,
    limit: clampSceneLimit(limit),
    includeExcluded,
    extras,
    dshHome,
    stats: sessionStats(extras, sessionId),
  });
}

export { FETCH_LIMIT as TIME_ROUTE_FETCH_LIMIT };
