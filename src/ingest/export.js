// export.js —— 核心导出算法：从会话事件流重建「要入库的消息」
//
// 规格来源：IMPLEMENTATION.md §3 / §4，按 **D-141**（不是已被推翻的 D-120）。
//
// 三种事件的差别是全文最重要的部分：
//   普通消息       → 入库，in_surface=1
//   rewind         → 内容被撤回，从已收集里物理删除，一条不留
//   compaction     → 内容只是装不进上下文，**必须入库**，标 in_surface=0 + compacted_at
//
// ⚠ 实测修正（2026-11-17，对真实会话 qqb-p-0000000000 逐字段核对）
//
// IMPLEMENTATION.md §4 的伪代码有两处与真实日志不符，照抄会全部出错：
//
// ① rewind 的区间字段不是 `data.source.targetSeq`。
//    真实结构里 `data.source` 只有 `{ kind: 'dsh-rewind' }` 一个键，
//    区间在**事件顶层**的 `surfaceOp = { op:'replace', startSeq, endSeq }`。
//    本文件按 surfaceOp 优先、旧字段名兜底来读。
//
// ② 只靠文本前缀过滤系统注入会漏 2/3。
//    实测 user/message 共 2,658 条，其中 727 条是注入，三前缀规则只抓到 249 条，
//    漏掉 478 条（dsh-rewind 153 / tool-jobs 126 / random-wake 93 / runtime-context 53 /
//    model-selection 51 / wake-gate 2）。
//    真正可靠的判据是 `data.source.kind === 'user'`：实测 0 条误杀、0 条漏网。
//    三前缀规则保留作兜底（防未来版本改了 kind）。
//
// ③ 「消息是否真的发生过」只认 user/message 事件。
//    `agent/inbox/spliced` 会把消息投递进收件箱，但随后的 spliced（removed=1）
//    可能立刻把它撤掉，turn 以 `reason:{kind:'blocked'}` 结束——这条消息
//    **从没被看见、也没有回复**，日志里因此没有 user/message 事件。
//    实测本会话有 7 条这种「孤儿」真人消息（"hi"、「回复：在的」等），
//    它们不该入库：记忆库记的是发生过的事，没发生的不记。
//    本文件会把这类孤儿单独计数（inboxOrphans），不做假绿。
//
// 零依赖：只用 node 内置模块。

/** 系统注入文本的前缀（IMPLEMENTATION.md §4，作兜底用） */
export const SYSTEM_PREFIXES = Object.freeze([
  '<system-reminder>',
  'This is an automatically generated checkpoint',
  'Time sampled while preparing turn',
]);

/** 只有这个 source.kind 才是「真人说的话」 */
export const USER_SOURCE_KIND = 'user';

/** rewind 事件的 source.kind */
export const REWIND_SOURCE_KIND = 'dsh-rewind';

/**
 * 默认时区偏移：Asia/Shanghai = UTC+08:00。
 *
 * 为什么必须显式写死，不能依赖 `new Date(...)` 的机器本地时区：
 *   - 换一台时区不是 +08:00 的机器，`new Date(at).getDate()` 会算出不同的「日」，
 *     同一份日志导出结果就不一致了；
 *   - `Date.parse('2026-11-08')` 在 JS 里按 **UTC** 解释（不是本地！），
 *     会整整差 8 小时，把 11-08 00:00–08:00 那一段漏掉。
 * 所以：区间端点一律按固定偏移解析，与运行环境时区无关。
 */
export const DEFAULT_UTC_OFFSET = '+08:00';

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/**
 * 把「时刻」解析成 epoch 毫秒。
 *
 * 支持：
 *   - number            → 直接当 epoch ms
 *   - Date              → getTime()
 *   - `YYYY-MM-DD`      → 按 defaultOffset 解释的当天 00:00:00（**不是** UTC！）
 *   - 带时区的 ISO 串   → 按串里自带的时区
 *   - 不带时区的日期时间 → 按 defaultOffset 解释
 *
 * @param {unknown} v
 * @param {string} [defaultOffset] 默认 '+08:00'
 * @returns {number|null} 解析失败返回 null
 */
