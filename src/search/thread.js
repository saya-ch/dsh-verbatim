/**
 * 微话题对话线（Thread）与交互原子（Turn / Exchange）—— 零 LLM 本地语义切分与故事线聚合
 *
 * 设计目标：
 *   1. 解决陪伴聊天碎句子（中位 12 字）语义残缺：先归并同人连发（Turn），再配对一问一答（Exchange）；
 *   2. 解决大场景（80 轮）被「开头+接缝+结尾」撕裂：用 TextTiling 自适应局部谷值切出 3~8 轮完整微话题（Thread）；
 *   3. 解决扁平 RAG 同话题刷屏霸榜：为检索提供 Thread 级去重键，并用余弦聚类将跨天同一故事线折叠展示，省出 Top-K 名额。
 */

import { dot } from './vector-store.js';

export const TURN_MAX_GAP_MS = 3 * 60_000;
export const TURN_MAX_CHARS = 600;
export const EXCHANGE_MAX_GAP_MS = 15 * 60_000;
export const THREAD_MAX_GAP_MS = 15 * 60_000;
export const THREAD_MAX_EXCHANGES = 6;
export const THREAD_MAX_CHARS = 1400;
export const THREAD_MIN_EXCHANGES_FOR_VALLEY = 2;
export const THREAD_FLOOR_SIM = 0.35;
export const THREAD_VALLEY_STD_FACTOR = 0.8;
export const TIMELINE_FOLD_THRESHOLD = 0.78;

function speakerPrefix(speaker) {
  if (speaker === 'user') return '你';
  if (speaker === 'assistant') return 'TA';
  return String(speaker ?? '').trim() || 'TA';
}

function cleanText(raw) {
  return String(raw ?? '').trim();
}

function clipMid(text, headLen, tailLen) {
  const s = String(text ?? '');
  if (s.length <= headLen + tailLen + 20) return s;
  return `${s.slice(0, headLen)}\n…\n${s.slice(-tailLen)}`;
}

/**
 * Step 1: 合并同场景内连续同说话人的短消息为逻辑 Turn。
 * 遇以下情况断开：说话人改变 / 间隔超过 maxGapMs / 合并后字数超过 maxChars / excluded=1。
 *
 * @param {any[]} msgs 按时间升序的消息列表
 * @param {{maxGapMs?: number, maxChars?: number}} [opts]
 * @returns {any[]}
 */
export function coalesceTurns(msgs, opts = {}) {
  const maxGapMs = Number.isFinite(opts.maxGapMs) ? opts.maxGapMs : TURN_MAX_GAP_MS;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : TURN_MAX_CHARS;
  const ordered = [...(msgs ?? [])]
    .filter((m) => m && Number(m.excluded) !== 1 && cleanText(m.text))
    .sort((a, b) => Number(a.at) - Number(b.at) || Number(a.seq ?? 0) - Number(b.seq ?? 0) || Number(a.id ?? 0) - Number(b.id ?? 0));

  const turns = [];
  for (const m of ordered) {
    const txt = cleanText(m.text);
    const prev = turns[turns.length - 1];
    if (
      prev
      && prev.speaker === m.speaker
      && (Number(m.at) - Number(prev.endAt)) <= maxGapMs
      && (prev.text.length + txt.length + 1) <= maxChars
    ) {
      prev.msgs.push(m);
      prev.endMsgId = Number(m.id);
      prev.endAt = Number(m.at);
      prev.text = `${prev.text}\n${txt}`;
    } else {
      turns.push({
        sceneId: m.sceneId === null || m.sceneId === undefined ? null : Number(m.sceneId),
        sessionId: m.sessionId ?? null,
        speaker: m.speaker,
        msgs: [m],
        startMsgId: Number(m.id),
        endMsgId: Number(m.id),
        startAt: Number(m.at),
        endAt: Number(m.at),
        text: txt,
      });
    }
  }
  return turns;
}

/**
 * Step 2: 把连续的 User Turn + Assistant Turn 配对为语义完整的 Exchange（一问一答交互对）。
 *
 * @param {any[]} turns coalesceTurns 的输出
 * @param {{maxGapMs?: number}} [opts]
 * @returns {any[]}
 */
