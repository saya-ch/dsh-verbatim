// link.js —— 场景邻接回填 + lead_in（切完后统一回填）
//
// 规格来源：IMPLEMENTATION.md §6.3（口径冲突时以它为准），配合 D-097 / D-100 / D-105。
//
// 这里只做三件事，全部是**事实**，不含任何解读：
//   ① 会话内相邻：preceded_by / followed_by（按时间，全自动、零解释）
//   ② 间隔：gap_before_ms / gap_after_ms
//   ③ 前情：lead_in —— 前一场最后 2 条的**原文**
//
// ⚠ D-100：时间相邻 ≠ 情感接续。这些字段只能当「背景补充」用，
//   绝不能拿来推断递进、惯性、冷热。所以 lead_in 只存原文
//   （seq / at / speaker / text 四个字段），不加摘要、不加标签、不做判断。
//
// ⚠ lead_in 的格式：IMPLEMENTATION.md §6.3 写的是 JSON.stringify 后的字符串，
//   T1 的 insertScene / updateSceneLinks 收到数组也会自动 stringify。
//   为了两边都能直接用，这里同时给：
//     scene.lead_in       —— JSON 字符串（与 scene.lead_in 列一致）
//     scene.lead_in_msgs  —— 同上内容的数组（给工具层直接渲染，省一次 parse）
//   两者内容完全一致，不是两份数据源。
//
// 纯函数：不读数据库、不修改入参，返回新对象。

import { splitScenesWithStats } from './split.js';

/** lead_in 默认取前一场末尾几条（IMPLEMENTATION.md §6.3 = 2；D-037 曾提 3，以 §6.3 为准） */
export const LEAD_IN_COUNT = 2;

/** 邻接回填时会用到的计数上限提示：gap 为 null 表示「没有前一场 / 后一场」 */

/** 取消息的时刻 */
function atOf(m) {
  const at = m?.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new TypeError(`linkScenes: 场景里的消息缺少有效的 at（epoch ms），seq=${m?.seq}`);
  }
  return at;
}

/** 取消息的 seq（缺失给 null，不编造） */
function seqOf(m) {
  const s = m?.seq;
  return typeof s === 'number' && Number.isFinite(s) ? s : null;
}

/**
 * 把一条消息压成 lead_in 用的最小原文对象。
 * 只留原文相关字段：谁、什么时候、说了什么，以及定位用的 seq。
 *
 * @param {object} m
 * @returns {{seq:number|null, at:number, speaker:string|null, text:string}}
 */
export function leadInDigest(m) {
  const speaker = m?.speaker === 'user' || m?.speaker === 'assistant' ? m.speaker : null;
  return {
    seq: seqOf(m),
    at: atOf(m),
    speaker,
    text: typeof m?.text === 'string' ? m.text : '',
  };
}

/** 场景的边界时刻（优先用已有的 start_at / end_at，缺失时从 msgs 现算） */
function boundsOf(s) {
  const msgs = s?.msgs;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    const start = s?.start_at ?? s?.startAt;
    const end = s?.end_at ?? s?.endAt;
    if (typeof start === 'number' && typeof end === 'number') return { start, end };
    throw new TypeError('linkScenes: 场景缺少 msgs 或 start_at/end_at');
  }
  const start = typeof s.start_at === 'number' ? s.start_at : atOf(msgs[0]);
  const end = typeof s.end_at === 'number' ? s.end_at : atOf(msgs[msgs.length - 1]);
  return { start, end };
}

/**
 * 回填邻接信息，返回**新的**场景对象数组（不改入参）。
 *
 * 输出字段（与 scene 表列一一对应）：
 *   id            场景 id（opts.ids 优先，其次沿用 s.id，最后按 1..N 编号）
 *   start_at / end_at / msg_count  保证存在（缺失时按 msgs 现算）
 *   preceded_by   前一场 id，没有就 null
 *   followed_by   后一场 id，没有就 null
 *   gap_before_ms 本场开始 - 前一场结束，没有前一场就 null
 *   gap_after_ms  后一场开始 - 本场结束，没有后一场就 null
 *   lead_in       前一场末尾 2 条原文的 JSON 字符串（第一场为 '[]'）
 *   lead_in_msgs  同上，数组形式
 *
 * @param {object[]} scenes splitScenes 的输出
 * @param {{ ids?: number[], leadInCount?: number }} [opts]
 *   ids：真实库 id（T1 入库后拿着返回的 id 再来回填时用）；
 *       不传则沿用场景已有的 id，再没有就按 1..N 编号（纯函数可独立验证）。
 * @returns {object[]}
 */
