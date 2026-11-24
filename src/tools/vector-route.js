// @ts-check
/**
 * vector-route.js —— memory_search 的语义路、精排与候选归并模块
 *
 * 从 memory-search.js 拆出，集中负责：
 *   - 语义路装配与索引覆盖率闸门（assessVectorIndex / resolveSemantic）
 *   - 四层多粒度向量召回（runVectorRoute）
 *   - Cross-Encoder 二次精排（resolveReranker / applyRerank）
 *   - 低置信柔提示与语义降级说明（weakEvidenceHint / semanticNote）
 */

import { fmtCount, speakerLabel } from './format.js';
import { SCENE_FALLBACK_ENABLED } from '../search/scene-fallback.js';
import { formatChunkWithContext } from '../search/chunk.js';
import { dedupeBySpan } from '../search/dedupe.js';

export const RERANK_TOPN_DEFAULT = 50;
export const DEFAULT_MIN_INDEX_COVERAGE = 0.5;
export const VECTOR_MIN_SCORE = 0.52;
export const WEAK_TOP1_FLOOR = 0.62;
export const WEAK_RERANK_FLOOR = 0.15;
export const WEAK_QWEN3_RERANK_FLOOR = 0.45;

const SEMANTIC_OFF_PREFIX = '语义搜索未启用';
const SEMANTIC_OFF_TAG = 'vec:off';
const SEMANTIC_EMPTY_TAG = 'vec:empty';
const SEMANTIC_PARTIAL_TAG = 'vec:partial';

/** handle → 语义路解析结果（同一个库不重复建向量 storage / provider） */
const semanticCache = new WeakMap();

/** 全局配置 / embedding / rerank / 向量库的模块引用（延迟 import，避免测试时读盘） */
let globalConfigModule = null;
let embeddingModule = null;
let rerankModule = null;
let vectorStoreModule = null;

export async function loadSemanticModules() {
  if (!globalConfigModule) {
    globalConfigModule = await import('../config/global-config.js');
    embeddingModule = await import('../model/embedding.js');
    rerankModule = await import('../model/rerank.js');
    vectorStoreModule = await import('../search/vector-store.js');
  }
}

export function getLoadedGlobalConfigModule() {
  return globalConfigModule;
}