export function buildExchanges(turns, opts = {}) {
  const maxGapMs = Number.isFinite(opts.maxGapMs) ? opts.maxGapMs : EXCHANGE_MAX_GAP_MS;
  const list = Array.isArray(turns) ? turns : [];
  const exchanges = [];
  let i = 0;

  while (i < list.length) {
    const cur = list[i];
    const next = i + 1 < list.length ? list[i + 1] : null;
    if (
      cur.speaker === 'user'
      && next
      && next.speaker === 'assistant'
      && (next.startAt - cur.endAt) <= maxGapMs
    ) {
      const uTxt = cur.text.length > 500 ? `${cur.text.slice(0, 500)}…` : cur.text;
      const aTxt = clipMid(next.text, 900, 350);
      const embedText = `${speakerPrefix('user')}：${uTxt}\n${speakerPrefix('assistant')}：${aTxt}`;
      exchanges.push({
        sceneId: cur.sceneId,
        sessionId: cur.sessionId,
        msgs: [...cur.msgs, ...next.msgs],
        startMsgId: cur.startMsgId,
        endMsgId: next.endMsgId,
        startAt: cur.startAt,
        endAt: next.endAt,
        text: embedText,
        fullText: `${speakerPrefix('user')}：${cur.text}\n${speakerPrefix('assistant')}：${next.text}`,
      });
      i += 2;
    } else {
      const cTxt = clipMid(cur.text, 1100, 450);
      const embedText = `${speakerPrefix(cur.speaker)}：${cTxt}`;
      exchanges.push({
        sceneId: cur.sceneId,
        sessionId: cur.sessionId,
        msgs: [...cur.msgs],
        startMsgId: cur.startMsgId,
        endMsgId: cur.endMsgId,
        startAt: cur.startAt,
        endAt: cur.endAt,
        text: embedText,
        fullText: `${speakerPrefix(cur.speaker)}：${cur.text}`,
      });
      i += 1;
    }
  }
  return exchanges;
}

/**
 * Step 3: TextTiling 自适应局部谷值切分微话题（Thread）。
 * 不依赖全局死阈值：根据当前场景内相邻 Exchange 的余弦相似度均值与标准差，
 * 在明显跌落且形成局部谷值的地方断开；同时保留硬时间断层与长度上限。
 *
 * @param {any[]} exchanges 同场景内的 Exchange 列表（若已嵌入，每项带 .vec Float32Array）
 * @param {{
 *   maxGapMs?: number,
 *   maxExchanges?: number,
 *   maxChars?: number,
 *   minExchangesForValley?: number,
 *   floorSim?: number,
 *   valleyStdFactor?: number,
 * }} [opts]
 * @returns {object[]}
 */
