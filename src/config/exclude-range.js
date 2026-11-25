// exclude-range.js —— 软排除区间（D-169 / D-170 / D-172 / D-176）
//
// 职责只有四件：把配置里「人写的日期」解析成时刻、校验、判断命中、统计。
//
// ⚠ 与 T2（src/ingest/export.js）的关系：**同一套时间语义，直接复用，不重写**。
//   parseInstant / matchExcludeRange / dayKeyInZone 全部从 T2 那边 import。
//   理由：时区只要有两份实现，就一定有一天会各算一个日子（D-172 实测差 8 小时，
//   多排掉 11-09 00:00–08:00 的 16 条）。
//
// 那本文件多做了什么？**只多一层「严格校验」**，因为两条路径的失败策略本来就不同：
//   - 数据路径（导出日志）遇到坏区间 → T2 的策略是「跳过 + 告警」，不能中断整场导出；
//   - 配置路径（人手写的 JSON）遇到坏区间 → 必须「报明确错误」，静默少排一天没人会发现。
// 所以：解析实现共用，校验严格度不同。
//
// 三条硬规则（D-172）：
//   ① 纯日期 `2026-11-08` 按 **+08:00** 解释，不是 Date.parse 默认的 UTC；
//   ② 不带时区的日期时间也按 +08:00；
//   ③ 带时区的（Z / ±HH:MM）尊重原串自带的时区。
// 另外补一条 T2 的宽松解析会让过的坑：机器本地时区。`2026/11/08` 这类写法
// T2 会落到 `Date.parse(s)` 兜底（= 机器本地时区），本文件**直接拒收**，
// 见 parseInstantStrict。

import {
  DEFAULT_UTC_OFFSET,
  parseInstant,
  matchExcludeRange,
  dayKeyInZone,
} from '../ingest/export.js';

// 把 T2 的两个工具原样再导出一份，调用方（面板 / 管线）不必知道它们住在 ingest 里
export { DEFAULT_UTC_OFFSET, dayKeyInZone };

const DAY_MS = 86_400_000;

/** 纯日期：2026-11-08 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO 日期时间，时区可选：2026-11-08T00:00、2026-11-08 00:00:00.000、...+08:00、...Z */
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * 配置类错误。
 *
 * 为什么要单独一个类：调用方（面板 RPC / 管线）要把「配置写错了」与
 * 「磁盘坏了」「JSON 语法坏了」区分开，前者该原样提示给用户改配置。
 */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, path?: string|null }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ConfigError';
    /** 机器可读的错误码：CONFIG_INVALID / CONFIG_INVALID_JSON / CONFIG_READ_FAILED / CONFIG_WRITE_FAILED */
    this.code = info.code ?? 'CONFIG_INVALID';
    /** 出问题的字段路径，例如 `excludeRanges[0].from` 或配置文件绝对路径 */
    this.path = info.path ?? null;
  }
}

/** 给错误信息用的类型名 */
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  if (v instanceof Date) return 'Date';
  return typeof v;
}

/** 补零 */
function pad(v, n = 2) {
  return String(v).padStart(n, '0');
}

/**
 * 把 '+08:00' / '+0800' / 'Z' 归一成 '$1:$2' 形式并算成毫秒偏移。
 * 纯算术，不碰 Intl（D-176）。
 *
 * @param {string} [offset]
 * @returns {number}
 */
