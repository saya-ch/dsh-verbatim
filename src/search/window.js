/**
 * 自适应场景内滑动对话窗（Window）—— 填补「单条 msg」与「整场 scene.gist」之间的粒度断层。
 *
 * 为什么需要：
 *   - 陪伴聊天里单条消息中位数约 12 字，一件事/一个话题往往跨 2~8 句或连续多轮问答才能说清；
 *     单条 msg 嵌入缺主语/代词指代，多词搜索（如两个词分别在不同消息里）单句也搜不到。
 *   - scene.gist 经过摘要压缩，必然丢失支线与细节语义。
 *
 * 泛用性保障（不破坏长文本对话）：
 *   - 单条长度 >= WINDOW_SKIP_MSG_CHARS（默认 400 字）的消息本身已具备完整语义，
 *     由 vec_msg / vec_chunk（>=800 字分片）独立负责，不强行塞进窗口，直接作为短消息滑窗的自然边界。
 *   - 只有连续 >= 2 条短消息才聚合成窗；单条孤立短消息已有 vec_msg/msg_fts，绝不重复建 1 条窗。
 *   - 被排除（excluded=1）的消息不进入窗口并自动断窗，避免在默认检索中泄露被排除内容（D-169/170）。
 */

/** 单条消息达到该字数即视为独立语义单元，不参与短消息合窗（交给 vec_msg / vec_chunk） */
export const WINDOW_SKIP_MSG_CHARS = 400;

/** 单个滑动窗口的目标正文字数（不含说话人前缀） */
export const WINDOW_TARGET_CHARS = 380;

/** 单个滑动窗口的字数硬上限（超过则提前封窗，确保语义聚焦） */
export const WINDOW_MAX_CHARS = 650;

/** 至少几条消息才成窗（1 条消息本身已在 msg_fts / vec_msg 中，无需建窗） */
export const WINDOW_MIN_MSGS = 2;

/** 单个窗口最多包含几条消息（防止一连串“嗯/哈哈”拼出几十条） */
export const WINDOW_MAX_MSGS = 8;

/** 窗口内有效正文最少字数（过滤纯“嗯/好”类无语义噪声窗） */
export const WINDOW_MIN_CHARS = 16;

/** 同一场景内相邻消息间隔超过该时长时断窗，避免把停顿后的新话题揉进同一窗 */
export const WINDOW_MAX_GAP_MS = 10 * 60_000;

function formatSpeakerPrefix(speaker) {
  if (speaker === 'user') return '你';
  if (speaker === 'assistant') return 'TA';
  return String(speaker ?? '').trim() || 'TA';
}

function cleanText(raw) {
  return String(raw ?? '').trim();
}

/**
 * 格式化窗口文本：保留说话人前缀与原始逐字内容，不改写、不摘要。
 * @param {object[]} msgs
 * @returns {string}
 */
export function formatWindowText(msgs) {
  return msgs
    .map((m) => `${formatSpeakerPrefix(m.speaker)}：${cleanText(m.text)}`)
    .join('\n');
}

/**
 * 把同一场景内有序消息切分为若干“可合窗的连续短消息片段（runs）”。
 * 遇以下边界自动断段：
 *   1) excluded === 1（被排除消息不入窗）
 *   2) 空消息
 *   3) text.length >= skipMsgChars（长消息由 vec_msg / vec_chunk 负责）
 *   4) 与前一条时间间隔 > maxGapMs
 *
 * @param {object[]} msgs 按 at/seq 升序排列的同场消息
 * @param {{skipMsgChars?: number, maxGapMs?: number}} [opts]
 * @returns {object[][]}
 */
export function splitShortRuns(msgs, opts = {}) {
  const skipMsgChars = Number.isFinite(opts.skipMsgChars) ? opts.skipMsgChars : WINDOW_SKIP_MSG_CHARS;
  const maxGapMs = Number.isFinite(opts.maxGapMs) ? opts.maxGapMs : WINDOW_MAX_GAP_MS;
  const runs = [];
  let cur = [];
  let prevAt = null;

  const flush = () => {
    if (cur.length >= WINDOW_MIN_MSGS) runs.push(cur);
    cur = [];
    prevAt = null;
  };

  for (const m of msgs ?? []) {
    if (!m) continue;
    if (Number(m.excluded) === 1) {
      flush();
      continue;
    }
    const text = cleanText(m.text);
    if (!text) continue;
    if (text.length >= skipMsgChars) {
      flush();
      continue;
    }
    const at = Number(m.at);
    if (cur.length > 0 && prevAt !== null && Number.isFinite(at) && at - prevAt > maxGapMs) {
      flush();
    }
    cur.push(m);
    prevAt = Number.isFinite(at) ? at : prevAt;
  }
  flush();
  return runs;
}

