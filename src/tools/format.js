// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 工具层共用排版（format）—— memory_search（含时间路与检索路）/ memory_remember / memory_forget 的所有对外文本都从这里出。
 *
 * 为什么要单独一个文件：所有工具输出必须"长得一样"（同一套时间写法、同一套空结果说法），
 * 否则TA读到的记忆会用不同口吻描述同一段时间。
 *
 * 四条硬约束：
 * ① 时区固定 **Asia/Shanghai（UTC+8，无夏令时）**，不用机器本地时区。
 *    机器可能在任何时区，而TA的「昨天」永远是上海的昨天（D-043 / D-172）。
 * ② 时间一律标**区间**（`11-12 23:36–00:12`），不标单点（D-052）。
 * ③ 三段信息：绝对 + 相对 + 时段（D-042）。模型算不出绝对时间差，会把三天前说成刚才。
 * ④ 空结果**不能是空白**：必须给出库的范围 + 一条建议（IMPLEMENTATION.md §7 / D-096）。
 */

/* ============================== 时间常量与基础换算 ============================== */

/** 上海固定偏移（UTC+8）。中国不用夏令时，所以是常数而不是按日期算。 */
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

const ianaFmtCache = new Map();

function ianaOffsetMsAt(atMs, timeZone) {
  try {
    let fmt = ianaFmtCache.get(timeZone);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      if (ianaFmtCache.size < 32) ianaFmtCache.set(timeZone, fmt);
    }
    const parts = fmt.formatToParts(new Date(Number(atMs)));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const flooredSec = Math.floor(Number(atMs) / 1000) * 1000;
    return asUtc - flooredSec;
  } catch {
    return null;
  }
}

/**
 * 解析当前生效的时区偏移毫秒数：
 * 显式传参 > 环境变量 VERBATIM_TZ（支持 IANA 时区与夏令时） > VERBATIM_TZ_OFFSET_MINUTES > 默认 +08:00。
 * @param {number|null|undefined} [overrideMs]
 * @param {number} [atMs]
 * @param {string|null|undefined} [timeZone]
 * @returns {number}
 */
export function resolveTzOffsetMs(overrideMs, atMs = Date.now(), timeZone = process.env.VERBATIM_TZ) {
  if (overrideMs !== null && overrideMs !== undefined && Number.isFinite(Number(overrideMs))) {
    return Number(overrideMs);
  }
  const tzName = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (tzName) {
    const iana = ianaOffsetMsAt(atMs, tzName);
    if (iana !== null && Number.isFinite(iana)) return iana;
  }
  const envMin = process.env.VERBATIM_TZ_OFFSET_MINUTES;
  if (envMin !== undefined && envMin !== '') {
    const m = Number(envMin);
    if (Number.isFinite(m) && m >= -720 && m <= 840) return m * 60_000;
  }
  return TZ_OFFSET_MS;
}

/** 一天。上海不改时间，所以这个常数永远准。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 上下文（未命中邻居）的展示上限。
 *
 * ## 两种上限，按「是否命中」分开
 *
 * 核心区分：**命中的 msg / 分片 / 片段是证据本身，不能压缩；
 * 场景上下文只是帮人看懂语境，可以压。**
 *
 * 陪伴场景大多为短句，技术场景则常包含长代码或日志片段（截断会丢失关键信息），
 * 所以命中项一律不截。
 *
 * > 注：>800 字的消息会切成 ~400 字分片，命中时只显示那一片，
 * > 所以「命中全文」的实际上限通常 400~800 字，不会失控。
 */
export const CLIP_MAX = 240;

/** 命中项上限：`Infinity` = 全文给（不截）—— 那是证据本身 */
export const HIT_CLIP_MAX = Infinity;

/**
 * 上下文（未命中邻居）上限。
 *
 * 它的作用只是「让 Agent 看懂命中句的语境」，不需要细节。
 * 240 字里往往后半段已经是展开的论证 —— 那属于命中项该给的东西。
 * 压到 120 字既保留语境，又把篇幅让给真正命中的那几条。
 */
export const CONTEXT_CLIP_MAX = 120;

/** 星期几的中文名，索引是 Date 的 getUTCDay() */
export const WEEKDAY_NAMES = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 把一个 epoch ms 拆成**上海本地**的年月日时分。
 * 做法：先整体平移 +8h，再用 UTC 取值——等价于本地时间，且不受机器时区影响。
 *
 * @param {number} ts epoch ms
 * @returns {{y:number, mo:number, d:number, h:number, mi:number, wd:number}}
 */