/** 查询切词（与 extras 里的同一套标点口径，不引第二个实现） */
export function splitTerms(raw) {
  return String(raw ?? '')
    .trim()
    .split(/[\s,.;:!?"'“”‘’、，。；：！？「」『』（）()【】[\]…—-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** minIndexCoverage 只认 0~1 的数；其余一律回默认 */
export function resolveMinIndexCoverage(injected = {}) {
  const value = Number(injected.minIndexCoverage);
  if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  return DEFAULT_MIN_INDEX_COVERAGE;
}

/** 纯时间参数 → 给关键词/语义路用的硬边界。 */
export function windowBounds(window) {
  if (!window || window.kind === 'latest' || window.from === null || window.to === null) return null;
  return { from: Number(window.from), to: Number(window.to) };
}

/** 时间路先圈出候选场景 → 返回候选场景 id 集合。 */
export function candidateSceneIds(repo, sessionId, bounds) {
  if (!bounds) return null;
  const scenes = repo.scenesByTimeRange(sessionId, bounds.from, bounds.to, 500);
  return new Set(scenes.map((s) => Number(s.id)));
}

/** 把命中限制在候选场景里（场景 id 缺失的老数据按时间窗已经过滤过，保留）。 */
export function restrictToCandidates(rows, allowed) {
  if (!allowed) return rows;
  return rows.filter((row) => {
    if (row.sceneId === null || row.sceneId === undefined) return true;
    return allowed.has(Number(row.sceneId));
  });
}

/**
 * 读一次索引覆盖率并判定能不能跑语义路（M2）。
 */
export function assessVectorIndex({ semantic, extras, minCoverage, sessionId = null }) {
  const store = semantic?.store;
  const meta = extras?.vecMeta;
  if (!semantic?.ok || typeof store?.countMsgVec !== 'function' || typeof meta?.get !== 'function') {
    return { usable: true, tag: null, note: null, vectors: null, total: null, ratio: null };
  }

  let vectors;
  let total;
  try {
    const info = (sessionId ? meta.get({ sessionId }) : meta.get()) ?? {};
    const msgLevel = Math.max(0, Math.trunc(Number(store.countMsgVec()) || 0));
    const fingerprinted = Math.max(0, Math.trunc(Number(info.indexed) || 0));
    total = Math.max(0, Math.trunc(Number(info.total) || 0));

    if (!sessionId) {
      vectors = Math.max(msgLevel, fingerprinted);
    } else if (fingerprinted === 0 && msgLevel > 0) {
      const globalTotal = Math.max(0, Math.trunc(Number(meta.get()?.total) || 0));
      vectors = globalTotal > 0 && globalTotal === total ? msgLevel : 0;
    } else {
      vectors = fingerprinted;
    }
  } catch {
    return { usable: true, tag: null, note: null, vectors: null, total: null, ratio: null };
  }

  if (vectors === 0) {
    return {
      usable: false,
      tag: SEMANTIC_EMPTY_TAG,
      note:
        `${SEMANTIC_EMPTY_TAG} 索引还没建（${fmtCount(vectors)} / ${fmtCount(total)} 条）` +
        '；面板 [重建] 可补（要 embedding key）',
      vectors,
      total,
      ratio: 0,
    };
  }

  const ratio = total > 0 ? vectors / total : 1;
  if (ratio < minCoverage) {
    return {
      usable: false,
      tag: SEMANTIC_PARTIAL_TAG,
      note:
        `${SEMANTIC_PARTIAL_TAG} 索引只覆盖 ${fmtCount(vectors)}/${fmtCount(total)}` +
        `（${(ratio * 100).toFixed(1)}%），不是全库检索；面板 [重建] 可补全`,
      vectors,
      total,
      ratio,
    };
  }

  return { usable: true, tag: null, note: null, vectors, total, ratio };
}

/**
 * 解析语义路：显式注入 > 从 handle + 全局配置自动装配。
 */
export function resolveSemantic(injected = {}, ctx = {}, extras = {}) {
  if (injected.semantic === false || ctx.semantic === false) {
    return { ok: false, reason: `${SEMANTIC_OFF_PREFIX}（调用方关掉了语义路）` };
  }

  const provider = ctx.provider ?? injected.provider ?? null;
  const store = ctx.store ?? injected.store ?? null;
  if (provider && store) return { ok: true, reason: null, provider, store };

  const handle = ctx.handle ?? injected.handle ?? null;
  if (!handle) {
    return { ok: false, reason: `${SEMANTIC_OFF_PREFIX}（这次调用没有库连接，拿不到向量索引）` };
  }

  let state;
  let signature = null;
  try {
    const { loadGlobalConfig, embeddingReady } = globalConfigModule;
    const { config } = loadGlobalConfig(
      handle.dshHome ? { dshHome: handle.dshHome } : undefined,
    );
    const emb = config?.embedding ?? {};
    const envName = typeof emb.apiKeyEnv === 'string' ? emb.apiKeyEnv : '';
    const envPresent = Boolean(envName && process.env[envName]);
    signature = JSON.stringify([
      emb.mode ?? 'remote',
      emb.model ?? '',
      emb.dim ?? 1024,
      emb.baseUrl ?? '',
      emb.apiKey ?? '',
      envName,
      envPresent,
      emb.maxBatch ?? 32,
    ]);

    const cached = semanticCache.get(handle);
    if (cached && cached.signature === signature && cached.state?.ok) {
      return cached.state;
    }

    const ready = embeddingReady(config);
    if (!ready.ready) {
      state = { ok: false, reason: `${SEMANTIC_OFF_PREFIX}：${ready.reason}` };
    } else if (!extras?.vecMeta?.assert) {
      state = { ok: false, reason: `${SEMANTIC_OFF_PREFIX}（这个库没提供向量索引接口）` };
    } else {
      const { createSiliconFlowEmbedding } = embeddingModule;
      const { createVectorStore } = vectorStoreModule;
      const builtProvider = createSiliconFlowEmbedding({
        model: emb.model,
        dim: emb.dim,
        maxBatch: emb.maxBatch,
        baseURL: emb.baseUrl,
        apiKey: typeof emb.apiKey === 'string' && emb.apiKey.trim() ? emb.apiKey.trim() : undefined,
        apiKeyEnv: envName,
        local: emb.mode === 'local',
      });
      const builtStore = createVectorStore(handle, {
        dim: builtProvider.dim,
        logger: injected.logger ?? { warn: () => {} },
      });
      state = {
        ok: true,
        reason: null,
        provider: builtProvider,
        store: builtStore,
      };
    }
  } catch (error) {
    state = {
      ok: false,
      reason: `${SEMANTIC_OFF_PREFIX}：向量索引装配失败（${error?.message ?? error}）`,
    };
  }
  if (state.ok && signature) semanticCache.set(handle, { signature, state });
  return state;
}

export async function resolveReranker(injected) {
  if (injected.rerank === false) return null;
  if (injected.reranker) return { reranker: injected.reranker, topN: Number(injected.rerankTopN) || RERANK_TOPN_DEFAULT };
  if (injected.provider || injected.store || injected.semantic === false) return null;

  try {
    await loadSemanticModules();
    const { loadGlobalConfig, rerankReady } = globalConfigModule;
    const { config } = loadGlobalConfig({ dshHome: injected.dshHome });
    const ready = rerankReady(config);
    if (!ready.ready) return null;
    const r = config.rerank;
    const reranker = rerankModule.createReranker({
      model: r.model,
      baseURL: r.baseUrl,
      apiKey: typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey.trim() : undefined,
      apiKeyEnv: r.apiKeyEnv,
      local: r.mode === 'local',
      timeoutMs: r.timeoutMs,
    });
    const topN = Number.isInteger(r.topN) && r.topN > 0 ? r.topN : RERANK_TOPN_DEFAULT;
    return { reranker, topN };
  } catch {
    return null;
  }
}

function buildRerankDoc(hit, repo, sceneMsgsCache) {
  if (hit?.rerankDoc) return String(hit.rerankDoc);
  if (hit?.window?.text) return String(hit.window.text);
  if (hit?.chunk && Number.isFinite(hit.chunk.startChar) && Number.isFinite(hit.chunk.endChar)) {
    const raw = String(hit.text ?? '');
    const slice = raw.slice(hit.chunk.startChar, hit.chunk.endChar);
    return formatChunkWithContext(raw, slice, hit.chunk.idx, hit.chunk.startChar);
  }
  const baseText = String(hit?.text ?? hit?.snippet ?? '');
  if (baseText.length >= 300 || !repo || typeof repo.msgsByScene !== 'function') {
    return baseText;
  }
  const sid = hit?.sceneId === null || hit?.sceneId === undefined ? null : Number(hit.sceneId);
  if (!Number.isSafeInteger(sid) || sid <= 0) return baseText;
  try {
    let scMsgs = sceneMsgsCache.get(sid);
    if (!scMsgs) {
      scMsgs = repo.msgsByScene(sid, false);
      sceneMsgsCache.set(sid, scMsgs);
    }
    const idx = scMsgs.findIndex((m) => Number(m.id) === Number(hit.id));
    if (idx < 0) return baseText;
    const from = Math.max(0, idx - 2);
    const to = Math.min(scMsgs.length - 1, idx + 2);
    const parts = [];
    let totalLen = 0;
    for (let i = from; i <= to; i += 1) {
      const m = scMsgs[i];
      const t = String(m.text ?? '').trim();
      if (!t) continue;
      const piece = i === idx ? t : (t.length > 200 ? `${t.slice(0, 200)}…` : t);
      if (i !== idx && totalLen + piece.length > 700) continue;
      parts.push(`${speakerLabel(m.speaker)}：${piece}`);
      totalLen += piece.length;
    }
    return parts.length > 0 ? parts.join('\n') : baseText;
  } catch {
    return baseText;
  }
}

export async function applyRerank(rerankCfg, query, hits, repo = null) {
  if (!rerankCfg?.reranker || !Array.isArray(hits) || hits.length <= 1) {
    return { hits, reranked: false, rerankError: null, rerankModel: null };
  }
  const topN = Math.min(rerankCfg.topN || RERANK_TOPN_DEFAULT, hits.length);
  const head = hits.slice(0, topN);
  const tail = hits.slice(topN);
  try {
    const sceneMsgsCache = new Map();
    const docs = head.map((h) => buildRerankDoc(h, repo, sceneMsgsCache));
    const ranked = await rerankCfg.reranker.rerank(query, docs, { topN });
    if (!Array.isArray(ranked) || ranked.length === 0) {
      return { hits, reranked: false, rerankError: null, rerankModel: rerankCfg.reranker.model ?? null };
    }
    const used = new Set();
    const reordered = [];
    for (const r of ranked) {
      used.add(r.index);
      reordered.push({ ...head[r.index], rerankScore: r.score });
    }
    for (let i = 0; i < head.length; i += 1) {
      if (!used.has(i)) reordered.push(head[i]);
    }
    return {
      hits: [...reordered, ...tail],
      reranked: true,
      rerankError: null,
      rerankModel: rerankCfg.reranker.model ?? null,
    };
  } catch (error) {
    return {
      hits,
      reranked: false,
      rerankError: error?.message ?? String(error),
      rerankModel: rerankCfg.reranker.model ?? null,
    };
  }
}

export function weakEvidenceHint(hits, keywordHits = 0, rerankModel = '') {
  const list = Array.isArray(hits) ? hits : [];
  const rrScores = list.map((h) => h?.rerankScore).filter((s) => typeof s === 'number');
  if (rrScores.length > 0) {
    const floor = /qwen3[-_ ]?reranker/i.test(String(rerankModel ?? ''))
      ? WEAK_QWEN3_RERANK_FLOOR
      : WEAK_RERANK_FLOOR;
    const topRR = Math.max(...rrScores);
    if (topRR < floor) {
      return `⚠ 相关度偏低（重排最高 ${topRR.toFixed(2)}）：下面几条可能只是话题相近，未必真的回答了你要找的事。请先读原文自行确认，对不上就换更具体的说法或指定时间再搜一次。`;
    }
  }
  if (keywordHits > 0) return null;
  const scores = list
    .map((h) => h?.score)
    .filter((s) => typeof s === 'number');
  if (scores.length === 0) return null;
  const top1 = Math.max(...scores);
  if (top1 >= WEAK_TOP1_FLOOR) return null;
  return `⚠ 相关度偏低（最高 ${top1.toFixed(2)}）：下面几条可能只是话题相近，未必真的回答了你要找的事。请先读原文自行确认，对不上就换更具体的说法或指定时间再搜一次。`;
}

function hydrateWindowHit(win, { repo, includeExcluded, queryTerms = [], bounds = null, sceneMsgsCache = new Map() }) {
  if (!win || !repo) return null;
  const sid = Number(win.sceneId);
  let smsgs = [];
  if (Number.isSafeInteger(sid) && sid > 0 && typeof repo.msgsByScene === 'function') {
    if (sceneMsgsCache.has(sid)) {
      smsgs = sceneMsgsCache.get(sid);
    } else {
      try {
        smsgs = repo.msgsByScene(sid, includeExcluded);
      } catch {
        smsgs = [];
      }
      sceneMsgsCache.set(sid, smsgs);
    }
  }
  const startId = Number(win.startMsgId);
  const endId = Number(win.endMsgId);
  const inWin = smsgs.filter((m) => Number(m.id) >= startId && Number(m.id) <= endId);
  let anchor = null;
  if (inWin.length > 0) {
    if (queryTerms.length > 0) {
      anchor = inWin.find((m) => {
        const t = String(m.text ?? '');
        return queryTerms.some((term) => term && t.includes(term));
      }) ?? null;
    }
    if (!anchor) {
      anchor = inWin.find((m) => m.speaker === 'user' && String(m.text ?? '').trim().length >= 4) ?? inWin[0];
    }
  } else if (typeof repo.msgsByIds === 'function' && Number.isSafeInteger(startId)) {
    try {
      const [m] = repo.msgsByIds([startId]);
      if (m && (includeExcluded || Number(m.excluded) !== 1)) anchor = m;
    } catch {
      anchor = null;
    }
  }
  if (!anchor) return null;
  if (bounds && (anchor.at < bounds.from || anchor.at >= bounds.to)) return null;
  return {
    ...anchor,
    sceneStartAt: win.sceneStartAt ?? anchor.sceneStartAt ?? win.startAt,
    sceneEndAt: win.sceneEndAt ?? anchor.sceneEndAt ?? win.endAt,
    sceneMsgCount: win.sceneMsgCount ?? anchor.sceneMsgCount ?? win.msgCount,
    ...(typeof win.score === 'number' ? { score: win.score } : {}),
    ...(typeof win.distance === 'number' ? { distance: win.distance } : {}),
    window: {
      id: Number(win.windowId ?? win.id),
      kind: String(win.kind ?? 'window'),
      startMsgId: startId,
      endMsgId: endId,
      msgCount: Number(win.msgCount ?? inWin.length),
      text: String(win.text ?? ''),
    },
  };
}

export async function runVectorRoute({
  provider, store, extras, query, sessionId, bounds, includeExcluded, perRoute, repo,
  disableWindowVector = false,
  vectorMinScore = VECTOR_MIN_SCORE,
  windowQuota = 1.0,
  chunkAsSeparateRoute = false,
}) {
  extras.vecMeta.assert(provider);
  const modelTag = String(provider?.model ?? provider?.id ?? '');
  const isQwen3Emb = /qwen3[-_ ]?embedding/i.test(modelTag);
  const embedQuery = isQwen3Emb && !String(query).startsWith('Instruct:')
    ? `Instruct: Given a conversation search query, retrieve relevant dialogue messages and events\nQuery: ${query}`
    : query;
  const [vec] = await provider.embed([embedQuery]);
  if (!vec) return { hits: [], chunkRoute: [], exchangeRoute: [], threadRoute: [] };
  const filter = { sessionId, includeExcluded, limit: perRoute };
  if (bounds) {
    filter.from = bounds.from;
    filter.to = bounds.to;
  }
  filter.minScore = vectorMinScore;

  const msgHits = store.knnMsg(vec, perRoute, filter);
  const chunkHits = typeof store.knnChunk === 'function'
    ? store.knnChunk(vec, perRoute, filter)
    : [];

  const ids = [...new Set(chunkHits.map((h) => h.msgId))];
  let rowsById = new Map();
  if (ids.length > 0) {
    try {
      const rows = repo.msgsByIds(ids);
      for (const r of rows) rowsById.set(Number(r.id), r);
    } catch {
      rowsById = new Map();
    }
  }

  const chunksByMsg = new Map();
  for (const h of chunkHits) {
    const k = Number(h.msgId);
    if (!chunksByMsg.has(k)) chunksByMsg.set(k, []);
    chunksByMsg.get(k).push(h);
  }
  for (const arr of chunksByMsg.values()) arr.sort((a, b) => b.score - a.score);

  const chunkAsMsg = [];
  for (const [msgId, segs] of chunksByMsg) {
    const row = rowsById.get(msgId);
    if (!row) continue;
    if (bounds && (row.at < bounds.from || row.at >= bounds.to)) continue;
    if (!includeExcluded && Number(row.excluded) === 1) continue;
    let totalChunks = null;
    try { totalChunks = extras?.chunk?.count?.(msgId) || null; } catch { totalChunks = null; }
    const top = segs[0];
    chunkAsMsg.push({
      ...row,
      score: top.score,
      distance: top.distance,
      chunk: {
        idx: top.idx,
        startChar: top.startChar,
        endChar: top.endChar,
        total: totalChunks,
      },
      chunkSegments: segs.map((s) => ({
        idx: s.idx,
        startChar: s.startChar,
        endChar: s.endChar,
        score: s.score,
      })),
    });
  }

  const merged = new Map();
  for (const r of msgHits) merged.set(Number(r.id), r);
  if (!chunkAsSeparateRoute) {
    for (const r of chunkAsMsg) {
      const prev = merged.get(Number(r.id));
      if (!prev || (r.score ?? 0) > (prev.score ?? 0)) merged.set(Number(r.id), r);
      else if (prev) prev.chunk = r.chunk;
    }
  }

  const exchangeHits = [];
  const threadHits = [];
  if (!includeExcluded && typeof store.knnWindow === 'function' && repo && disableWindowVector !== true) {
    try {
      const quota = Number.isFinite(windowQuota) && windowQuota >= 0 ? windowQuota : 1.0;
      const winLimit = Math.max(1, Math.round(perRoute * quota));
      const winFetch = Math.max(winLimit * 3, 48);
      const winHits = store.knnWindow(vec, winFetch, {
        sessionId,
        from: bounds?.from,
        to: bounds?.to,
        minScore: vectorMinScore,
      });
      const hasTypedWindows = Array.isArray(winHits) && winHits.some((w) => w.kind === 'exchange' || w.kind === 'thread');
      if (hasTypedWindows) {
        const extraThreads = store.knnWindow(vec, 20, {
          sessionId,
          from: bounds?.from,
          to: bounds?.to,
          minScore: vectorMinScore,
          kind: 'thread',
          overFetch: 16,
        });
        const seenWinIds = new Set(winHits.map((w) => Number(w.id)));
        for (const th of extraThreads) {
          if (!seenWinIds.has(Number(th.id))) {
            seenWinIds.add(Number(th.id));
            winHits.push(th);
          }
        }
      }
      if (Array.isArray(winHits) && winHits.length > 0) {
        const sceneMsgsCache = new Map();
        const queryTerms = splitTerms(query);
        for (const wh of winHits) {
          const mapped = hydrateWindowHit(wh, { repo, includeExcluded, queryTerms, bounds, sceneMsgsCache });
          if (!mapped) continue;
          const kind = mapped.window?.kind ?? 'window';
          if (kind === 'exchange') {
            exchangeHits.push(mapped);
            continue;
          }
          if (kind === 'thread') {
            threadHits.push(mapped);
            continue;
          }
          const mid = Number(mapped.id);
          const prev = merged.get(mid);
          if (!prev || (mapped.score ?? 0) > (prev.score ?? 0)) {
            merged.set(mid, prev ? { ...prev, ...mapped, window: mapped.window } : mapped);
          } else if (prev && !prev.window) {
            prev.window = mapped.window;
          }
        }
      }
    } catch {
      // vec_window 未建或不可用时静默跳过
    }
  }

  if (SCENE_FALLBACK_ENABLED && typeof store.knnScene === 'function' && repo && typeof repo.msgsByScene === 'function') {
    try {
      const sceneHits = store.knnScene(vec, Math.min(perRoute, 6), {
        sessionId,
        from: bounds?.from,
        to: bounds?.to,
        minScore: Math.max(vectorMinScore, 0.56),
      });
      if (Array.isArray(sceneHits) && sceneHits.length > 0) {
        const coveredScenes = new Set(
          [...merged.values()]
            .map((r) => (r.sceneId === null || r.sceneId === undefined ? null : Number(r.sceneId)))
            .filter((x) => x !== null),
        );
        for (const sh of sceneHits) {
          const sid = Number(sh.id);
          if (!Number.isSafeInteger(sid) || coveredScenes.has(sid)) continue;
          const smsgs = repo.msgsByScene(sid, includeExcluded);
          if (!smsgs || smsgs.length === 0) continue;
          const anchor = smsgs.find((m) => m.speaker === 'user' && String(m.text ?? '').trim().length >= 6) ?? smsgs[0];
          if (!anchor) continue;
          if (bounds && (anchor.at < bounds.from || anchor.at >= bounds.to)) continue;
          if (!merged.has(Number(anchor.id))) {
            merged.set(Number(anchor.id), {
              ...anchor,
              sceneStartAt: sh.startAt ?? anchor.at,
              sceneEndAt: sh.endAt ?? anchor.at,
              sceneMsgCount: sh.msgCount ?? smsgs.length,
              score: sh.score,
              distance: sh.distance,
            });
            coveredScenes.add(sid);
          }
        }
      }
    } catch {
      // vec_scene 未建或不可用时静默跳过
    }
  }

  const sortedRaw = [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const mainHits = dedupeBySpan(sortedRaw, { mode: 'score', limit: perRoute });

  if (chunkAsSeparateRoute) {
    const mainIds = new Set(mainHits.map((h) => Number(/** @type {any} */ (h).id)));
    const extraChunks = chunkAsMsg
      .filter((r) => !mainIds.has(Number(r.id)))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, perRoute);
    return { hits: mainHits, chunkRoute: extraChunks, exchangeRoute: exchangeHits, threadRoute: threadHits };
  }

  return { hits: mainHits, chunkRoute: [], exchangeRoute: exchangeHits, threadRoute: threadHits };
}

export function hydrateEnclosingThreads(extras, items) {
  if (typeof extras?.window?.byScene !== 'function' || !Array.isArray(items) || items.length === 0) return;
  const cache = new Map();
  for (const item of items) {
    if (!item || item.window?.kind === 'thread' || item.sceneId == null) continue;
    const scId = Number(item.sceneId);
    if (!cache.has(scId)) {
      try { cache.set(scId, extras.window.byScene(scId) ?? []); }
      catch { cache.set(scId, []); }
    }
    const mid = Number(item.id);
    const th = cache.get(scId).find(
      (w) => w.kind === 'thread' && mid >= Number(w.startMsgId) && mid <= Number(w.endMsgId),
    );
    if (th) {
      if (item.window?.kind === 'exchange' && !item.focusExchange) {
        item.focusExchange = {
          startMsgId: Number(item.window.startMsgId),
          endMsgId: Number(item.window.endMsgId),
        };
      }
      item.window = th;
    }
  }
}

export function semanticNote(semantic, meta, vectorIndex = null) {
  const trimTail = (text) => String(text ?? '').replace(/[。.\s]+$/u, '');
  if (!semantic.ok) return `${SEMANTIC_OFF_TAG} ${trimTail(semantic.reason)}`;
  if (vectorIndex?.note) return vectorIndex.note;
  if (meta?.degraded && meta.vectorError) return `vec:err ${trimTail(meta.vectorError)}`;
  return null;
}