function offsetMsOf(offset = DEFAULT_UTC_OFFSET) {
  if (offset === 'Z' || offset === 'z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/** 归一化时区写法：'Z' → '+00:00'，'+0800' → '+08:00' */
function normalizeOffsetToken(token, fallback) {
  if (!token) return fallback;
  if (token === 'Z' || token === 'z') return '+00:00';
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(token);
  return m ? `${m[1]}${m[2]}:${m[3]}` : fallback;
}

/**
 * 算出某时刻在指定偏移下「当天已过了多少毫秒」。
 * @param {number} at
 * @param {string} offset
 * @returns {number} [0, 86400000)
 */
function msIntoDay(at, offset) {
  const local = at + offsetMsOf(offset);
  return ((local % DAY_MS) + DAY_MS) % DAY_MS;
}

/**
 * 严格解析「时刻」。配置专用，比 T2 的 parseInstant 严格：
 *   - 只接受 `YYYY-MM-DD`、`YYYY-MM-DDTHH:mm[:ss[.SSS]]`（时区可有可无）、epoch 毫秒、Date；
 *   - 不接受 `2026/11/08`、`11-08`、中文时间词 —— 这些在 JS 里会落到机器本地时区（D-172）；
 *   - 不接受「不存在的日期/时刻」（2 月 30 日、24:00），V8 会悄悄进位到下一天，
 *     这里用纯算术回验，进位的直接报错。
 *
 * @param {unknown} value
 * @param {{ path?: string, defaultOffset?: string }} [opts]
 * @returns {number} epoch 毫秒
 * @throws {ConfigError}
 */
export function parseInstantStrict(value, opts = {}) {
  const at = opts.path ?? 'value';
  const defaultOffset = opts.defaultOffset ?? DEFAULT_UTC_OFFSET;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ConfigError(`${at}：数字不是有限值（收到 ${value}）`, { path: at });
    }
    return value;
  }

  if (value instanceof Date) {
    const t = value.getTime();
    if (!Number.isFinite(t)) {
      throw new ConfigError(`${at}：Date 是 Invalid Date`, { path: at });
    }
    return t;
  }

  if (typeof value !== 'string') {
    throw new ConfigError(
      `${at}：期望字符串（YYYY-MM-DD 或 ISO 日期时间）或 epoch 毫秒数字，实际是 ${typeName(value)}`,
      { path: at },
    );
  }

  const s = value.trim();
  if (!s) {
    throw new ConfigError(`${at}：是空字符串`, { path: at });
  }

  const dateOnly = DATE_ONLY_RE.exec(s);
  const dateTime = dateOnly ? null : DATE_TIME_RE.exec(s);
  if (!dateOnly && !dateTime) {
    throw new ConfigError(
      `${at}：无法解析为时刻（收到 ${JSON.stringify(value)}）。` +
        '只接受 YYYY-MM-DD、YYYY-MM-DDTHH:mm[:ss[.SSS]] 或带时区的 ISO 串' +
        '（如 2026-11-08T00:00:00+08:00）。' +
        '不接受 2026/11/08、11-08 这类写法——JS 会把它们按机器本地时区解释（D-172）',
      { path: at },
    );
  }

  // 真正的解析交给 T2，时区语义只此一份
  const t = parseInstant(s, defaultOffset);
  if (t === null || !Number.isFinite(t)) {
    throw new ConfigError(
      `${at}：看起来像日期，但不是真实时刻（收到 ${JSON.stringify(value)}），请检查年月日时分秒是否越界`,
      { path: at },
    );
  }

  // ── 纯算术回验：V8 会把 2026-02-30 悄悄进位到 03-02、24:00 进位到次日 ──
  const parts = dateOnly ?? dateTime;
  const [y, mo, d] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const offset = dateOnly
    ? defaultOffset
    : normalizeOffsetToken(dateTime[8], defaultOffset);

  const wantDay = `${y}-${pad(mo)}-${pad(d)}`;
  const gotDay = dayKeyInZone(t, offset);
  if (gotDay !== wantDay) {
    throw new ConfigError(
      `${at}：${wantDay} 这一天不存在（解析后得到 ${gotDay}）。` +
        'JS 会把 2 月 30 日、4 月 31 日这类日期悄悄进位，本配置拒收',
      { path: at },
    );
  }

  if (dateTime) {
    const h = Number(dateTime[4]);
    const mi = Number(dateTime[5]);
    const se = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
    const ms = dateTime[7] === undefined ? 0 : Number(dateTime[7].padEnd(3, '0').slice(0, 3));
    const gotMs = msIntoDay(t, offset);
    const gotH = Math.floor(gotMs / 3_600_000);
    const gotMi = Math.floor((gotMs % 3_600_000) / 60_000);
    const gotSe = Math.floor((gotMs % 60_000) / 1000);
    const gotMsec = gotMs % 1000;
    if (h > 23 || mi > 59 || se > 59 || gotH !== h || gotMi !== mi || gotSe !== se || gotMsec !== ms) {
      throw new ConfigError(
        `${at}：${s} 不是一个真实时刻（解析后落在 ${pad(gotH)}:${pad(gotMi)}:${pad(gotSe)}.${pad(gotMsec, 3)}）。` +
          '小时必须 00–23、分秒必须 00–59；24:00 表示次日，请直接写次日',
        { path: at },
      );
    }
  }

  return t;
}

/**
 * 校验并归一化排除区间。
 *
 * 语义**左闭右开** `[from, to)`（D-169）：
 *   11-08T00:00:00+08:00 ~ 11-09T00:00:00+08:00
 *   → 11-08 23:59:59.999 被排除，11-09 00:00:00.000 不排除。
 *
 * 与 T2 的 normalizeExcludeRanges 的差别只有一条：**这里不静默跳过**，
 * 非法的区间一律抛 ConfigError，并指明是第几个区间的哪个字段。
 *
 * @param {Array<{from: unknown, to: unknown, reason?: string}>|null|undefined} ranges
 * @param {{ path?: string, defaultOffset?: string }} [opts]
 * @returns {Array<{from:number, to:number, reason:string|null, fromText:string|null, toText:string|null}>}
 * @throws {ConfigError}
 */