export function shanghaiParts(ts, tzOffsetMs) {
  const offset = resolveTzOffsetMs(tzOffsetMs, ts);
  const d = new Date(Number(ts) + offset);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

/**
 * 当天 00:00 的 epoch ms（含），默认按上海时区（+08:00）。
 * @param {number} ts
 * @param {number} [tzOffsetMs]
 * @returns {number}
 */
export function startOfDay(ts, tzOffsetMs) {
  const offset = resolveTzOffsetMs(tzOffsetMs, ts);
  const t = Number(ts) + offset;
  return Math.floor(t / DAY_MS) * DAY_MS - offset;
}

/**
 * 以「天」为单位平移：dayShift(t, -3) = 3 天前的 00:00。
 * 只用于"某一天"的语义，不用于时长加减（时长请直接加减 DAY_MS）。
 *
 * @param {number} ts
 * @param {number} days
 * @param {number} [tzOffsetMs]
 * @returns {number}
 */
export function dayShift(ts, days, tzOffsetMs) {
  return startOfDay(ts, tzOffsetMs) + Number(days) * DAY_MS;
}

/**
 * 本周**周一** 00:00（中文语境的「上周三」按周一起算）。
 * @param {number} ts
 * @param {number} [tzOffsetMs]
 * @returns {number}
 */
export function startOfWeek(ts, tzOffsetMs) {
  const { wd } = shanghaiParts(ts, tzOffsetMs);
  const mondayIndex = (wd + 6) % 7; // 周一=0 … 周日=6
  return startOfDay(ts, tzOffsetMs) - mondayIndex * DAY_MS;
}

/** 周几的名字 → 周一起算的下标（周一=0 … 周日=6） */
export function weekdayIndex(name) {
  const wd = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[name];
  return wd === undefined ? null : (wd + 6) % 7;
}

/* ================================ 时间格式化 ================================ */

/** `11-12` */
export function fmtDate(ts, tzOffsetMs) {
  const p = shanghaiParts(ts, tzOffsetMs);
  return `${pad2(p.mo)}-${pad2(p.d)}`;
}

/** `2026-11-12` */
export function fmtLongDate(ts, tzOffsetMs) {
  const p = shanghaiParts(ts, tzOffsetMs);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** `23:36` */
export function fmtTime(ts, tzOffsetMs) {
  const p = shanghaiParts(ts, tzOffsetMs);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}

/** `11-12 23:36` */
export function fmtStamp(ts, tzOffsetMs) {
  return `${fmtDate(ts, tzOffsetMs)} ${fmtTime(ts, tzOffsetMs)}`;
}

/**
 * 时间区间 `11-12 23:36–00:12`（D-052：标区间，不标单点）。
 *
 * 跨零点几分钟（23:36–00:12）按规格只写时间——与 IMPLEMENTATION.md §7.1 的样例一致；
 * 但跨天且时长 ≥ 6 小时时只写 `23:00–05:00` 会被读成同一天，这时补上结束日期。
 *
 * @param {number} startAt
 * @param {number} endAt
 * @returns {string}
 */
export function fmtRange(startAt, endAt) {
  const a = Number(startAt);
  let b = Number(endAt);
  if (!Number.isFinite(a)) return '（时间缺失）';
  if (!Number.isFinite(b) || b < a) b = a;
  const pa = shanghaiParts(a, undefined);
  const pb = shanghaiParts(b, undefined);
  const sameDay = pa.y === pb.y && pa.mo === pb.mo && pa.d === pb.d;
  if (!sameDay && b - a >= 6 * 60 * 60 * 1000) {
    return `${fmtStamp(a)}–${fmtDate(b)} ${fmtTime(b)}`;
  }
  return `${fmtStamp(a)}–${fmtTime(b)}`;
}

/**
 * 时段（D-042 的第三层信息）。
 * @param {number} ts
 * @returns {string}
 */
export function fmtPhase(ts) {
  const { h } = shanghaiParts(ts, undefined);
  if (h < 2 || h === 23) return '深夜';
  if (h < 5) return '凌晨';
  if (h < 8) return '清晨';
  if (h < 11) return '早上';
  if (h < 13) return '中午';
  if (h < 17) return '下午';
  if (h < 19) return '傍晚';
  if (h < 23) return '晚上';
  return '深夜';
}

/**
 * 相对时间（D-042 的第二层信息）。
 * @param {number} ts
 * @param {number} [now]
 * @returns {string}
 */
export function fmtRelative(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return '';
  const diff = Number(now) - t;
  if (diff < 60_000) return '刚刚'; // 含 ts 比 now 还晚的时钟漂移
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 6 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days <= 30) return `${days} 天前`;
  if (days <= 365) return `${Math.round(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}

/** `7,572` —— 千分位手写，不依赖 locale */
export function fmtCount(n) {
  const v = Math.trunc(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 日期跨度：同年给 `11-08 至 11-17`，跨年给 `2025-12-20 至 2026-01-05`。
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
export function fmtSpan(from, to, tzOffsetMs) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const sameYear = shanghaiParts(a, tzOffsetMs).y === shanghaiParts(b, tzOffsetMs).y;
  const f = sameYear ? fmtDate : fmtLongDate;
  return `${f(a, tzOffsetMs)} 至 ${f(b, tzOffsetMs)}`;
}

/* ================================ 文本排版 ================================ */

export const DEFAULT_SPEAKER_LABELS = Object.freeze({
  user: '他',
  assistant: '我',
  unknown: '？',
});

/**
 * 解析说话人称呼映射：显式传参 > 环境变量 VERBATIM_SPEAKER_USER / VERBATIM_SPEAKER_ASSISTANT > 默认「他 / 我」。
 * @param {{user?:string, assistant?:string, unknown?:string}|null|undefined} [labels]
 * @returns {{user:string, assistant:string, unknown:string}}
 */
export function resolveSpeakerLabels(labels = null) {
  const envUser = typeof process.env.VERBATIM_SPEAKER_USER === 'string' && process.env.VERBATIM_SPEAKER_USER.trim()
    ? process.env.VERBATIM_SPEAKER_USER.trim()
    : null;
  const envAssistant = typeof process.env.VERBATIM_SPEAKER_ASSISTANT === 'string' && process.env.VERBATIM_SPEAKER_ASSISTANT.trim()
    ? process.env.VERBATIM_SPEAKER_ASSISTANT.trim()
    : null;
  return {
    user: (typeof labels?.user === 'string' && labels.user.trim()) ? labels.user.trim() : (envUser ?? DEFAULT_SPEAKER_LABELS.user),
    assistant: (typeof labels?.assistant === 'string' && labels.assistant.trim()) ? labels.assistant.trim() : (envAssistant ?? DEFAULT_SPEAKER_LABELS.assistant),
    unknown: (typeof labels?.unknown === 'string' && labels.unknown.trim()) ? labels.unknown.trim() : DEFAULT_SPEAKER_LABELS.unknown,
  };
}

/**
 * 说话人标签 —— **从TA自己的视角标**（默认：用户「他」、TA自己「我」，可通过参数或环境变量覆盖）。
 */
export function speakerLabel(speaker, labels = null) {
  const map = resolveSpeakerLabels(labels);
  if (speaker === 'user') return map.user;
  if (speaker === 'assistant') return map.assistant;
  return map.unknown;
}

/**
 * 长文本截断：只截**显示量**，并明确标出后略多少字（原文在库里一字不改）。
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipText(text, max = CLIP_MAX) {
  const s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const keep = chars.slice(0, max).join('').replace(/\s+$/, '');
  return `${keep}…（后略 ${fmtCount(chars.length - max)} 字）`;
}

/**
 * 每行加缩进（多行消息也能对齐）。
 * @param {string} text
 * @param {string} [pad]
 * @returns {string}
 */
export function indentText(text, pad = '  ') {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line ? pad + line : ''))
    .join('\n');
}

/**
 * 一条原话的展示行（D-194：从TA的视角，用户标「他」、TA自己标「我」）：
 *   他：「其实我有点怕」
 * 多行消息的续行缩进，收尾的 」 落在最后一行。
 *
 * @param {{speaker:string, text:string}} msg
 * @param {string} [pad]
 * @returns {string}
 */
export function quoteLine(msg, pad = '  ', opts = {}) {
  const raw = String(msg?.text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  const body = opts?.clip === false ? raw : clipText(raw);
  const lines = body.split('\n');
  const label = `${pad}${speakerLabel(msg?.speaker, opts?.speakerLabels)}：「`;
  if (lines.length === 1) return `${label}${lines[0]}」`;
  // 续行缩进对齐；空行不补空格（补了会在终端里留一截看不见的尾空白）
  const joined = lines
    .map((line, i) => (i === 0 ? line : line ? `${pad}  ${line}` : ''))
    .join('\n');
  return `${label}${joined}」`;
}

/* ============================== 场景头与固定文案 ============================== */

/**
 * `note.about` → 展示标签。**全仓只此一份**（remember / forget / search 三处共用），
 * 否则同一份笔记会按调用方不同而显示成「关于他」或「关于你」（口径漂移）。
 *
 * 采用 Agent 第一人称视角（工具结果是TA自己读的，与 `speakerLabel` 的「他 / 我」一致）：
 * `me` = TA自己（**关于你自己**），`him` = 用户（**关于他**），`us` = 双方（**关于你们俩**）。
 */
export const NOTE_ABOUT_LABELS = Object.freeze({
  me: '关于你自己',
  him: '关于他',
  us: '关于你们俩',
});

/**
 * 取 note.about 的展示标签，认不出返回 null（不猜、不硬编）。
 * @param {string|null|undefined} about
 * @param {Record<string, string>|null} [aboutLabels]
 * @returns {string|null}
 */
export function noteAboutLabel(about, aboutLabels = null) {
  if (!about) return null;
  const key = String(about);
  if (aboutLabels && typeof aboutLabels[key] === 'string' && aboutLabels[key].trim()) {
    return aboutLabels[key].trim();
  }
  return NOTE_ABOUT_LABELS[key] ?? null;
}

/**
 * 同一批 about 的「短说法」（去掉「关于」前缀），给 `记于 … · 关于他` 这类后缀用。
 * 和 NOTE_ABOUT_LABELS 同源，避免 forget 那边自己再写一份枚举。
 */
export const NOTE_ABOUT_WORDS = Object.freeze({
  me: '你自己',
  him: '他',
  us: '你们俩',
});

/**
 * @param {string|null|undefined} about
 * @param {Record<string, string>|null} [aboutLabels]
 * @returns {string|null} 认不出返回 null
 */
export function noteAboutWord(about, aboutLabels = null) {
  if (!about) return null;
  const key = String(about);
  if (aboutLabels && typeof aboutLabels[key] === 'string' && aboutLabels[key].trim()) {
    return aboutLabels[key].trim().replace(/^关于/, '');
  }
  return NOTE_ABOUT_WORDS[key] ?? null;
}

/**
 * 单行内联截断：把换行/连续空白折成空格再截断（用于标题里回显 query）。
 *
 * 为什么必须折行：标题会被下游按行解析，query 里带一个换行就把标题断成两行；
 * 3000 字的 query 原样回显会把整段输出挤爆。
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipInline(text, max = 40) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max).join('')}…`;
}

/** 早已不在上下文、但原文还在的场次标记（IMPLEMENTATION.md §7.1 原文要求） */
export const MARK_COMPACTED = '（这段已经装不进你的上下文了，话还在）';

/** 单条消息的同类标记（search 用「这句」） */
export const MARK_COMPACTED_ONE = '（这句已经装不进你的上下文了，话还在）';

/** 被软排除（D-169/170）的消息，只在 `includeExcluded` 时可见 */
export const MARK_EXCLUDED_ONE = '（这条平时被排除在外，只在核对时可见）';

/**
 * 场景头一行：`11-12 23:36–00:12   共 18 轮（5 天前 · 深夜）`
 * 大场景下标成 `共 46 轮，摘 7 轮`（D-055：必须让TA知道还有下文）。
 *
 * 注：`msgCount` 传**场景总条数**（scene.msgCount，含被按日期排除的，D-197「条数写轮」）；
 * `shown` 只在「因为摘录预算被截断」时传，否则会出现「共 5 轮，摘 3 轮」这种
 * 把排除当成截断的误导（P2-A）。
 *
 * @param {{startAt:number, endAt:number, msgCount:number}} scene
 * @param {{shown?:number|null, now?:number}} [opts]
 * @returns {string}
 */
export function sceneHeader(scene, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const total = Number(scene?.msgCount ?? 0);
  const shown = opts.shown === null || opts.shown === undefined ? null : Number(opts.shown);
  let count = `共 ${fmtCount(total)} 轮`;
  if (shown !== null && shown < total) count += `，摘 ${fmtCount(shown)} 轮`;
  const when = `${fmtRelative(scene?.startAt, now)} · ${fmtPhase(scene?.startAt)}`;
  return `${fmtRange(scene?.startAt, scene?.endAt)}   ${count}（${when}）`;
}

/** `（前一场 11-12 22:10–22:48 的尾巴）` */
export function leadInHeader(prevRange) {
  if (!prevRange || !Number.isFinite(Number(prevRange.startAt))) return '  （前一场的尾巴）';
  return `  （前一场 ${fmtRange(prevRange.startAt, prevRange.endAt)} 的尾巴）`;
}

/**
 * 「库里有 …」这一行。空结果时必须给，不能返回空白（D-096）。
 *
 * stats.msgs / chars 是**入库总量**（含被排除的），
 * 所以「能查到多少」要用 msgs - excludedMsgs（D-170 / T1 接口语义）。
 *
 * @param {{msgs?:number, scenes?:number, notes?:number, excludedMsgs?:number, firstAt?:number|null,
 *          lastAt?:number|null}} stats
 * @returns {string}
 */
export function libraryLine(stats = {}) {
  const total = Number(stats?.msgs ?? 0);
  const notes = Number(stats?.notes ?? 0);
  if (!total && !notes) return '库里还什么都没有——一条记录都没进来。可以先导入会话日志再问。';
  const excluded = Number(stats?.excludedMsgs ?? 0);
  const usable = Math.max(0, total - excluded);
  const scenes = Number(stats?.scenes ?? 0);
  const span = fmtSpan(stats?.firstAt, stats?.lastAt, undefined);
  let line = `库里有${span ? ` ${span} 的` : ''} ${fmtCount(usable)} 条可检索的消息、${fmtCount(scenes)} 个场景`;
  if (excluded > 0) line += `（另有 ${fmtCount(excluded)} 条按日期排除，检索不到）`;
  if (notes > 0) line += `，还有 ${fmtCount(notes)} 条你自己记的笔记`;
  return `${line}。`;
}

/**
 * 空结果的三段式：没找到什么 → 库里有什么 → 接下来能怎么办。
 * 三个参数都可以缺，但至少要有一句，保证输出不为空。
 *
 * @param {{head?:string, stats?:object, tips?:string[]}} opts
 * @returns {string}
 */
export function emptyText({ head, stats, tips = [] } = {}) {
  const lines = [];
  if (head) lines.push(head);
  lines.push(libraryLine(stats));
  for (const tip of tips) {
    if (tip) lines.push(tip);
  }
  return lines.join('\n');
}

/** 把一段原始 JSON 文本（scene.lead_in）安全解析成消息数组 */
export function parseLeadIn(raw) {
  if (!raw) return [];
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(value)) return [];
    return value.filter((m) => m && typeof m.text === 'string');
  } catch {
    return []; // 坏数据不应该让整个工具挂掉
  }
}

