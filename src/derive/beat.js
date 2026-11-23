/**
 * beat 分类 —— 互动类型标注（发展通道）
 *
 * 规格：BUILD-PLAN.md §4.3 ｜ 关键决策：D-104（12 类离散标签 + 独立分类）/ D-090（不量化感情）
 *
 * 一句话原则：**只贴标签，不解读动机；拿不准就把 confidence 打到 0.6 以下。**
 *
 * 为什么这条原则重要（D-104 的理由）：
 *   beat 的分类**不依赖历史**——每条消息独立判断。所以分类不会「越滚越脏」，
 *   错一条TA看原话就能筛掉。但前提是 confidence 必须诚实：
 *   一个虚高的 0.9 会让错标混进「发展序列」，而 0.4 只是噪声。
 *
 * 不做的事：
 *   - 不统计频率、不算「亲密度/热度」任何指标（D-090）
 *   - 不从 beat 序列推断关系走向（那是TA的解读，D-101）
 *   - 不硬分：一条消息可以同时属于多类，也可以一类都不属于
 */

import { BEAT_SYSTEM, renderBeatUser, BEAT_KINDS } from './prompts.js';
import { parseJsonLoose } from '../model/llm.js';

/**
 * 12 类，**唯一来源是 prompts.js 的 BEAT_KINDS**，这里只是转出，
 * 保证 prompt 与代码判断用的是同一份清单。
 */
export { BEAT_KINDS };

/**
 * 「拿不准」的阈值（BUILD-PLAN.md §4.3）。
 * confidence < 0.6 → 视为低置信，上层默认不用于发展序列。
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 给一条消息打 beat 标签。
 *
 * @param {object} opts
 * @param {{complete: Function}} opts.llm
 * @param {{seq:number, speaker:string, text:string}} opts.msg 待分类消息
 * @param {{speaker:string, text:string}|null} [opts.before] 前一条（提供回应语境）
 * @param {{speaker:string, text:string}|null} [opts.after]  后一条
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   beats: {kind:string, confidence:number}[],
 *   lowConfidence: boolean,
 *   ok: boolean,
 *   issues: string[]
 * }>}
 */
export async function classifyBeat(opts) {
  const { llm, msg, before, after, signal } = opts;

  if (!llm || typeof llm.complete !== 'function') {
    throw new TypeError('classifyBeat 需要提供 llm.complete');
  }
  if (!msg || typeof msg.text !== 'string') {
    throw new TypeError('classifyBeat 需要 msg.text');
  }

  // 空消息 / 纯空白不值得烧一次调用
  if (!msg.text.trim()) {
    return { beats: [], lowConfidence: true, ok: true, issues: ['空消息，跳过分类'] };
  }

  const user = renderBeatUser(msg, { before, after });

  const text = await llm.complete(
    [
      { role: 'system', content: BEAT_SYSTEM },
      { role: 'user', content: user },
    ],
    { responseFormat: 'json', signal },
  );

  return finalizeBeats(text);
}

/**
 * 把模型输出规范成 beat 数组。
 * 单独导出，便于测试与重建。
 *
 * 规则：
 * ① 非法 kind 一律丢弃（不映射、不猜）
 * ② confidence 缺省或非数字 → 强制降到 0.5（宁低不高）
 * ③ 同一 kind 重复 → 取更高的 confidence
 * ④ 返回的数组按 confidence 降序，方便上层截断
 *
 * @param {string} text
 * @returns {{beats:{kind:string,confidence:number}[], lowConfidence:boolean, ok:boolean, issues:string[]}}
 */
export function finalizeBeats(text) {
  const issues = [];

  let parsed;
  try {
    parsed = parseJsonLoose(text);
  } catch (err) {
    return {
      beats: [],
      lowConfidence: true,
      ok: false,
      issues: [`模型输出无法解析为 JSON：${err.message}`],
    };
  }

  const rawList = Array.isArray(parsed) ? parsed : parsed?.beats;
  if (!Array.isArray(rawList)) {
    return { beats: [], lowConfidence: true, ok: false, issues: ['模型输出缺少 beats 数组'] };
  }

  const byKind = new Map();
  const invalid = [];

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';

    // ① 非法 kind 丢弃
    if (!BEAT_KINDS.includes(kind)) {
      invalid.push(kind || '<空>');
      continue;
    }

    // ② confidence 规范化
    let confidence = clamp01(raw.confidence);
    if (confidence === null) {
      // 没给或给了非数字 → 按「不确定」处理，绝不当成高置信
      confidence = 0.5;
      issues.push(`kind=${kind} 缺少合法 confidence，按 0.5 处理`);
    }

    // ③ 同 kind 取更高
    const prev = byKind.get(kind);
    if (!prev || confidence > prev.confidence) {
      byKind.set(kind, { kind, confidence });
    }
  }

  if (invalid.length > 0) {
    issues.push(`丢弃了不在 12 类里的标签：${[...new Set(invalid)].join(', ')}`);
  }

  // ④ 按 confidence 降序
  const beats = [...byKind.values()].sort((a, b) => b.confidence - a.confidence);

  // 整条消息有没有「站得住的」标签
  const lowConfidence = beats.length === 0 || !beats.some((b) => b.confidence >= LOW_CONFIDENCE_THRESHOLD);

  return { beats, lowConfidence, ok: true, issues };
}

/**
 * 把一批消息的 beat 按 kind 归组，得到「发展通道」的时间序列。
 * 纯函数，不碰数据库；上层用 repo.beatsByKind 拿数据后可直接复用。
 *
 * @param {{kind:string, confidence:number, msgId?:number, seq?:number, at?:number}[]} beats
 * @param {object} [opts]
 * @param {number} [opts.minConfidence] 低于此值的不进序列，默认 0.6
 * @returns {Map<string, object[]>} kind → 按时间升序的 beat 列表
 */
export function groupByKind(beats, opts = {}) {
  const minConfidence = opts.minConfidence ?? LOW_CONFIDENCE_THRESHOLD;
  const map = new Map();

  for (const b of beats ?? []) {
    if (!b || !BEAT_KINDS.includes(b.kind)) continue;
    if (!(Number(b.confidence) >= minConfidence)) continue;
    if (!map.has(b.kind)) map.set(b.kind, []);
    map.get(b.kind).push(b);
  }

  // 按时间升序；没有 at 的放最后
  for (const list of map.values()) {
    list.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  }
  return map;
}

/** 判断单条 beat 是否属于「拿不准」 */
export function isLowConfidence(beat) {
  if (!beat || typeof beat.confidence !== 'number') return true;
  return beat.confidence < LOW_CONFIDENCE_THRESHOLD;
}

// ─────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────

/** 把任意值夹到 [0,1]；非数字返回 null */
function clamp01(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}