export function segmentThreadsByValley(exchanges, opts = {}) {
  const list = Array.isArray(exchanges) ? exchanges : [];
  if (list.length === 0) return [];

  const maxGapMs = Number.isFinite(opts.maxGapMs) ? opts.maxGapMs : THREAD_MAX_GAP_MS;
  const maxExchanges = Number.isFinite(opts.maxExchanges) ? opts.maxExchanges : THREAD_MAX_EXCHANGES;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : THREAD_MAX_CHARS;
  const minExForValley = Number.isFinite(opts.minExchangesForValley) ? opts.minExchangesForValley : THREAD_MIN_EXCHANGES_FOR_VALLEY;
  const floorSim = Number.isFinite(opts.floorSim) ? opts.floorSim : THREAD_FLOOR_SIM;
  const stdFactor = Number.isFinite(opts.valleyStdFactor) ? opts.valleyStdFactor : THREAD_VALLEY_STD_FACTOR;

  // 计算相邻余弦相似度序列
  const sims = [];
  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i].vec;
    const b = list[i + 1].vec;
    sims.push(a && b && a.length === b.length ? dot(a, b) : null);
  }
  const validSims = sims.filter((x) => typeof x === 'number' && Number.isFinite(x));
  let mean = 0;
  let std = 0;
  if (validSims.length > 0) {
    mean = validSims.reduce((s, x) => s + x, 0) / validSims.length;
    const variance = validSims.reduce((s, x) => s + (x - mean) ** 2, 0) / validSims.length;
    std = Math.sqrt(variance);
  }
  const adaptiveCut = validSims.length >= 3 ? mean - stdFactor * std : floorSim;

  const threads = [];
  let cur = [list[0]];

  const flush = () => {
    if (cur.length === 0) return;
    const msgs = cur.flatMap((e) => e.msgs ?? []);
    const thText = cur.map((e) => {
      const t = String(e.text ?? '');
      return t.length > 350 ? `${t.slice(0, 350)}…` : t;
    }).join('\n').slice(0, 1800);
    threads.push({
      sceneId: cur[0].sceneId ?? null,
      sessionId: cur[0].sessionId ?? null,
      idx: threads.length,
      exchanges: cur,
      msgs,
      startMsgId: cur[0].startMsgId,
      endMsgId: cur[cur.length - 1].endMsgId,
      startAt: cur[0].startAt,
      endAt: cur[cur.length - 1].endAt,
      msgCount: msgs.length,
      text: thText,
    });
    cur = [];
  };

  for (let i = 0; i < list.length - 1; i += 1) {
    const prev = list[i];
    const next = list[i + 1];
    const gapMs = Number(next.startAt) - Number(prev.endAt);
    const curChars = cur.reduce((s, e) => s + String(e.text ?? '').length, 0);
    const nextLen = String(next.text ?? '').length;

    const sim = sims[i];
    const prevSim = i > 0 ? sims[i - 1] : null;
    const nextSim = i + 1 < sims.length ? sims[i + 1] : null;
    const isLocalMin = typeof sim === 'number'
      && (prevSim === null || sim <= prevSim)
      && (nextSim === null || sim <= nextSim);

    const shouldSplit = (
      gapMs > maxGapMs
      || cur.length >= maxExchanges
      || (cur.length >= 1 && curChars + nextLen > maxChars)
      || (typeof sim === 'number' && sim < floorSim)
      || (
        cur.length >= minExForValley
        && isLocalMin
        && typeof sim === 'number'
        && sim < adaptiveCut
      )
    );

    if (shouldSplit) flush();
    cur.push(next);
  }
  flush();

  return threads;
}

/**
 * Step 4: 跨天故事线自动串联（Episodic Timeline Folding）。
 * 当检索返回的多个命中各自所属 Thread 高度相似（dot >= threshold）且处于不同场景/时段时，
 * 将较后的相似命中折叠进主命中的 `timelineThreadIds` / `relatedTimeline` 中，
 * 释放 Top-K 名额给其他独立事件，同时保留完整的跨天故事脉络。
 *
 * @param {any[]} hits 已排序的候选列表
 * @param {(hit: any) => Float32Array|null} getVec 获取命中代表向量（归一化）
 * @param {{ threshold?: number, limit?: number }} [opts]
 * @returns {any[]}
 */
export function foldTimelineClusters(hits, getVec, opts = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length <= 1 || typeof getVec !== 'function') return list;

  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : TIMELINE_FOLD_THRESHOLD;
  const kept = [];
  const keptVecs = [];

  for (const h of list) {
    const vec = getVec(h);
    let targetIdx = -1;
    if (vec) {
      for (let i = 0; i < kept.length; i += 1) {
        const kv = keptVecs[i];
        if (!kv || kv.length !== vec.length) continue;
        // 只折叠跨场景（不同天/不同场）的高度同源主题，同场不同段已在 Thread 层处理
        if (Number(kept[i].sceneId) === Number(h.sceneId)) continue;
        if (dot(kv, vec) >= threshold) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx >= 0) {
      const main = kept[targetIdx];
      if (!Array.isArray(main.relatedTimeline)) main.relatedTimeline = [];
      main.relatedTimeline.push({
        id: h.id,
        sceneId: h.sceneId,
        at: h.at ?? h.sceneStartAt ?? null,
        sceneStartAt: h.sceneStartAt ?? null,
        sceneEndAt: h.sceneEndAt ?? null,
        window: h.window ?? null,
      });
    } else {
      kept.push({ ...h });
      keptVecs.push(vec);
    }
  }

  return Number.isFinite(opts.limit) && opts.limit > 0 ? kept.slice(0, opts.limit) : kept;
}
