/**
 * M3 —— fact 提炼
 *
 * 规格：BUILD-PLAN.md §4.1 ｜ 关键决策：D-069（TA的话永不自动成为事实）
 *
 * 一句话原则：**每条事实都必须能指回某一句他说过的话，指不回去就丢。**
 *
 * 这个模块的价值全在「校验」，不在「提取」。模型想编是它的事，
 * 五条硬校验是闸门：任何一条不过，这条 fact 直接丢弃，不进库。
 * 这也是 D-079 的路线 —— 靠限制表达空间，不靠事后抓错。
 *
 * 不碰数据库：需要查 msg 的地方通过 `lookupMsg` 注入，由上层接 repo。
 */

import {
  FACT_SYSTEM,
  renderFactUser,
  FACT_SUBJECTS,
} from './prompts.js';
import { parseJsonLoose } from '../model/llm.js';

/**
 * 五条硬校验的阈值（BUILD-PLAN.md §4.1）。
 * 这几个数字是规格给定的，并非随意设定；但「20/80 字够不够」需要真实数据验证。
 */
export const FACT_LIMITS = Object.freeze({
  keyMaxChars: 20,
  valueMaxChars: 80,
});

/** 单批最多提取几条。O-006 仍待定，先用 8 兜住「事实卡爆炸」 */
export const DEFAULT_MAX_FACTS = 8;

/**
 * 丢弃原因。上层做统计/日志时按这些码归类，不要解析中文。
 */
export const DROP_REASONS = Object.freeze({
  SOURCE_MISSING: 'source_missing', // 校验①：sourceSeq 查不到
  SOURCE_NOT_USER: 'source_not_user', // 校验②：来源不是 user（D-069）
  SOURCE_NOT_SURFACE: 'source_not_surface', // 校验③：inSurface !== 1
  KEY_TOO_LONG: 'key_too_long', // 校验④：key > 20 字
  VALUE_TOO_LONG: 'value_too_long', // 校验⑤：value > 80 字
  BAD_SUBJECT: 'bad_subject', // subject 不在 me/her/us
  BAD_ORIGIN: 'bad_origin', // origin 不是本模块能产生的那一档（D-072）
  EMPTY_FIELD: 'empty_field', // key 或 value 为空
  DUPLICATE: 'duplicate', // 同 subject+key 重复
  OVER_LIMIT: 'over_limit', // 超过单批条数上限
});

/**
 * 五条硬校验。**不通过返回 null，通过返回规范化后的 fact。**
 *
 * 五条按规格顺序：
 *   ① sourceSeq 存在（必须能查到这条 msg）
 *   ② 该 msg 的 speaker === 'user'（D-069：TA的话永不自动成为事实）
 *   ③ 该 msg 的 inSurface === 1（被压缩/被撤回的不能当依据）
 *   ④ key 长度 ≤ 20 字
 *   ⑤ value 长度 ≤ 80 字
 *
 * @param {object} raw 模型给出的原始条目
 * @param {object} deps
 * @param {(seq:number) => (object|null)} deps.lookupMsg 按 seq 查 msg，返回 null 表示不存在
 * @param {(reason:string, detail:object) => void} [deps.onDrop] 丢弃回调，便于统计
 * @returns {{subject:string,key:string,value:string,sourceSeq:number,origin:string}|null}
 */
export function validateFact(raw, deps) {
  const { lookupMsg, onDrop } = deps;
  const drop = (reason, detail = {}) => {
    onDrop?.(reason, { raw, ...detail });
    return null;
  };

  if (!raw || typeof raw !== 'object') return drop(DROP_REASONS.EMPTY_FIELD);

  // ── 校验④⑤ 先做：纯字符串检查，最便宜，能先筛掉一半废条目 ──
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  const value = typeof raw.value === 'string' ? raw.value.trim() : '';
  if (!key || !value) return drop(DROP_REASONS.EMPTY_FIELD);

  // 长度按 Unicode 码点算，中文一字算一个
  if (charLength(key) > FACT_LIMITS.keyMaxChars) {
    return drop(DROP_REASONS.KEY_TOO_LONG, { length: charLength(key) });
  }
  if (charLength(value) > FACT_LIMITS.valueMaxChars) {
    return drop(DROP_REASONS.VALUE_TOO_LONG, { length: charLength(value) });
  }

  // ── subject 必须是三选一（D-089 语域收窄为「我俩」）──
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (!FACT_SUBJECTS.includes(subject)) {
    return drop(DROP_REASONS.BAD_SUBJECT, { subject });
  }

  // ── 校验① sourceSeq 必须存在 ──
  const sourceSeq = toSeq(raw.sourceSeq);
  if (sourceSeq === null) return drop(DROP_REASONS.SOURCE_MISSING, { sourceSeq: raw.sourceSeq });

  const msg = lookupMsg(sourceSeq);
  if (!msg) return drop(DROP_REASONS.SOURCE_MISSING, { sourceSeq });

  // ── 校验② 来源必须是 user（D-069，最重要的一条）──
  if (msg.speaker !== 'user') {
    return drop(DROP_REASONS.SOURCE_NOT_USER, { sourceSeq, speaker: msg.speaker });
  }

  // ── 校验③ 来源必须在 surface 里 ──
  // 兼容两种字段命名：库里的 in_surface 与 JS 侧的 inSurface
  const inSurface = msg.inSurface ?? msg.in_surface;
  if (inSurface !== 1) {
    return drop(DROP_REASONS.SOURCE_NOT_SURFACE, { sourceSeq, inSurface });
  }

  // ── origin 强制为 extracted_from_user ──
  // 走到这里的条目按定义就是从 user 原话提炼的（D-072）。
  // 模型写别的 origin 一律纠正为 extracted_from_user；
  // 但它若写了 her_claim / user_confirmed，说明它理解错了来源语义，
  // 这两个 origin 只能由上层专门路径写入，所以整条丢弃，不硬改。
  if (raw.origin === 'her_claim' || raw.origin === 'user_confirmed') {
    return drop(DROP_REASONS.BAD_ORIGIN, { sourceSeq, origin: raw.origin });
  }
  const origin = 'extracted_from_user';

  return { subject, key, value, sourceSeq, origin };
}