export function parseInstant(v, defaultOffset = DEFAULT_UTC_OFFSET) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v !== 'string') return null;

  const s = v.trim();
  if (!s) return null;

  // 纯日期：JS 会按 UTC 解释，必须自己补偏移（这是最容易错的坑）
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00${defaultOffset}`);
    return Number.isFinite(t) ? t : null;
  }

  // 已带时区标记（Z 或 ±HH:MM / ±HHMM）→ 就用它自己的
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  // 不带时区的日期时间 → 按 defaultOffset 解释，不跟机器时区走
  const t = Date.parse(`${s}${defaultOffset}`);
  if (Number.isFinite(t)) return t;
  const t2 = Date.parse(s);
  return Number.isFinite(t2) ? t2 : null;
}

/**
 * 归一化软排除区间：校验、排序、丢掉非法项。
 *
 * 区间语义是**左闭右开** `[from, to)`：
 *   { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00' }
 *   → 11-08 23:59:59.999 被排除，11-09 00:00:00.000 不排除。
 *
 * @param {Array<{from: unknown, to: unknown, reason?: string}>|null|undefined} ranges
 * @param {{ defaultOffset?: string, onWarn?: (msg: string) => void }} [opts]
 * @returns {{ from: number, to: number, reason: string|null }[]}
 */
export function normalizeExcludeRanges(ranges, opts = {}) {
  const defaultOffset = opts.defaultOffset ?? DEFAULT_UTC_OFFSET;
  const onWarn = opts.onWarn;
  if (!Array.isArray(ranges)) return [];

  const out = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (!r || typeof r !== 'object') {
      onWarn?.(`excludeRanges[${i}] 不是对象，已跳过`);
      continue;
    }
    const from = parseInstant(r.from, defaultOffset);
    const to = parseInstant(r.to, defaultOffset);
    if (from === null || to === null) {
      onWarn?.(`excludeRanges[${i}] 的 from/to 无法解析为时刻，已跳过`);
      continue;
    }
    if (to <= from) {
      onWarn?.(`excludeRanges[${i}] 的 to <= from，区间为空，已跳过`);
      continue;
    }
    out.push({
      from,
      to,
      reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : null,
    });
  }
  // 按起点排序，命中判定与展示都更稳
  out.sort((a, b) => a.from - b.from);
  return out;
}

/**
 * 判断一个时刻是否落在软排除区间里。
 *
 * @param {number} at epoch ms
 * @param {{from:number,to:number,reason?:string|null}[]} ranges 已归一化的区间
 * @returns {{from:number,to:number,reason?:string|null}|null} 命中返回该区间，否则 null
 */
export function matchExcludeRange(at, ranges) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  for (const r of ranges) {
    // 左闭右开
    if (at >= r.from && at < r.to) return r;
  }
  return null;
}

/**
 * 取某个时刻在指定时区里的「日 key」（YYYY-MM-DD）。
 * 纯算术，不依赖机器时区。
 *
 * @param {number} at epoch ms
 * @param {string} [offset] 默认 '+08:00'
 * @returns {string}
 */
export function dayKeyInZone(at, offset = DEFAULT_UTC_OFFSET) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  const sign = m?.[1] === '-' ? -1 : 1;
  const offMs = m ? sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
  const d = new Date(at + offMs);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 取事件的内容块数组。
 * 实测两种位置：user/message 在 data.content，assistant/message 在 data.message.content。
 *
 * @param {any} ev
 * @returns {any[]}
 */
export function contentBlocksOf(ev) {
  const c = ev?.data?.message?.content ?? ev?.data?.content;
  return Array.isArray(c) ? c : [];
}

/**
 * 只取 text 块并拼接（D-005：排除 reasoning / tool-call / tool-result / image）。
 * 原文一字不改，不 trim 中间内容。
 *
 * @param {any} ev
 * @returns {string}
 */
export function textBlocksOf(ev) {
  return contentBlocksOf(ev)
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 抽取事件里的图片/文件媒体块（D-005：只记位置/元信息，不把 base64 塞进库）。
 * 兼容 DSH / Anthropic / OpenAI 常见内容块形态。
 *
 * @param {any} ev
 * @returns {{path: string, sha256: string|null, width: number|null, height: number|null}[]}
 */
export function mediaBlocksOf(ev) {
  const out = [];
  for (const b of contentBlocksOf(ev)) {
    if (!b || typeof b !== 'object') continue;
    if (b.type !== 'image' && b.type !== 'image_url' && b.type !== 'file') continue;
    const att = b.attachment && typeof b.attachment === 'object' ? b.attachment : null;
    const attId = typeof att?.attachmentId === 'string' ? att.attachmentId.trim() : '';
    const inlineMime = att?.mediaType ?? b.source?.media_type ?? b.source?.mimeType ?? b.mimeType ?? b.mediaType ?? b.media_type;
    const hasInline =
      (b.source?.type === 'base64' && (b.source?.data || inlineMime)) ||
      typeof b.data === 'string' ||
      typeof b.image === 'string';
    const rawPath = b.path
      ?? b.filePath
      ?? b.file_path
      ?? b.url
      ?? b.uri
      ?? b.image_url?.url
      ?? b.source?.path
      ?? b.source?.url
      ?? b.source?.filePath
      ?? att?.path
      ?? att?.filePath
      ?? att?.url
      ?? (attId || null)
      ?? (hasInline ? `inline:${inlineMime || 'image'}` : null);
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
    // 绝不把巨型 data:image/...;base64,... 字符串写进 path 字段
    const trimmed = rawPath.trim();
    const safePath = trimmed.startsWith('data:')
      ? `inline:${trimmed.slice(5, trimmed.indexOf(';') > 5 ? trimmed.indexOf(';') : 32)}`
      : trimmed;
    const shaFromAtt = /^sha256:([a-f0-9]{64})$/i.test(attId) ? attId.slice(7).toLowerCase() : null;
    const sha = typeof (b.sha256 ?? b.hash ?? b.source?.sha256 ?? att?.sha256) === 'string'
      ? String(b.sha256 ?? b.hash ?? b.source?.sha256 ?? att?.sha256).trim() || shaFromAtt
      : shaFromAtt;
    const w = Number.isFinite(Number(b.width ?? att?.width)) ? Math.trunc(Number(b.width ?? att?.width)) : null;
    const h = Number.isFinite(Number(b.height ?? att?.height)) ? Math.trunc(Number(b.height ?? att?.height)) : null;
    out.push({ path: safePath, sha256: sha, width: w, height: h });
  }
  return out;
}

/**
 * 判断一段文本是否是系统注入（兜底规则）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSystemInjected(text) {
  return SYSTEM_PREFIXES.some((p) => text.startsWith(p));
}

// ═════════════════════════════════════════════════════════════
// 桥接元数据清洗
// ═════════════════════════════════════════════════════════════
//
// 问题：QQ 桥接层把每条用户消息套了一层「日志头」才交给模型：
//
//   【当前时间】2026/11/8 15:19:05（Asia/Shanghai）
//
//   【管理员】<他真正说的话>
//
// 这些字节对记忆库是纯噪声：
//   - 时间 → `msg.at` 已经有，而且精确到毫秒（前缀只到秒）
//   - 发送者 → `msg.speaker` 已经记录了
//   - 「（Asia/Shanghai）」→ 全局固定，零信息量
//
// 后果（实测这份会话）：935 条带着这个头，占 55,820 字。
// TA翻记忆时一半字符是时间戳，读起来像日志；而且查「2026」「Asia」
// 会命中一大堆无关条目，FTS 索引也白白膨胀。

/**
 * 桥接层注入的时间戳头（**必须完整匹配**才算元数据）。
 *
 * 实测格式（本会话 935 条全部匹配，0 条例外）：
 *   【当前时间】2026/11/8 15:19:05（Asia/Shanghai）
 *
 * 为什么要求「完整匹配 + 括号里有时区名」：
 *   用户完全可能自己发「【当前时间】你猜现在几点」这种正文。只认
 *   `【当前时间】` 四个字就剥，会把他的话吃掉；必须后面跟得出一个合法的
 *   Y/M/D H:m:s，且括号里有非空时区名，才判定是桥接注入。
 *
 * 注意这个正则只负责**形状**，数值合法性由 bridgeTimeHeadLength 校验 ——
 * 「2026/13/45 99:99:99」形状对但不是时间，不能剥。
 */
export const BRIDGE_TIME_HEAD_RE =
  /^【当前时间】(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?（([^）\n]+)）/;

/**
 * 校验并返回时间戳头的长度；不是合法桥接头返回 0。
 *
 * 「合法」= 形状匹配 **且** 年月日时分秒都在有效范围内。
 * 这一步保证 `【当前时间】2026/13/45 99:99:99（Mars/Zone）` 这种
 * 形状像时间的正文不会被误剥。
 *
 * @param {string} text
 * @returns {number} 头部字符数，0 表示不是桥接头
 */
export function bridgeTimeHeadLength(text) {
  if (typeof text !== 'string') return 0;
  const m = BRIDGE_TIME_HEAD_RE.exec(text);
  if (!m) return 0;
  const mon = Number(m[2]);
  const day = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  if (mon < 1 || mon > 12) return 0;
  if (day < 1 || day > 31) return 0;
  if (hh > 23 || mi > 59 || ss > 59) return 0;
  return m[0].length;
}

/**
 * 这段文本开头是不是桥接时间戳头。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isBridgeTimeHead(text) {
  return bridgeTimeHeadLength(text) > 0;
}

/** 发送者标记，只在时间戳头后面才剥（防误伤正文里的「【管理员】」） */
const BRIDGE_SENDER_RE = /^\n*【管理员】/;

/** 图片/表情的元数据整行 */
const BRIDGE_IMAGE_LINE_RE = /【图片\/表情】[^\n]*\n?/g;

/** [图片] 后面挂的元数据括号：动图参数 / 原图尺寸 / 获取失败 */
const BRIDGE_IMAGE_PAREN_RE = /（(?:动图|原图|获取失败)[^）]*）/g;

/** 带序号的一次性图片标记 [图片1] [图片2] */
const BRIDGE_IMAGE_INDEXED_RE = /\[图片\d+\]/g;

/** 图片占位标记（不带序号的那个） */
export const BRIDGE_IMAGE_TOKEN = '[图片]';

/**
 * 剥离桥接层注入的元数据前缀。
 *
 * 清洗不丢信息：时间已进 `msg.at`（更精确），发送者已进 `msg.speaker`。
 * 坏数据仍可从原始日志重导出（导出是幂等的）。
 *
 * 三条硬约束：
 *   ① **幂等**：清洗过的文本再清洗一次不变。
 *   ② **不误伤**：只有完整匹配桥接格式的才剥；用户自己发的「【重要】」
 *      「【当前时间】你猜几点」原样保留。
 *   ③ **图片占位不删**：`[图片]` 是「这里有张图」的唯一线索，
 *      只去掉后面的描述（动图参数 / 原图尺寸 / 获取失败 / 消息ID）。
 *
 * @param {string} text
 * @returns {{
 *   text: string,                 // 清洗后的文本
 *   timePrefixChars: number,      // 剥掉的时间戳头字符数（0 = 没剥）
 *   adminMarks: number,           // 剥掉的发送者标记数（0/1）
 *   imageDescChars: number,       // 图片描述剥掉的字符数
 *   hasImagePlaceholder: boolean, // 清洗后是否保留着图片占位
 * }}
 */
export function cleanBridgeMetadata(text) {
  const result = {
    text: typeof text === 'string' ? text : '',
    timePrefixChars: 0,
    adminMarks: 0,
    imageDescChars: 0,
    hasImagePlaceholder: false,
  };
  if (typeof text !== 'string' || !text) return result;

  let s = text;

  // ① 时间戳头：只在**开头**匹配，且必须是合法时间（含时区名）
  const headLen = bridgeTimeHeadLength(s);
  if (headLen > 0) {
    result.timePrefixChars = headLen;
    s = s.slice(headLen);
  }

  // ② 发送者标记：只有刚剥过时间戳头才剥。
  //    这样绝不会把正文中间的「【管理员】」当元数据 —— 实测有 2 条
  //    assistant 消息在正文里复述了用户的原文，带「【当前时间】…【管理员】」，
  //    它们不在消息开头，所以不受影响。
  if (result.timePrefixChars > 0) {
    const before = s.length;
    s = s.replace(BRIDGE_SENDER_RE, '');
    if (s.length !== before) result.adminMarks = 1;
  }

  // ③ 图片：先记下有没有占位，再删描述
  const hadImage = /\[图片\d*\]/.test(s);

  // ③a 【图片/表情】整行是纯元数据，直接删
  const beforeImg = s.length;
  s = s.replace(BRIDGE_IMAGE_LINE_RE, '');
  result.imageDescChars += beforeImg - s.length;

  // ③b [图片] 后面挂的括号描述（动图 N 帧 / 原图 W×H / 获取失败）→ 只留 [图片]
  const beforeParen = s.length;
  s = s.replace(BRIDGE_IMAGE_PAREN_RE, '');
  result.imageDescChars += beforeParen - s.length;

  // ③c 带序号的 [图片N]：已经有无序号占位就删（重复信息）；
  //     没有就把它归一成 [图片]，保证「这里有图」不丢
  const beforeIdx = s.length;
  if (s.includes(BRIDGE_IMAGE_TOKEN)) {
    s = s.replace(BRIDGE_IMAGE_INDEXED_RE, '');
  } else {
    s = s.replace(BRIDGE_IMAGE_INDEXED_RE, BRIDGE_IMAGE_TOKEN);
  }
  result.imageDescChars += beforeIdx - s.length;

  // ④ 收尾：去掉开头残留空行/空白，行尾空白也清掉。
  //    不动正文内部的换行结构（那是原话的一部分）。
  s = s.replace(/^\s+/, '');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n').trimEnd();

  // ⑤ 兜底：清洗完什么都不剩，但原文有图片 → 保留图片占位；
  //    没有图片就保留原文（宁可留噪声，也不能把一条消息清成空）
  if (!s.trim()) {
    s = hadImage ? BRIDGE_IMAGE_TOKEN : result.text;
  }

  result.text = s;
  result.hasImagePlaceholder = s.includes(BRIDGE_IMAGE_TOKEN);
  return result;
}

/**
 * 只取清洗后的文本（不需要统计时用这个）。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBridgeMetadata(text) {
  return cleanBridgeMetadata(text).text;
}

/**
 * 从 rewind 事件里取出被撤回的区间起点。
 *
 * 实测（本会话 153 次 rewind，全部核对过）：
 *   ev.surfaceOp = { op: 'replace', startSeq: 5027, endSeq: 5088 }
 *   ev.sourceEventSeqs = [5027, 5028, ...]  // 被替换掉的具体事件 seq
 *   ev.data.source = { kind: 'dsh-rewind' } // 只有 kind，没有 targetSeq
 *   ev.data.content = [{ type:'text', text:'(empty message)' }]
 *
 * 同时和 `command/done` 的文案「已撤回 seq N 及之后内容」交叉验证过，
 * 153/153 完全一致。
 *
 * @param {any} ev
 * @returns {{ start: number, end: number, via: string }|null}
 */
export function rewindRangeOf(ev) {
  const op = ev?.surfaceOp;
  if (op && typeof op === 'object' && op.op === 'replace' && typeof op.startSeq === 'number') {
    return {
      start: op.startSeq,
      end: typeof op.endSeq === 'number' ? op.endSeq : op.startSeq,
      via: 'surfaceOp',
    };
  }

  // 以下为兼容兜底：IMPLEMENTATION.md §4 写的字段名，实测本版本日志中不存在
  const d = ev?.data ?? {};
  const candidates = [d.source?.targetSeq, d.shadowedFrom, ev?.targetSeq, d.targetSeq];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      return { start: c, end: c, via: 'legacy-field' };
    }
  }
  return null;
}

/**
 * 判断一条 user/message 是不是 rewind 标记。
 *
 * @param {any} ev
 * @returns {boolean}
 */
export function isRewindEvent(ev) {
  return ev?.type === 'user/message' && ev?.data?.source?.kind === REWIND_SOURCE_KIND;
}

/**
 * 从 `command/done` 的中文文案里兜底解析撤回目标。
 * 只在找不到 dsh-rewind 事件时使用（文案随语言变，不能当主路径）。
 *
 * @param {any} ev
 * @returns {number|null}
 */
export function parseRewindFromCommandDone(ev) {
  if (ev?.type !== 'command/done') return null;
  const text = ev?.data?.text;
  if (typeof text !== 'string') return null;
  const m = text.match(/已撤回\s*seq\s*(\d+)/i) ?? text.match(/rewound\s*seq\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * 核心导出：从按 seq 升序的事件数组里重建可见消息。
 *
 * @param {any[]} events  按 seq 升序的事件数组
 * @param {{
 *   sessionId?: string,
 *   includeRewound?: boolean,
 *   excludeRanges?: Array<{from: unknown, to: unknown, reason?: string}>,
 *   defaultOffset?: string,
 *   onWarn?: (msg: string) => void,
 *   cleanMetadata?: boolean,
 * }} [opts]
 *   includeRewound=true 时额外返回被 rewind 掉的消息（只做统计/审计用，绝不入库）
 *   excludeRanges 是**软排除**区间（D-169/170）：命中的消息仍然入库，
 *   只打 `excluded=1` 标记，检索时过滤掉。**不丢弃**。
 *   cleanMetadata=false 可关掉桥接元数据清洗（默认开），只用于对比排查。
 * @returns {{
 *   messages: any[],       // 要入库的：{ session_id, seq, at, speaker, text, in_surface, compacted_at, excluded }
 *   rewound: any[],        // 被 rewind 掉的（仅审计）
 *   media?: any[],
 *   stats: Record<string, any>
 * }}
 */
export function exportMessages(events, opts = {}) {
  const sessionId = opts.sessionId ?? null;
  const includeRewound = opts.includeRewound === true;
  const cleanMetadata = opts.cleanMetadata !== false;
  const defaultOffset = opts.defaultOffset ?? DEFAULT_UTC_OFFSET;
  const excludeRanges = normalizeExcludeRanges(opts.excludeRanges, {
    defaultOffset,
    onWarn: opts.onWarn,
  });

  /** @type {any[]} 存活消息，按 seq 升序 */
  const visible = [];
  /** @type {any[]} 被 rewind 掉的，仅审计 */
  const rewound = [];

  /** seq -> 该次压缩的时间戳 */
  const compactedAt = new Map();

  // 统计
  const stats = {
    eventsSeen: 0,
    rewindEvents: 0,
    rewindRanges: [],
    rewoundCount: 0,
    rewoundChars: 0,
    compactionSummaries: 0,
    compactionStarts: 0,
    compactionFailed: 0,
    shadowedSeqTotal: 0,
    shadowedSeqUnique: 0,
    // 过滤原因
    skippedSystemByKind: 0,
    skippedSystemByPrefix: 0,
    skippedRewindMarker: 0,
    skippedEmptyText: 0,
    skippedNoTextBlock: 0,
    // 分来源计数
    userSourceKinds: {},
    // 消息数
    userMessages: 0,
    assistantMessages: 0,
    // inbox 孤儿（投递了但 turn blocked，从没发生过的真人消息）
    inboxInsertedUserIds: 0,
    inboxOrphans: 0,
    inboxOrphanChars: 0,
    inboxOrphanSamples: [],
    // 按日期软排除（D-169/170）
    excludeRanges: excludeRanges.map((r) => ({ ...r })),
    excludedCount: 0,
    excludedChars: 0,
    excludedCharsBeforeClean: 0,
    excludedHits: excludeRanges.map((r) => ({
      from: r.from,
      to: r.to,
      reason: r.reason,
      count: 0,
      chars: 0,
      charsBeforeClean: 0,
    })),
    // 桥接元数据清洗
    metadataCleaned: cleanMetadata,
    bridgeTimePrefixCount: 0,   // 剥掉时间戳头的条数
    bridgeTimePrefixChars: 0,   // 剥掉的时间戳头字符数
    bridgeAdminMarks: 0,        // 剥掉的发送者标记次数
    bridgeImageDescCount: 0,    // 处理过图片描述的消息条数
    bridgeImageDescChars: 0,    // 图片描述剥掉的字符数
    bridgeImagePlaceholders: 0, // 保留了图片占位的消息条数
    charsBeforeClean: 0,        // 清洗前字数（仅统计被清洗的那些消息）
    charsAfterClean: 0,         // 清洗后字数
  };

  /**
   * 对一段文本做桥接元数据清洗。
   * 只返回清洗结果与原文长度，**累计到统计里的事留到最后做** ——
   * 因为后面可能还有 rewind 把这些消息删掉，中途累加会让分母虚高。
   *
   * @param {string} text
   * @returns {{ text: string, clean: any, charsBefore: number }}
   */
  function applyBridgeClean(text) {
    const r = cleanBridgeMetadata(text);
    return { text: r.text, clean: r, charsBefore: text.length };
  }

  const shadowedAll = new Set();
  // 记录每次压缩成功的 compactionId，用于识别失败的压缩
  const failedCompactionIds = new Set();

  // 收件箱投递记录：id -> 文本。用来识别「投递了但从没进 user/message」的孤儿消息
  const inboxUserMsgs = new Map();
  const surfaceUserMsgIds = new Set();

  for (const ev of events) {
    stats.eventsSeen++;

    // 收件箱投递（不产生消息，只做孤儿审计用）
    if (ev.type === 'agent/inbox/spliced') {
      for (const m of ev.data?.inserted ?? []) {
        if (m?.role !== 'user') continue;
        if (m?.source?.kind !== USER_SOURCE_KIND) continue; // 注入不算
        if (!m.id) continue;
        const t = Array.isArray(m.content)
          ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          : '';
        if (t.trim()) inboxUserMsgs.set(m.id, { text: t, splicedSeq: ev.seq });
      }
      continue;
    }

    switch (ev.type) {
      // ─────────────────────────────────────────────
      // ① rewind：内容被撤回 → 从已收集里删掉（物理删除语义，一条不留）
      // ─────────────────────────────────────────────
      case 'user/message': {
        if (isRewindEvent(ev)) {
          stats.rewindEvents++;
          const r = rewindRangeOf(ev);
          if (!r) break; // 拿不到区间就跳过，不猜

          stats.rewindRanges.push({ at: ev.seq, from: r.start, to: r.end, via: r.via });

          // 把 seq >= start 的全部丢掉（rewind 语义是「seq X 及之后」）
          for (let i = visible.length - 1; i >= 0; i--) {
            if (visible[i].seq >= r.start) {
              const [gone] = visible.splice(i, 1);
              if (gone.speaker === 'user') stats.userMessages--;
              else if (gone.speaker === 'assistant') stats.assistantMessages--;
              stats.rewoundCount++;
              stats.rewoundChars += gone.text.length;
              if (includeRewound) rewound.push({ ...gone, rewound_by_seq: ev.seq });
            }
          }
          // rewind 标记本身不入库
          stats.skippedRewindMarker++;
          break;
        }

        // 普通用户消息：只有 source.kind === 'user' 才是真人说的
        const kind = ev.data?.source?.kind ?? '(none)';
        stats.userSourceKinds[kind] = (stats.userSourceKinds[kind] ?? 0) + 1;

        // 记账：这条投递最终真的成了消息（不是孤儿）
        if (typeof ev.data?.id === 'string') surfaceUserMsgIds.add(ev.data.id);

        if (kind !== USER_SOURCE_KIND) {
          stats.skippedSystemByKind++;
          break;
        }

        const text = textBlocksOf(ev);
        const uMedia = mediaBlocksOf(ev);
        if (!text.trim() && uMedia.length === 0) {
          stats.skippedEmptyText++;
          break;
        }
        // 兜底：kind 说是用户但文本像注入（防未来版本改 kind）
        if (text.trim() && isSystemInjected(text)) {
          stats.skippedSystemByPrefix++;
          break;
        }

        stats.userMessages++;
        const uClean = cleanMetadata && text.trim() ? applyBridgeClean(text) : null;
        const uText = uClean
          ? uClean.text
          : (text.trim() ? text : (uMedia.length > 1 ? `${BRIDGE_IMAGE_TOKEN}×${uMedia.length}` : BRIDGE_IMAGE_TOKEN));
        visible.push({
          seq: ev.seq,
          at: ev.time,
          speaker: 'user',
          // 桥接元数据清洗：时间/发送者已进结构化字段，正文里的是噪声
          text: uText,
          ...(uMedia.length ? { _media: uMedia } : {}),
          ...(uClean ? { _clean: uClean.clean, _charsBefore: uClean.charsBefore } : {}),
        });
        break;
      }

      // ─────────────────────────────────────────────
      // 普通 assistant 消息
      // ─────────────────────────────────────────────
      case 'assistant/message': {
        const blocks = contentBlocksOf(ev);
        const text = textBlocksOf(ev);
        const aMedia = mediaBlocksOf(ev);

        if (!text.trim() && aMedia.length === 0) {
          // 实测 1,107 条 assistant/message 只有 reasoning + tool-call，没有正文
          if (blocks.length === 0) stats.skippedEmptyText++;
          else stats.skippedNoTextBlock++;
          break;
        }
        if (text.trim() && isSystemInjected(text)) {
          stats.skippedSystemByPrefix++;
          break;
        }

        stats.assistantMessages++;
        const aClean = cleanMetadata && text.trim() ? applyBridgeClean(text) : null;
        const aText = aClean
          ? aClean.text
          : (text.trim() ? text : (aMedia.length > 1 ? `${BRIDGE_IMAGE_TOKEN}×${aMedia.length}` : BRIDGE_IMAGE_TOKEN));
        visible.push({
          seq: ev.seq,
          at: ev.time,
          speaker: 'assistant',
          // assistant 正常不带桥接头；仍走一遍（幂等，且能清掉它复述的图片描述）
          text: aText,
          ...(aMedia.length ? { _media: aMedia } : {}),
          ...(aClean ? { _clean: aClean.clean, _charsBefore: aClean.charsBefore } : {}),
        });
        break;
      }

      // ─────────────────────────────────────────────
      // ② compaction：不删除，只标记（D-141 —— 这些正是最该记住的）
      // ─────────────────────────────────────────────
      case 'compaction/start':
        stats.compactionStarts++;
        break;

      case 'compaction/end': {
        // 失败的压缩没有 summary，要单独记下来，别当成「压了但没内容」
        if (ev.data?.error) {
          stats.compactionFailed++;
          if (ev.data.compactionId) failedCompactionIds.add(ev.data.compactionId);
        }
        break;
      }

      case 'compaction/summary': {
        stats.compactionSummaries++;
        const d = ev.data ?? {};
        // 失败的那次不会有 summary；保险起见再按 compactionId 排一次
        if (d.compactionId && failedCompactionIds.has(d.compactionId)) break;

        const seqs = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs : [];
        stats.shadowedSeqTotal += seqs.length;
        for (const s of seqs) {
          if (typeof s !== 'number') continue;
          shadowedAll.add(s);
          // 同一个 seq 被多次压缩覆盖时，保留**最早**那次的压缩时间
          // （它第一次掉出上下文的时间，才是「TA眼前第一次看不到它」的时刻）
          if (!compactedAt.has(s)) compactedAt.set(s, ev.time);
        }
        break;
      }

      default:
        break;
    }
  }

  stats.shadowedSeqUnique = shadowedAll.size;

  // ─────────────────────────────────────────────
  // inbox 孤儿审计：投递进收件箱、却从没变成消息的真人发言
  // （turn 被 blocked，TA根本没看见、也没回 —— 没发生过的事不入库）
  // ─────────────────────────────────────────────
  stats.inboxInsertedUserIds = inboxUserMsgs.size;
  for (const [id, rec] of inboxUserMsgs) {
    if (surfaceUserMsgIds.has(id)) continue;
    stats.inboxOrphans++;
    stats.inboxOrphanChars += rec.text.length;
    if (stats.inboxOrphanSamples.length < 10) {
      stats.inboxOrphanSamples.push({ splicedSeq: rec.splicedSeq, chars: rec.text.length, text: rec.text.slice(0, 80) });
    }
  }

  // ─────────────────────────────────────────────
  // 回填 in_surface / compacted_at / excluded
  // ─────────────────────────────────────────────
  let shadowedMsgCount = 0;
  let shadowedMsgChars = 0;
  let surfaceMsgCount = 0;
  let surfaceMsgChars = 0;
  let totalChars = 0;

  for (const m of visible) {
    const hit = compactedAt.has(m.seq);
    m.in_surface = hit ? 0 : 1;
    m.compacted_at = hit ? compactedAt.get(m.seq) : null;
    if (sessionId) m.session_id = sessionId;

    // 清洗统计只算**最终真的入库**的消息 —— 中途被 rewind 删掉的不进分母，
    // 否则「原 X 字」会包含已撤销内容，和总字数对不上。
    if (m._clean) {
      const cl = m._clean;
      stats.charsBeforeClean += m._charsBefore ?? m.text.length;
      stats.charsAfterClean += m.text.length;
      if (cl.timePrefixChars > 0) {
        stats.bridgeTimePrefixCount++;
        stats.bridgeTimePrefixChars += cl.timePrefixChars;
      }
      stats.bridgeAdminMarks += cl.adminMarks;
      if (cl.imageDescChars > 0) {
        stats.bridgeImageDescCount++;
        stats.bridgeImageDescChars += cl.imageDescChars;
      }
      if (cl.hasImagePlaceholder) stats.bridgeImagePlaceholders++;
    }

    // 按日期软排除（D-169/170）：只打标记，绝不丢弃。
    // 落在第一个命中的区间即可（区间可能重叠，避免重复计数）。
    let ex = null;
    if (excludeRanges.length) {
      ex = matchExcludeRange(m.at, excludeRanges);
      m.excluded = ex ? 1 : 0;
      if (ex) {
        stats.excludedCount++;
        stats.excludedChars += m.text.length;
        // 清洗前的字数也记一份，方便和历史口径对照
        stats.excludedCharsBeforeClean += m._charsBefore ?? m.text.length;
        const slot = stats.excludedHits.find((h) => h.from === ex.from && h.to === ex.to);
        if (slot) {
          slot.count++;
          slot.chars += m.text.length;
          slot.charsBeforeClean += m._charsBefore ?? m.text.length;
        }
      }
    } else {
      m.excluded = 0;
    }

    totalChars += m.text.length;
    if (hit) {
      shadowedMsgCount++;
      shadowedMsgChars += m.text.length;
    } else {
      surfaceMsgCount++;
      surfaceMsgChars += m.text.length;
    }
  }

  // 只保留入库需要的字段，且顺序稳定（T1 直接照着插）
  const messages = visible.map((m) => ({
    session_id: m.session_id ?? sessionId,
    seq: m.seq,
    at: m.at,
    speaker: m.speaker,
    text: m.text,
    in_surface: m.in_surface,
    compacted_at: m.compacted_at,
    excluded: m.excluded ?? 0,
  }));

  const media = [];
  for (const m of visible) {
    if (!Array.isArray(m._media) || m._media.length === 0) continue;
    for (const item of m._media) {
      media.push({
        seq: m.seq,
        at: m.at,
        path: item.path,
        sha256: item.sha256 ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
      });
    }
  }

  const times = messages.map((m) => m.at).filter((t) => typeof t === 'number');

  let timeMin = times.length ? times[0] : null;
  let timeMax = times.length ? times[0] : null;
  for (let i = 1; i < times.length; i++) {
    if (times[i] < timeMin) timeMin = times[i];
    if (times[i] > timeMax) timeMax = times[i];
  }

  return {
    messages,
    rewound,
    media,
    stats: {
      ...stats,
      // 汇总
      totalMessages: messages.length,
      totalChars,
      inSurface1Count: surfaceMsgCount,
      inSurface1Chars: surfaceMsgChars,
      inSurface0Count: shadowedMsgCount,
      inSurface0Chars: shadowedMsgChars,
      // 这个比例是整个项目的价值定位依据
      inSurface0CharRatio: totalChars > 0 ? shadowedMsgChars / totalChars : 0,
      inSurface0MsgRatio: messages.length > 0 ? shadowedMsgCount / messages.length : 0,
      timeMin,
      timeMax,
      // 软排除汇总（与 in_surface 正交：一个消息可以既被压缩又被排除）
      excludedCharRatio: totalChars > 0 ? stats.excludedChars / totalChars : 0,
      excludedMsgRatio: messages.length > 0 ? stats.excludedCount / messages.length : 0,
      // 实际可检索的条数/字数（入库但检索不到的不算）
      searchableCount: messages.length - stats.excludedCount,
      searchableChars: totalChars - stats.excludedChars,
      // 桥接元数据清洗的净效果
      totalCharsBeforeClean: stats.charsBeforeClean || totalChars,
      cleanedCharRatio: stats.charsBeforeClean > 0
        ? 1 - stats.charsAfterClean / stats.charsBeforeClean
        : 0,
    },
  };
}

/**
 * 粗估场景数：按相邻消息间隔 > 30 分钟切。
 * 真正的切分在 T3（src/scene/），这里只给 CLI 一个数量级参考。
 *
 * @param {{at:number}[]} messages
 * @param {number} [gapMs]
 * @returns {{ scenes: number, gapMs: number }}
 */
export function estimateSceneCount(messages, gapMs = 30 * 60_000) {
  if (!messages.length) return { scenes: 0, gapMs };
  let scenes = 1;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].at - messages[i - 1].at > gapMs) scenes++;
  }
  return { scenes, gapMs };
}

/**
 * 把 messages 序列化成 JSONL（给 T1 入库用，一行一条）。
 *
 * @param {object[]} messages
 * @returns {string}
 */
export function toJsonLines(messages) {
  return messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
}