export function linkScenes(scenes, opts = {}) {
  if (!Array.isArray(scenes)) throw new TypeError('linkScenes: 入参必须是场景数组');
  const leadInCount = opts.leadInCount ?? LEAD_IN_COUNT;
  if (!Number.isInteger(leadInCount) || leadInCount < 0) {
    throw new TypeError(`linkScenes: leadInCount 必须是非负整数，收到 ${leadInCount}`);
  }
  const ids = opts.ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length !== scenes.length)) {
    throw new TypeError(`linkScenes: opts.ids 必须是长度 ${scenes.length} 的数组`);
  }

  // 先把所有 id 定下来（followed_by 要用到下一场的 id，必须两遍）
  const resolved = scenes.map((s, i) => {
    const explicit = ids?.[i];
    if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
    const own = s?.id;
    if (typeof own === 'number' && Number.isFinite(own)) return own;
    return i + 1;
  });

  return scenes.map((s, i) => {
    const { start, end } = boundsOf(s);
    const prev = i > 0 ? scenes[i - 1] : null;
    const next = i < scenes.length - 1 ? scenes[i + 1] : null;
    const prevBounds = prev ? boundsOf(prev) : null;
    const nextBounds = next ? boundsOf(next) : null;

    const msgs = Array.isArray(s.msgs) ? s.msgs : [];
    const leadInMsgs = prev && Array.isArray(prev.msgs) && leadInCount > 0
      ? prev.msgs.slice(-leadInCount).map(leadInDigest)
      : [];

    return {
      ...s,
      id: resolved[i],
      start_at: start,
      end_at: end,
      msg_count: s.msg_count ?? msgs.length,
      preceded_by: prev ? resolved[i - 1] : null,
      followed_by: next ? resolved[i + 1] : null,
      gap_before_ms: prevBounds ? start - prevBounds.end : null,
      gap_after_ms: nextBounds ? nextBounds.start - end : null,
      lead_in: JSON.stringify(leadInMsgs),
      lead_in_msgs: leadInMsgs,
    };
  });
}

/**
 * 把切分结果转成 T1 `extras.sceneAssign.assignSeqRange` 的入参计划。
 *
 * 每个场景的消息在 seq 上是连续的一段（场景是时间轴上的连续切片），
 * 所以用 [最小 seq, 最大 seq] 区间回填即可。区间取的是场景内**实际存在**的
 * 最小/最大 seq，rewind 掉的那些 seq 本来就没有行，BETWEEN 不会误伤。
 *
 * @param {object[]} scenes splitScenes / linkScenes 的输出
 * @param {string} [sessionId] 不传则读场景里第一条消息的 session_id
 * @returns {{ sceneIndex:number, sceneId:number|null, sessionId:string|null,
 *             fromSeq:number, toSeq:number, msgCount:number }[]}
 */
export function assignPlan(scenes, sessionId) {
  if (!Array.isArray(scenes)) throw new TypeError('assignPlan: 入参必须是场景数组');

  return scenes.map((s, i) => {
    const msgs = Array.isArray(s.msgs) ? s.msgs : [];
    if (msgs.length === 0) throw new TypeError(`assignPlan: 第 ${i + 1} 场没有消息`);

    let fromSeq = Infinity;
    let toSeq = -Infinity;
    let sid = sessionId ?? null;
    for (const m of msgs) {
      const q = seqOf(m);
      if (q !== null) {
        if (q < fromSeq) fromSeq = q;
        if (q > toSeq) toSeq = q;
      }
      if (sid === null) {
        const ms = m?.session_id ?? m?.sessionId;
        if (typeof ms === 'string' && ms) sid = ms;
      }
    }
    if (fromSeq === Infinity) throw new TypeError(`assignPlan: 第 ${i + 1} 场的消息都没有 seq`);

    return {
      sceneIndex: i,
      sceneId: typeof s.id === 'number' ? s.id : null,
      sessionId: sid,
      fromSeq,
      toSeq,
      msgCount: msgs.length,
    };
  });
}

/**
 * 一次性做完「切分 + 邻接」：给 T8 的便利入口。
 * 仍然是纯函数（split.js 不依赖本文件，没有循环依赖）。
 *
 * @param {object[]} messages
 * @param {object} [opts] 同时接受 splitScenes 与 linkScenes 的选项
 * @returns {{ scenes: object[], stats: object }}
 */
export function buildScenes(messages, opts = {}) {
  const { scenes, stats } = splitScenesWithStats(messages, opts);
  return { scenes: linkScenes(scenes, opts), stats };
}