/**
 * 为同一场景的消息列表构建自适应滑动对话窗（50% 重叠）。
 *
 * @param {object[]} msgs 同场景内消息（若未排序，内部按 at ASC, seq ASC, id ASC 排序）
 * @param {{
 *   sceneId?: number,
 *   sessionId?: string,
 *   skipMsgChars?: number,
 *   targetChars?: number,
 *   maxChars?: number,
 *   minMsgs?: number,
 *   maxMsgs?: number,
 *   minChars?: number,
 *   maxGapMs?: number,
 * }} [opts]
 * @returns {{
 *   sceneId: number|null,
 *   sessionId: string|null,
 *   idx: number,
 *   startMsgId: number,
 *   endMsgId: number,
 *   startAt: number,
 *   endAt: number,
 *   msgCount: number,
 *   charCount: number,
 *   text: string,
 * }[]}
 */
export function buildSceneWindows(msgs, opts = {}) {
  if (!Array.isArray(msgs) || msgs.length < WINDOW_MIN_MSGS) return [];

  const targetChars = Number.isFinite(opts.targetChars) ? opts.targetChars : WINDOW_TARGET_CHARS;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : WINDOW_MAX_CHARS;
  const minMsgs = Math.max(2, Math.trunc(Number(opts.minMsgs ?? WINDOW_MIN_MSGS)));
  const maxMsgs = Math.max(minMsgs, Math.trunc(Number(opts.maxMsgs ?? WINDOW_MAX_MSGS)));
  const minChars = Math.max(1, Math.trunc(Number(opts.minChars ?? WINDOW_MIN_CHARS)));

  const ordered = [...msgs].sort(
    (a, b) => Number(a.at) - Number(b.at) || Number(a.seq ?? 0) - Number(b.seq ?? 0) || Number(a.id ?? 0) - Number(b.id ?? 0),
  );
  const runs = splitShortRuns(ordered, opts);
  const out = [];

  for (const run of runs) {
    let start = 0;
    let lastEnd = -1;

    while (start < run.length) {
      let end = start;
      let chars = 0;

      while (end < run.length && end - start < maxMsgs) {
        const len = cleanText(run[end].text).length;
        // 已有至少 minMsgs 条，再加一条会超硬上限 → 停止扩展
        if (end - start >= minMsgs && chars + len > maxChars) break;
        chars += len;
        end += 1;
        // 达到目标字数且条数达标 → 封窗
        if (end - start >= minMsgs && chars >= targetChars) break;
      }

      // 尾部剩余不足 minMsgs 条：若能向前回溯凑满 minMsgs 且不与上一个窗口完全重合，则补一个尾窗
      if (end - start < minMsgs) {
        if (run.length >= minMsgs) {
          const backStart = Math.max(0, run.length - minMsgs);
          if (backStart > 0 && run.length > lastEnd) {
            const slice = run.slice(backStart, run.length);
            const sliceChars = slice.reduce((s, m) => s + cleanText(m.text).length, 0);
            if (sliceChars >= minChars) {
              out.push(makeWindowEntry(slice, sliceChars, out.length, opts));
            }
          }
        }
        break;
      }

      // 若已完全被上一个窗口覆盖（同一末尾且更短），避免重复尾窗
      if (end <= lastEnd) break;

      if (chars >= minChars) {
        const slice = run.slice(start, end);
        out.push(makeWindowEntry(slice, chars, out.length, opts));
      }
      lastEnd = end;

      if (end >= run.length) break;

      // 步长 = 窗口消息数的一半（约 50% 重叠），至少前进 1 条
      const count = end - start;
      const step = Math.max(1, Math.floor(count / 2));
      start += step;
    }
  }

  return out;
}

function makeWindowEntry(slice, charCount, idx, opts) {
  const first = slice[0];
  const last = slice[slice.length - 1];
  const sceneId = opts.sceneId ?? first.sceneId ?? first.scene_id ?? null;
  const sessionId = opts.sessionId ?? first.sessionId ?? first.session_id ?? null;
  return {
    sceneId: sceneId === null || sceneId === undefined ? null : Number(sceneId),
    sessionId: sessionId === null || sessionId === undefined ? null : String(sessionId),
    idx,
    startMsgId: Number(first.id),
    endMsgId: Number(last.id),
    startAt: Number(first.at),
    endAt: Number(last.at),
    msgCount: slice.length,
    charCount,
    text: formatWindowText(slice),
  };
}

/* ============================ 落单短句补上下文 ============================ */

/**
 * 上下文补齐用的邻居截断（与 tools/memory-search.js 的 buildRerankDoc 同规则，
 * 说话人前缀用本文件的窗口惯例「你/TA」，与 vec_window 处同一向量空间）：
 *   · 长邻居只取前 200 字（免得喧宾夺主）
 *   · 非锚点邻居累计超过 700 字就不再加
 */
const SHORT_CTX_NEIGHBOR_MAX = 200;
const SHORT_CTX_TOTAL_MAX = 700;