/** 将 media.path（含 sha256: 附件 ID）解析为 Agent 可读取的本地路径或 URL */
export function resolveMediaPath(rawPath, dshHome = null) {
  const s = String(rawPath ?? '').trim();
  if (!s || s.startsWith('inline:')) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const shaMatch = /^sha256:([a-f0-9]{64})$/i.exec(s);
  if (shaMatch) {
    const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const hex = shaMatch[1].toLowerCase();
    const candidate = path.join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
    return null;
  }
  return s;
}

/** 构造媒体路径与备注标注函数：将图片本地路径与 caption 附着到消息文本 */
export function buildMediaAnnotator(extras, msgIds, dshHome = null) {
  if (typeof extras?.media?.byMsgIds !== 'function' || !Array.isArray(msgIds) || msgIds.length === 0) {
    return null;
  }
  let mediaMap = null;
  try {
    mediaMap = extras.media.byMsgIds(msgIds);
  } catch {
    return null;
  }
  if (!mediaMap || mediaMap.size === 0) return null;

  return (msgId, rawText) => {
    const items = mediaMap.get(Number(msgId)) || mediaMap.get(msgId);
    const text = String(rawText ?? '');
    if (!Array.isArray(items) || items.length === 0) return text;
    const paths = [];
    const captions = [];
    for (const it of items) {
      const resolved = resolveMediaPath(it?.path, dshHome);
      if (resolved) paths.push(`"${resolved}"`);
      const cap = String(it?.caption ?? '').trim();
      if (cap) captions.push(cap);
    }
    let out = text;
    if (paths.length > 0) {
      const pathStr = paths.join(' ');
      out = out.includes('[图片')
        ? out.replace('[图片', `${pathStr} [图片`)
        : `${out}\n${pathStr}`.trim();
    }
    if (captions.length > 0) {
      out = `${out}\n[图片备注：${captions.join('；')}]`.trim();
    }
    return out;
  };
}