export function normalizeRanges(ranges, opts = {}) {
  const at = opts.path ?? 'excludeRanges';
  const defaultOffset = opts.defaultOffset ?? DEFAULT_UTC_OFFSET;

  if (ranges === undefined || ranges === null) return [];
  if (!Array.isArray(ranges)) {
    throw new ConfigError(`${at}：必须是数组，实际是 ${typeName(ranges)}`, { path: at });
  }

  const out = [];
  for (let i = 0; i < ranges.length; i++) {
    const item = ranges[i];
    const itemPath = `${at}[${i}]`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConfigError(
        `${itemPath}：必须是对象 { from, to, reason? }，实际是 ${typeName(item)}`,
        { path: itemPath },
      );
    }
    if (!('from' in item)) {
      throw new ConfigError(`${itemPath}：缺少 from 字段`, { path: `${itemPath}.from` });
    }
    if (!('to' in item)) {
      throw new ConfigError(`${itemPath}：缺少 to 字段`, { path: `${itemPath}.to` });
    }

    const from = parseInstantStrict(item.from, { path: `${itemPath}.from`, defaultOffset });
    const to = parseInstantStrict(item.to, { path: `${itemPath}.to`, defaultOffset });

    if (to < from) {
      throw new ConfigError(
        `${itemPath}：to 早于 from，区间为空（from=${JSON.stringify(item.from)}，to=${JSON.stringify(item.to)}）`,
        { path: itemPath },
      );
    }
    if (to === from) {
      throw new ConfigError(
        `${itemPath}：from 与 to 相同，区间为空（左闭右开，to 本身不在区间内）`,
        { path: itemPath },
      );
    }

    let reason = null;
    if (item.reason !== undefined && item.reason !== null) {
      if (typeof item.reason !== 'string') {
        throw new ConfigError(
          `${itemPath}.reason：必须是字符串，实际是 ${typeName(item.reason)}`,
          { path: `${itemPath}.reason` },
        );
      }
      const r = item.reason.trim();
      reason = r ? r : null;
    }

    out.push({
      from,
      to,
      reason,
      // 原串留着给面板显示（人写什么就显示什么）
      fromText: typeof item.from === 'string' ? item.from.trim() : null,
      toText: typeof item.to === 'string' ? item.to.trim() : null,
    });
  }

  // 按起点排序：命中判定与面板展示都更稳
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

/**
 * 判断一个区间数组是不是已经归一化过（from/to 都是数字）。
 * @param {unknown} ranges
 * @returns {boolean}
 */
export function isNormalizedRanges(ranges) {
  return (
    Array.isArray(ranges) &&
    ranges.every(
      (r) =>
        r &&
        typeof r === 'object' &&
        typeof r.from === 'number' &&
        Number.isFinite(r.from) &&
        typeof r.to === 'number' &&
        Number.isFinite(r.to),
    )
  );
}

/** 需要时才归一化，避免在循环里重复校验 */
function toNormalized(ranges, opts) {
  if (isNormalizedRanges(ranges)) return ranges;
  return normalizeRanges(ranges, opts);
}

/**
 * 找出某个时刻命中的区间（第一个命中即返回）。
 * 命中判定直接复用 T2 的 matchExcludeRange（左闭右开）。
 *
 * @param {number} at epoch 毫秒
 * @param {Array<{from:unknown,to:unknown,reason?:string}>|Array<{from:number,to:number}>} ranges
 *   配置原样（字符串）或归一化后的都行
 * @param {{ path?: string }} [opts]
 * @returns {{from:number, to:number, reason?:string|null}|null} 命中返回该区间，否则 null
 * @throws {ConfigError} 区间非法时（配置错误必须抛，不能静默不排除）
 */
export function findRange(at, ranges, opts = {}) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const norm = toNormalized(ranges, opts);
  return matchExcludeRange(at, norm);
}

/**
 * 判断某个时刻是否被排除。
 *
 * @param {number} at epoch 毫秒
 * @param {Array<{from:unknown,to:unknown,reason?:string}>|Array<{from:number,to:number}>} ranges
 * @param {{ path?: string }} [opts]
 * @returns {boolean}
 * @throws {ConfigError} 区间非法时
 */
export function isExcluded(at, ranges, opts = {}) {
  return findRange(at, ranges, opts) !== null;
}