/**
 * 提炼事实。
 *
 * @param {object} opts
 * @param {{complete: Function}} opts.llm        LlmProvider（生产用 DeepSeek，测试用 mock）
 * @param {{seq:number, speaker:string, text:string, at?:number, inSurface?:number}[]} opts.msgs
 *        当天的消息。本函数只把 speaker='user' 且 inSurface=1 的送进 prompt ——
 *        不让模型看到注定会被校验拦下的来源，省 token 也省误报。
 * @param {(seq:number) => (object|null)} [opts.lookupMsg]
 *        按 seq 查 msg。不传时用 opts.msgs 自己建索引（够用，但跨批提取时必须传真的 repo）
 * @param {string} [opts.coreSummary]  已知核心信息，减少重复提取
 * @param {string[]} [opts.knownFacts] 已记过的事实 key，减少重复提取
 * @param {number} [opts.maxFacts]     单批最多几条
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{facts: object[], dropped: {reason:string, raw:any}[], ok: boolean, issues: string[]}>}
 */
export async function extractFacts(opts) {
  const {
    llm,
    msgs,
    coreSummary,
    knownFacts,
    maxFacts = DEFAULT_MAX_FACTS,
    signal,
  } = opts;

  if (!llm || typeof llm.complete !== 'function') {
    throw new TypeError('extractFacts 需要提供 llm.complete');
  }
  if (!Array.isArray(msgs)) throw new TypeError('extractFacts 需要 msgs 数组');

  // 只送 user 侧、且在 surface 里的消息（D-069 + 校验③）
  const candidates = msgs.filter(
    (m) => m.speaker === 'user' && (m.inSurface ?? m.in_surface ?? 1) === 1,
  );

  // 一条 user 消息都没有 → 不可能有事实，直接返回，不烧一次调用
  if (candidates.length === 0) {
    return { facts: [], dropped: [], ok: true, issues: ['没有可用的 user 消息，跳过提炼'] };
  }

  // 校验用的查询函数：优先用上层注入的 repo，否则用本批 msgs 建索引
  const lookupMsg = opts.lookupMsg ?? buildLookup(msgs);

  const user = renderFactUser(candidates, { coreSummary, knownFacts });

  const text = await llm.complete(
    [
      { role: 'system', content: FACT_SYSTEM },
      { role: 'user', content: user },
    ],
    { responseFormat: 'json', signal },
  );

  // ── 解析 ──
  let parsed;
  try {
    parsed = parseJsonLoose(text);
  } catch (err) {
    // 解析失败不抛：这一批就当没提取到，原文还在，明天还能再提
    return {
      facts: [],
      dropped: [],
      ok: false,
      issues: [`模型输出无法解析为 JSON：${err.message}`],
    };
  }

  const rawList = Array.isArray(parsed) ? parsed : parsed?.facts;
  if (!Array.isArray(rawList)) {
    return { facts: [], dropped: [], ok: false, issues: ['模型输出缺少 facts 数组'] };
  }

  // ── 五条硬校验 ──
  const dropped = [];
  const onDrop = (reason, detail) => dropped.push({ reason, raw: detail.raw });

  const facts = [];
  const seen = new Set();

  for (const raw of rawList) {
    const fact = validateFact(raw, { lookupMsg, onDrop });
    if (!fact) continue;

    // 去重：同 subject + key 只留第一条
    const dedupeKey = `${fact.subject}\u0000${fact.key}`;
    if (seen.has(dedupeKey)) {
      onDrop(DROP_REASONS.DUPLICATE, { raw });
      continue;
    }

    // 条数上限（O-006 待定，先兜住）
    if (facts.length >= maxFacts) {
      onDrop(DROP_REASONS.OVER_LIMIT, { raw });
      continue;
    }

    seen.add(dedupeKey);
    facts.push(fact);
  }

  const issues = [];
  if (facts.length === 0 && rawList.length > 0) {
    issues.push(`模型给了 ${rawList.length} 条，全部未通过硬校验`);
  }

  return { facts, dropped, ok: true, issues };
}

/**
 * 把一批 fact 按 subject+key 合并，同 key 用新的 value 覆盖旧的。
 * 上层 upsert 前可用；不碰数据库，纯函数。
 *
 * @param {object[]} oldFacts
 * @param {object[]} newFacts
 * @returns {object[]}
 */
export function mergeFacts(oldFacts, newFacts) {
  const map = new Map();
  for (const f of oldFacts ?? []) {
    map.set(`${f.subject}\u0000${f.key}`, f);
  }
  for (const f of newFacts ?? []) {
    map.set(`${f.subject}\u0000${f.key}`, f);
  }
  return [...map.values()];
}

// ─────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────

/** 用一批 msg 建 seq → msg 的索引 */
function buildLookup(msgs) {
  const map = new Map();
  for (const m of msgs) {
    if (m && typeof m.seq === 'number') map.set(m.seq, m);
  }
  return (seq) => map.get(seq) ?? null;
}

/** 按 Unicode 码点数字符数（中文一字算一，emoji 算一） */
function charLength(s) {
  return [...s].length;
}

/** sourceSeq 允许是数字或数字字符串；其他一律视为无效 */
function toSeq(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