/**
 * 判断一条短消息是否有窗口覆盖（= 是否落在某条 ≥2 条的短消息 run 里）。
 *
 * 与 splitShortRuns 同口径：相邻消息须同场、未被排除、长度 < skipMsgChars、
 * 且时间间隔 ≤ maxGapMs。满足「前邻或后邻任一合格」即视为被窗口覆盖，
 * 调用方应直接嵌原文（窗口向量已承担上下文职责，不重复）。
 *
 * @param {object} msg 锚点消息（含 id/at/sceneId/text/excluded）
 * @param {object[]} sceneMsgs 同场消息（按 at/seq/id 升序，未排序内部会排）
 * @param {{skipMsgChars?: number, maxGapMs?: number}} [opts]
 * @returns {boolean} true = 有窗口覆盖（直接嵌原文）
 */
export function hasWindowCoverage(msg, sceneMsgs, opts = {}) {
  const skipMsgChars = Number.isFinite(opts.skipMsgChars) ? opts.skipMsgChars : WINDOW_SKIP_MSG_CHARS;
  const maxGapMs = Number.isFinite(opts.maxGapMs) ? opts.maxGapMs : WINDOW_MAX_GAP_MS;
  if (!msg || !Array.isArray(sceneMsgs) || sceneMsgs.length === 0) return false;
  if (String(msg.text ?? '').length >= skipMsgChars) return true; // 长消息自足（由 vec_msg/chunk 负责）
  const ordered = [...sceneMsgs].sort(
    (a, b) => Number(a.at) - Number(b.at) || Number(a.seq ?? 0) - Number(b.seq ?? 0) || Number(a.id ?? 0) - Number(b.id ?? 0),
  );
  const idx = ordered.findIndex((m) => Number(m.id) === Number(msg.id));
  if (idx < 0) return false;
  const qualifies = (m, anchorAt) => {
    if (!m || Number(m.excluded) === 1) return false;
    if (cleanText(m.text).length >= skipMsgChars) return false;
    if (!Number.isFinite(Number(m.at)) || !Number.isFinite(Number(anchorAt))) return true;
    return Math.abs(Number(m.at) - Number(anchorAt)) <= maxGapMs;
  };
  const prev = idx > 0 ? ordered[idx - 1] : null;
  const next = idx < ordered.length - 1 ? ordered[idx + 1] : null;
  return qualifies(prev, msg.at) || qualifies(next, msg.at);
}

/**
 * 给落单短消息拼嵌入用上下文（前 2 + 自己 + 后 2，取自同场未被排除的消息）。
 *
 * 专治 R2-fact 式惨案：技术会话的事实链是「意图短句 … 长工作过程 … 结果短句」，
 * 结果短句的邻居全是 ≥400 字的长消息 → 建窗时断窗 → 它永远落单 →
 * 它的向量就是光秃秃几个字（"已推送 ccf9c89"），查询里的"commit号"在向量空间
 * 里找不到落点（裸向量排名往往靠后，容易被阈值截掉）。
 *
 * 有窗口覆盖的消息返回 null（调用方嵌原文，避免与窗口向量重复）。
 *
 * @param {object} msg 锚点消息
 * @param {object[]} sceneMsgs 同场消息
 * @returns {string|null} 上下文文本（null = 有覆盖，不用补）
 */
export function buildShortContext(msg, sceneMsgs) {
  if (!msg) return null;
  if (hasWindowCoverage(msg, sceneMsgs)) return null;
  const ordered = [...(sceneMsgs ?? [])]
    .filter((m) => m && Number(m.excluded) !== 1 && cleanText(m.text))
    .sort(
      (a, b) => Number(a.at) - Number(b.at) || Number(a.seq ?? 0) - Number(b.seq ?? 0) || Number(a.id ?? 0) - Number(b.id ?? 0),
    );
  const idx = ordered.findIndex((m) => Number(m.id) === Number(msg.id));
  const anchor = idx >= 0 ? ordered[idx] : { ...msg, text: cleanText(msg.text) };
  const at = idx >= 0 ? idx : 0;
  const pool = idx >= 0 ? ordered : [anchor];
  const from = Math.max(0, at - 2);
  const to = Math.min(pool.length - 1, at + 2);
  const parts = [];
  let totalLen = 0;
  for (let i = from; i <= to; i += 1) {
    const m = pool[i];
    const t = cleanText(m.text);
    if (!t) continue;
    const isAnchor = Number(m.id) === Number(msg.id);
    // 长邻居只取前 200 字；锚点永远全文（它本身 <400 字，天然成立）
    const piece = !isAnchor && t.length > SHORT_CTX_NEIGHBOR_MAX ? `${t.slice(0, SHORT_CTX_NEIGHBOR_MAX)}…` : t;
    if (!isAnchor && totalLen + piece.length > SHORT_CTX_TOTAL_MAX) continue;
    parts.push(`${formatSpeakerPrefix(m.speaker)}：${piece}`);
    totalLen += piece.length;
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export default buildSceneWindows;