/**
 * 统计排除量（不修改入参）。
 * 面板统计条「按日期排除 N 条 / M 字」用这个（D-170 / PANEL.md §3.2）。
 *
 * @param {{at:number, text?:string}[]} messages
 * @param {Array<{from:unknown,to:unknown,reason?:string}>|Array<{from:number,to:number}>} ranges
 * @param {{ path?: string }} [opts]
 * @returns {{
 *   count: number, chars: number, totalCount: number, totalChars: number,
 *   ranges: Array<{from:number,to:number,reason:string|null,fromText:string|null,toText:string|null,count:number,chars:number}>
 * }}
 * @throws {ConfigError} 区间非法时
 */
export function summarizeExclusions(messages, ranges, opts = {}) {
  return collectExclusions(messages, ranges, opts, false);
}

/**
 * 给每条消息打 `excluded` 标记（0/1），**就地修改**入参，并返回统计。
 * 与 D-173 一致：`excluded` 与 `in_surface` 正交，两个数不能相加。
 *
 * @param {object[]} messages 每条至少要有 `at`（epoch 毫秒），可选 `text`
 * @param {Array<{from:unknown,to:unknown,reason?:string}>|Array<{from:number,to:number}>} ranges
 * @param {{ path?: string }} [opts]
 * @returns {{
 *   count: number, chars: number, totalCount: number, totalChars: number,
 *   ranges: Array<{from:number,to:number,reason:string|null,fromText:string|null,toText:string|null,count:number,chars:number}>
 * }}
 * @throws {ConfigError} 区间非法时
 */
export function applyExclusions(messages, ranges, opts = {}) {
  return collectExclusions(messages, ranges, opts, true);
}

/** summarizeExclusions / applyExclusions 的共同实现 */
function collectExclusions(messages, ranges, opts, mutate) {
  const norm = toNormalized(ranges, opts);
  const list = Array.isArray(messages) ? messages : [];

  const rangesOut = norm.map((r) => ({
    from: r.from,
    to: r.to,
    reason: r.reason ?? null,
    fromText: r.fromText ?? null,
    toText: r.toText ?? null,
    count: 0,
    chars: 0,
  }));

  let count = 0;
  let chars = 0;
  let totalChars = 0;

  for (const m of list) {
    const text = typeof m?.text === 'string' ? m.text : '';
    totalChars += text.length;

    const hit = norm.length ? matchExcludeRange(m?.at, norm) : null;
    if (mutate && m && typeof m === 'object') m.excluded = hit ? 1 : 0;

    if (hit) {
      count++;
      chars += text.length;
      const slot = rangesOut[norm.indexOf(hit)];
      if (slot) {
        slot.count++;
        slot.chars += text.length;
      }
    }
  }

  return { count, chars, totalCount: list.length, totalChars, ranges: rangesOut };
}

/**
 * 千分位，手写不用 Intl（D-176：面板数字也要在任何机器上一致）。
 * @param {number} n
 * @returns {string}
 */
export function formatCount(n) {
  const s = String(Math.trunc(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}

/**
 * 面板统计条文案：`按日期排除 327 条 / 21,264 字`。
 * D-174：用绝对数，不写百分比。
 *
 * @param {{count:number, chars:number}} summary summarizeExclusions / applyExclusions 的返回
 * @returns {string}
 */
export function formatExcludedSummary(summary) {
  const count = summary?.count ?? 0;
  const chars = summary?.chars ?? 0;
  return `按日期排除 ${formatCount(count)} 条 / ${formatCount(chars)} 字`;
}

/**
 * 生成「某一天」的排除区间（面板上加一天、或手写配置时用）。
 *
 * 返回的是可以直接写进 `sessions/<id>.json` 的字符串（时区固定为 offset），
 * 不是 epoch 数字——配置文件要保持人能读懂。
 *
 * @param {string|number} day '2026-11-08'（或任意可解析时刻，取其所在日）
 * @param {{ path?: string, defaultOffset?: string }} [opts]
 * @returns {{from: string, to: string, fromMs: number, toMs: number, reason: null}}
 * @throws {ConfigError}
 */
export function dayRange(day, opts = {}) {
  const offset = opts.defaultOffset ?? DEFAULT_UTC_OFFSET;
  const at = parseInstantStrict(day, { path: opts.path ?? 'day', defaultOffset: offset });
  const dayKey = dayKeyInZone(at, offset);
  const fromMs = parseInstantStrict(`${dayKey}T00:00:00${offset}`, {
    path: opts.path ?? 'day',
    defaultOffset: offset,
  });
  // +08:00 没有夏令时，一天恒定 86400000 ms；这里用纯算术，不用 Intl
  const toMs = fromMs + DAY_MS;
  const nextDay = dayKeyInZone(toMs, offset);
  return {
    from: `${dayKey}T00:00:00${offset}`,
    to: `${nextDay}T00:00:00${offset}`,
    fromMs,
    toMs,
    reason: null,
  };
}
