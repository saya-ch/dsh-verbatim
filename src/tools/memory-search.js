// @ts-check
/**
 * memory_search —— 合并检索（时间路 + 关键词路 + 语义路）
 *
 * 参数组合决定走哪条路：
 *   只有 query  → 关键词路 + 语义路（RRF 融合）
 *   只有 when   → 时间路：返回场景 + 摘录
 *   when + query → 时间路先圈出候选场景，再在候选里匹配（关键词 + 语义）
 *   都没有      → 列最近一次聊天
 *
 * 语义路 / 精排实现拆至 ./vector-route.js；
 * 场景与笔记排版拆至 ./search-render.js。
 */

import {
  clipInline,
  emptyText,
  fmtCount,
  resolveTzOffsetMs,
} from './format.js';
import { createExtras, createRepo, getDefaultExtras, getDefaultRepo } from '../store/repo.js';
import { resolveSessionId, sessionStats } from './scope.js';
import { runTimeOnlyRoute, resolveTimeWindow } from './time-route.js';
import { searchWithRRF, fuseRRF } from '../search/rrf.js';
import { createSpanIndex } from '../search/dedupe.js';
import { foldTimelineClusters } from '../search/thread.js';
import {
  NOTE_MIN_SCORE_DEFAULT,
  PINNED_NOTE_MAX_DEFAULT,
  searchRankedNotes,
} from '../search/note-rank.js';
import {
  DEFAULT_MIN_INDEX_COVERAGE,
  VECTOR_MIN_SCORE,
  WEAK_TOP1_FLOOR,
  WEAK_RERANK_FLOOR,
  WEAK_QWEN3_RERANK_FLOOR,
  applyRerank,
  assessVectorIndex,
  candidateSceneIds,
  getLoadedGlobalConfigModule,
  hydrateEnclosingThreads,
  loadSemanticModules,
  resolveMinIndexCoverage,
  resolveReranker,
  resolveSemantic,
  restrictToCandidates,
  runVectorRoute,
  semanticNote,
  weakEvidenceHint,
  windowBounds,
} from './vector-route.js';
import {
  emptySearchText,
  formatTrashHint,
  renderNote,
  renderNotesOnly,
  renderShown,
  selectNotes,
} from './search-render.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const QUERY_LABEL_MAX = 40;
const NOTE_PROBE = 2000;

export const SEARCH_SCOPES = Object.freeze(['msg', 'note', 'all']);
export { WEAK_TOP1_FLOOR, WEAK_RERANK_FLOOR, WEAK_QWEN3_RERANK_FLOOR, weakEvidenceHint };

/** handle → 会话形态判别结果（决定 windowQuota / compactTime） */
const shapeCache = new WeakMap();

function resolveDeps(injected = {}, ctx = {}) {
  const handle = ctx.handle ?? injected.handle ?? null;
  const repo = ctx.repo ?? injected.repo ?? (handle ? createRepo(handle) : getDefaultRepo());
  const extras =
    ctx.extras ?? injected.extras ?? (handle ? createExtras(handle) : getDefaultExtras());
  return { repo, extras, handle };
}

function resolveNow(injected = {}, ctx = {}) {
  const candidate = ctx.now ?? injected.now;
  const value = typeof candidate === 'function' ? candidate() : candidate;
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function clampLimit(limit, fallback = DEFAULT_LIMIT) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

function safeStats(extras, sessionId = null) {
  return sessionStats(extras, sessionId);
}

/* ================================ 工具定义 ================================ */

export const SEARCH_DESCRIPTION =
  '按时间或按意思翻以前说过的话与笔记。只看某段时间聊了什么 → 填 when（如 2026-11-09、11-09、2026-11、2026-11-09..2026-11-12 或 7d）。'
  + '找某句话、某件事或某种感觉 → 填 query；两个都填 = 在该时间段里找。都不填 → 看最近一次聊天。'
  + '被用户设为不回想/排除的记录不会返回。scope 填 note 可只翻你自己记过的笔记（含回收站提示）。'
  + '\n\n'
  + '【返回说明】\n'
  + '· 说话人：`他`=对方， `我`=你自己；`←` 标出本次命中的原话（完整不截断）。\n'
  + '· 若某场对话过长被折叠，会给出省略区间，可用 `when` 填该区间单独展开。';

export const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      maxLength: 200,
      description:
        '要找的词、句子或模糊印象。和 when 一起给 = 在该时间范围里找；scope 为 note 时留空 = 列出最近笔记（含回收站可用 ID）。',
    },
    when: {
      type: 'string',
      description:
        '标准日期或区间（默认上海时间）：单日（2026-11-09 / 11-09）、整月（2026-11）、区间（2026-11-09..2026-11-12）、最近天数（7d、30d）。留空不限时间。',
    },
    limit: {
      type: 'number',
      description: '最多返回几条；只按时间翻时为展开场数（默认 3 场），找原话时默认 8 条。',
    },
    scope: {
      type: 'string',
      enum: ['msg', 'note', 'all'],
      description:
        '不填（默认）= 翻对话原话并自动置顶高相关笔记（最多 3 条）；msg = 仅翻原话；note = 仅翻你的笔记；all = 两边完整检索。',
    },
    expand: {
      type: 'string',
      enum: ['auto', 'scene', 'snippet'],
      description:
        '上下文展开程度：auto（默认）= 自适应；scene = 整场完整往来；snippet = 仅命中句及紧邻一两句。',
    },
  },
  additionalProperties: false,
};

/**
 * 造一个 memory_search 工具（M1 合并版）。
 */
export function createSearchTool(deps = {}) {
  return {
    name: 'memory_search',
    description: SEARCH_DESCRIPTION,
    parameters: SEARCH_PARAMETERS,

    async handler(args = {}, ctx = {}) {
      const now = resolveNow(deps, ctx);
      const sessionId = resolveSessionId(deps, ctx);
      try {
        const { repo, extras, handle } = resolveDeps(deps, ctx);
        const stats = safeStats(extras, sessionId);
        const includeExcluded = (deps?.allowExcluded === true || ctx?.allowExcluded === true)
          && Boolean(args?.includeExcluded);
        const disableWindowVector = deps.disableWindowVector === true || ctx.disableWindowVector === true;

        let windowQuota = Number.isFinite(deps.windowQuota) ? deps.windowQuota : null;
        let compactTime = typeof deps.compactTime === 'boolean' ? deps.compactTime : null;
        if (windowQuota === null || compactTime === null) {
          try {
            let perDb = shapeCache.get(handle);
            if (!perDb) {
              perDb = new Map();
              shapeCache.set(handle, perDb);
            }
            const cacheKey = String(sessionId ?? '');
            const cachedShape = perDb.get(cacheKey);
            const curMsgs = Number(stats?.msgs ?? 0);
            const isStale = !cachedShape
              || Math.abs(curMsgs - cachedShape.msgs) >= 20
              || (now - cachedShape.checkedAt) > 300_000;
            if (isStale) {
              const { detectSessionShape } = await import('../search/session-shape.js');
              perDb.set(cacheKey, {
                shape: detectSessionShape(handle, sessionId),
                msgs: curMsgs,
                checkedAt: now,
              });
            }
            const shape = perDb.get(cacheKey).shape;
            if (windowQuota === null) windowQuota = shape.windowQuota ?? 1.0;
            if (compactTime === null) compactTime = shape.shape === 'companion';
          } catch {
            if (windowQuota === null) windowQuota = 1.0;
            if (compactTime === null) compactTime = false;
          }
        }

        const limit = clampLimit(args?.limit);
        const rawScope = String(args?.scope ?? '').trim().toLowerCase();
        const explicitScope = SEARCH_SCOPES.includes(rawScope) ? rawScope : null;
        const scope = explicitScope ?? 'msg';
        const expand = ['scene', 'snippet'].includes(args?.expand) ? args.expand : 'auto';
        const query = String(args?.query ?? '').trim();
        const queryLabel = clipInline(query, QUERY_LABEL_MAX);
        const wantMsg = scope !== 'note';
        const wantNote = scope !== 'msg';
        const wantPinnedNotes = explicitScope === null && query !== '';
        const hasQuery = query !== '';
        const wantSemantic = (wantMsg || wantNote || wantPinnedNotes) && hasQuery;

        if (wantSemantic) await loadSemanticModules();

        let configuredTzOffsetMs;
        if (Number.isFinite(Number(ctx?.tzOffsetMs ?? deps?.tzOffsetMs))) {
          configuredTzOffsetMs = Number(ctx?.tzOffsetMs ?? deps?.tzOffsetMs);
        } else {
          const gcMod = getLoadedGlobalConfigModule();
          if (gcMod?.loadGlobalConfig) {
            try {
              const { config: gCfg } = gcMod.loadGlobalConfig(
                handle?.dshHome ? { dshHome: handle.dshHome } : undefined,
              );
              const tzMin = gCfg?.search?.timezoneOffsetMinutes;
              if (Number.isFinite(Number(tzMin))) configuredTzOffsetMs = Number(tzMin) * 60_000;
            } catch { /* ignore */ }
          }
        }
        const tzOffsetMs = resolveTzOffsetMs(configuredTzOffsetMs);

        const window = resolveTimeWindow(args, now, { tzOffsetMs });
        const semantic = wantSemantic
          ? resolveSemantic({ ...deps, handle }, ctx, extras)
          : { ok: false, reason: null };

        /* -------------------- ① 没看懂的时间词 -------------------- */
        if (window.kind === 'unknown') {
          return emptyText({
            head: `没看懂「${window.label}」指的是哪段时间。`,
            stats,
            tips: [
              'when 请用标准格式：例如 "2026-11-09"、"11-09"、"2026-11"、"2026-11-09..2026-11-12" 或 "7d"。',
              '不填 when 且不填 query 时，会返回最近一次聊天。',
            ],
          });
        }

        const bounds = windowBounds(window);
        const dshHome = deps?.dshHome || ctx?.dshHome || null;

        /* -------------------- ② 只有时间（或什么都没有） -------------------- */
        if (!hasQuery) {
          const timeText = wantMsg
            ? runTimeOnlyRoute({
                repo,
                sessionId,
                now,
                extras,
                window,
                limit: args?.limit,
                includeExcluded,
                dshHome,
              })
            : null;

          if (!wantNote) return timeText;

          const notes = selectNotes({ extras, sessionId, window, query: '', limit });
          if (!wantMsg) return renderNotesOnly(notes, { stats, window, limit, extras, sessionId, aboutLabels: deps.aboutLabels ?? null });
          if (notes.length === 0) return timeText;
          return `${timeText}\n\n${renderNotesOnly(notes, { stats, window, limit, extras, sessionId, aboutLabels: deps.aboutLabels ?? null })}`;
        }

        /* -------------------- ③ 有 query：关键词 + 语义 -------------------- */
        if (wantMsg && typeof extras?.search?.keyword !== 'function') {
          return [
            '检索能力不可用：这个库没提供 extras.search.keyword。',
            '（不是「没聊过」，是仓储层缺少关键词检索接口。）',
          ].join('\n');
        }

        const allowed = candidateSceneIds(repo, sessionId, bounds);

        let earlyRerankCfg = null;
        if (wantMsg) {
          try {
            earlyRerankCfg = await resolveReranker({ ...deps, ...ctx });
          } catch {
            earlyRerankCfg = null;
          }
        }
        const perRoute = earlyRerankCfg
          ? Math.max(limit * 3, 24)
          : Math.max(limit * 2, DEFAULT_LIMIT);

        let rows = [];
        let msgTotal = 0;
        if (wantMsg) {
          const searchOptions = { sessionId, includeExcluded };
          if (bounds) {
            searchOptions.from = bounds.from;
            searchOptions.to = bounds.to;
          }
          rows = extras.search.keyword(query, { ...searchOptions, limit: perRoute }) ?? [];
          rows = restrictToCandidates(rows, allowed);
          if (!bounds && rows.length < perRoute) {
            msgTotal = rows.length;
          } else {
            const countKeyword = extras?.search?.countKeyword;
            msgTotal =
              typeof countKeyword === 'function'
                ? Math.max(0, Math.trunc(Number(countKeyword(query, searchOptions)) || 0))
                : rows.length;
          }
        }

        let vectorIndex = null;
        if (wantMsg && semantic.ok) {
          vectorIndex = assessVectorIndex({
            semantic,
            extras,
            minCoverage: resolveMinIndexCoverage(deps),
            sessionId,
          });
        }
        let hits = rows;
        let semanticMeta = null;
        if (wantMsg && semantic.ok && vectorIndex?.usable !== false) {
          let vectorHits = [];
          let chunkRoute = [];
          let exchangeRoute = [];
          let threadRoute = [];
          let vectorError = null;
          try {
            const vr = await runVectorRoute({
              provider: semantic.provider,
              store: semantic.store,
              extras,
              repo,
              query,
              sessionId,
              bounds,
              includeExcluded,
              perRoute,
              disableWindowVector,
              vectorMinScore: Number.isFinite(deps.vectorMinScore) ? deps.vectorMinScore : VECTOR_MIN_SCORE,
              windowQuota,
              chunkAsSeparateRoute: deps.chunkAsSeparateRoute === true || ctx.chunkAsSeparateRoute === true,
            });
            vectorHits = vr.hits ?? [];
            chunkRoute = vr.chunkRoute ?? [];
            exchangeRoute = vr.exchangeRoute ?? [];
            threadRoute = vr.threadRoute ?? [];
          } catch (error) {
            vectorError = error;
          }

          const f2 = chunkRoute.length > 0;
          const hasMultiGranular = !vectorError && (exchangeRoute.length > 0 || threadRoute.length > 0);
          const parentThreads = [];
          if (hasMultiGranular && typeof extras?.window?.byScene === 'function') {
            const touchedScenes = new Set();
            for (const list of [rows, vectorHits, exchangeRoute, threadRoute]) {
              for (const item of list) {
                if (item?.sceneId !== null && item?.sceneId !== undefined) touchedScenes.add(Number(item.sceneId));
              }
            }
            const seenTh = new Set(threadRoute.map((t) => Number(t.window?.id)));
            for (const scId of touchedScenes) {
              try {
                for (const w of extras.window.byScene(scId) ?? []) {
                  if (w.kind !== 'thread' || seenTh.has(Number(w.id))) continue;
                  seenTh.add(Number(w.id));
                  parentThreads.push({
                    id: Number(w.startMsgId),
                    sceneId: Number(w.sceneId),
                    window: {
                      id: Number(w.id),
                      kind: 'thread',
                      startMsgId: Number(w.startMsgId),
                      endMsgId: Number(w.endMsgId),
                      msgCount: Number(w.msgCount),
                      text: String(w.text ?? ''),
                    },
                  });
                }
              } catch { /* ignore */ }
            }
          }
          const spanLists = [rows, vectorHits];
          if (f2) spanLists.push(chunkRoute);
          if (exchangeRoute.length > 0) spanLists.push(exchangeRoute);
          if (threadRoute.length > 0) spanLists.push(threadRoute);
          if (parentThreads.length > 0) spanLists.push(parentThreads);
          const spanIndex = createSpanIndex(spanLists);

          let fused;
          const poolLimit = perRoute;
          const fetchPoolLimit = earlyRerankCfg && hasMultiGranular ? Math.max(poolLimit, 96) : poolLimit;
          if (f2 || hasMultiGranular) {
            if (vectorError) throw vectorError;
            const rawFused = /** @type {Array<Record<string, any>>} */ (fuseRRF(
              [
                { name: 'keyword', hits: rows },
                { name: 'vector', hits: vectorHits },
                ...(f2 ? [{ name: 'chunk', hits: chunkRoute }] : []),
                ...(exchangeRoute.length > 0 ? [{ name: 'exchange', hits: exchangeRoute }] : []),
                ...(threadRoute.length > 0 ? [{ name: 'thread', hits: threadRoute }] : []),
              ],
              {
                limit: fetchPoolLimit,
                keyOf: spanIndex.keyOf,
                ...(Number.isFinite(deps.rrfK) ? { k: deps.rrfK } : {}),
                ...(deps.rrfWeights ? { weights: deps.rrfWeights } : {}),
              },
            ));
            const bestWindowBySpan = new Map();
            for (const srcList of [parentThreads, threadRoute, exchangeRoute]) {
              for (const item of srcList) {
                if (!item?.window) continue;
                const k = spanIndex.keyOf(item);
                const prev = bestWindowBySpan.get(k);
                if (!prev || (prev.kind !== 'thread' && item.window.kind === 'thread')) {
                  bestWindowBySpan.set(k, item.window);
                }
              }
            }
            const bestDocBySpan = new Map();
            const bestExchangeBySpan = new Map();
            for (const item of exchangeRoute) {
              if (!item?.window?.text) continue;
              const k = spanIndex.keyOf(item);
              if (!bestDocBySpan.has(k)) {
                bestDocBySpan.set(k, String(item.window.text));
                bestExchangeBySpan.set(k, {
                  startMsgId: Number(item.window.startMsgId),
                  endMsgId: Number(item.window.endMsgId),
                });
              }
            }
            const fusedHits = rawFused.map((h) => {
              const k = h.fusionKey ?? spanIndex.keyOf(h);
              const bestWin = bestWindowBySpan.get(k);
              const win = bestWin && (!h.window || (h.window.kind !== 'thread' && bestWin.kind === 'thread'))
                ? bestWin
                : h.window;
              const focusEx = bestDocBySpan.get(k);
              const focusExRange = bestExchangeBySpan.get(k) ?? null;
              const rerankDoc = focusEx && win?.kind === 'thread' && focusEx !== win.text
                ? `[核心问答]\n${focusEx.slice(0, 700)}\n[微话题上下文]\n${String(win.text ?? '').slice(0, 450)}`
                : (focusEx ?? undefined);
              return {
                ...h,
                ...(win ? { window: win } : {}),
                ...(focusExRange && win?.kind === 'thread' ? { focusExchange: focusExRange } : {}),
                ...(rerankDoc ? { rerankDoc } : {}),
                sources: [...new Set((h.sources ?? []).map((s) => (s === 'exchange' || s === 'thread' ? 'vector' : s)))],
              };
            });
            fused = {
              hits: fusedHits,
              meta: {
                counts: {
                  time: 0,
                  keyword: rows.length,
                  vector: vectorHits.length + exchangeRoute.length + threadRoute.length,
                  chunk: chunkRoute.length,
                },
                usedRoutes: [
                  ...(rows.length > 0 ? ['keyword'] : []),
                  ...((vectorHits.length + exchangeRoute.length + threadRoute.length) > 0 ? ['vector'] : []),
                  ...(chunkRoute.length > 0 ? ['chunk'] : []),
                ],
                vectorSkipped: false,
                vectorSkipReason: null,
                vectorError: null,
                degraded: false,
                errors: [],
                notes: [],
                f2,
                multiGranular: hasMultiGranular,
              },
            };
          } else {
            fused = await searchWithRRF(
              {
                keyword: rows,
                vector: () => {
                  if (vectorError) throw vectorError;
                  return vectorHits;
                },
              },
              {
                limit: poolLimit,
                keyOf: spanIndex.keyOf,
                ...(Number.isFinite(deps.rrfK) ? { k: deps.rrfK } : {}),
                ...(deps.rrfWeights ? { weights: deps.rrfWeights } : {}),
              },
            );
          }
          const { dedupeBySpan } = await import('../search/dedupe.js');
          hits = dedupeBySpan(restrictToCandidates(fused.hits, allowed), { limit: fetchPoolLimit });
          if (hasMultiGranular && hits.length > poolLimit) {
            const keyOfHit = (h) => h.fusionKey ?? spanIndex.keyOf(h);
            const protectedKeys = new Set();
            for (const item of vectorHits.slice(0, 3)) protectedKeys.add(keyOfHit(item));
            for (const item of rows.slice(0, 3)) protectedKeys.add(keyOfHit(item));
            const top = hits.slice(0, poolLimit);
            const inTop = new Set(top.map((h) => keyOfHit(h)));
            const rescued = [];
            for (const h of hits.slice(poolLimit)) {
              const k = keyOfHit(h);
              if (protectedKeys.has(k) && !inTop.has(k)) {
                inTop.add(k);
                rescued.push(h);
              }
            }
            let rIdx = 0;
            for (let i = top.length - 1; i >= Math.max(limit, 8) && rIdx < rescued.length; i -= 1) {
              if (!protectedKeys.has(keyOfHit(top[i]))) {
                top[i] = rescued[rIdx++];
              }
            }
            hits = top;
          }
          semanticMeta = { ...fused.meta, spanGroups: spanIndex.groupCount };
        }

        if (wantMsg && hits.length > 1 && earlyRerankCfg) {
          const rr = await applyRerank(earlyRerankCfg, query, hits, repo);
          hits = rr.hits;
          if (rr.reranked || rr.rerankError) {
            semanticMeta = {
              ...(semanticMeta ?? {}),
              reranked: rr.reranked,
              rerankModel: rr.rerankModel,
              rerankError: rr.rerankError,
            };
          }
        }

        if ((compactTime || semanticMeta?.multiGranular) && hits.length > 1 && semantic.ok && typeof semantic.store?.getWindowVecs === 'function') {
          const winIds = hits.map((h) => Number(h.window?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
          if (winIds.length > 1) {
            const vecMap = semantic.store.getWindowVecs(winIds);
            hits = foldTimelineClusters(hits, (h) => vecMap.get(Number(/** @type {any} */ (h).window?.id)) ?? null, {
              threshold: 0.92,
              limit: Math.max(limit, hits.length),
            });
          }
        }

        const onResult = ctx.onResult ?? deps.onResult;
        if (typeof onResult === 'function') {
          try {
            const seenIds = new Set();
            const deduped = [];
            for (const row of /** @type {Array<Record<string, any>>} */ (hits)) {
              const id = Number(row.id);
              if (seenIds.has(id)) continue;
              seenIds.add(id);
              deduped.push(row);
            }
            const shownForResult = deduped.slice(0, limit).map((r) => ({ ...r }));
            if (wantMsg) hydrateEnclosingThreads(extras, shownForResult);
            onResult({
              hits,
              shownHits: shownForResult,
              meta: semanticMeta,
              semantic,
              keywordRows: rows,
              vectorIndex,
              windowQuota,
            });
          } catch { /* ignore */ }
        }

        // —— 笔记路 ——
        let noteHits = [];
        let pinnedNotes = [];
        if (wantNote || wantPinnedNotes) {
          const hasAnyNotes = typeof extras?.note?.count === 'function'
            ? extras.note.count({ sessionId }) > 0
            : true;
          if (hasAnyNotes) {
            const ranked = await searchRankedNotes({
              extras,
              sessionId,
              query,
              from: bounds?.from ?? null,
              to: bounds?.to ?? null,
              provider: semantic.ok ? semantic.provider : null,
              store: semantic.ok ? semantic.store : null,
              minScore: NOTE_MIN_SCORE_DEFAULT,
              limit: wantNote ? NOTE_PROBE : PINNED_NOTE_MAX_DEFAULT,
            });
            if (wantNote) noteHits = ranked.hits;
            else pinnedNotes = ranked.hits.slice(0, PINNED_NOTE_MAX_DEFAULT);
          }
        }

        /* -------------------- ④ 一条都没有 -------------------- */
        if (hits.length === 0 && noteHits.length === 0 && pinnedNotes.length === 0) {
          return emptySearchText({
            queryLabel,
            query,
            stats,
            bounds,
            window,
            hasQuery,
            wantNote: wantNote || wantPinnedNotes,
            semanticNoteText: wantMsg ? semanticNote(semantic, semanticMeta, vectorIndex) : null,
          });
        }

        /* -------------------- ④.5 低置信提示 -------------------- */
        const weakHint = wantMsg && hasQuery && hits.length > 0
          ? weakEvidenceHint(hits, rows.length, earlyRerankCfg?.model)
          : null;

        const seen = new Set();
        const unique = [];
        for (const row of hits) {
          const id = Number(row.id);
          if (seen.has(id)) continue;
          seen.add(id);
          unique.push({ ...row, _rank: unique.length + 1 });
        }
        let effectiveLimit = limit;
        if (wantMsg && hasQuery && expand === 'auto' && unique.length > 4 && semanticMeta?.reranked) {
          const rr0 = unique[0]?.rerankScore;
          const rr1 = unique[1]?.rerankScore;
          if (typeof rr0 === 'number' && rr0 >= 0.78 && (typeof rr1 !== 'number' || rr0 - rr1 >= 0.25)) {
            effectiveLimit = Math.min(limit, 4);
          }
        }
        const shown = unique.slice(0, effectiveLimit).sort((a, b) => a.at - b.at);
        if (wantMsg) hydrateEnclosingThreads(extras, shown);
        const msgHitTotal = Math.max(msgTotal, unique.length);
        const msgTotalText = `${fmtCount(msgHitTotal)} 处`;

        const activeNotes = wantNote ? noteHits : pinnedNotes;
        const noteTotal = activeNotes.length;
        const noteTouchedCap = wantNote && noteTotal >= NOTE_PROBE;
        const shownNotes = wantNote
          ? [...activeNotes]
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.at - a.at || b.id - a.id)
              .slice(0, limit)
              .sort((a, b) => a.at - b.at || a.id - a.id)
          : [...activeNotes];
        const noteTotalText = noteTouchedCap
          ? `${fmtCount(NOTE_PROBE)} 条以上`
          : `${fmtCount(noteTotal)} 条`;

        const rangeHint = bounds ? `（只在 ${window.label} 里找）` : '';
        const note = wantMsg ? semanticNote(semantic, semanticMeta, vectorIndex) : null;

        if (!wantNote && shownNotes.length === 0) {
          const footer = [];
          if (shown.length < msgHitTotal) {
            footer.push(`截断 ${fmtCount(shown.length)}/${fmtCount(msgHitTotal)}｜加 when 缩小范围（如 "2026-11-09..2026-11-12" 或 "7d"），或给更长的原话片段`);
          }
          if (note) footer.push(note);
          const lines = [`「${queryLabel}」— ${msgTotalText}`];
          if (rangeHint) lines.push(rangeHint);
          if (weakHint) lines.push('', weakHint);
          lines.push('', renderShown(shown, { includeExcluded, expand, repo, compactTime, extras, dshHome, tzOffsetMs }), '');
          lines.push(footer.join('\n'));
          return lines.join('\n');
        }

        const parts = [];
        parts.push(!wantNote && shown.length > 0 ? `「${queryLabel}」— ${msgTotalText}` : `「${queryLabel}」`);
        if (rangeHint) parts.push(rangeHint);
        if (weakHint) parts.push('', weakHint);
        if (shownNotes.length > 0) {
          const noteHeading = wantNote
            ? `你自己记的 — ${noteTotalText}`
            : `你自己记的（高权重置顶） — ${noteTotalText}`;
          parts.push('', noteHeading, '');
          parts.push(shownNotes.map(renderNote).join('\n\n'));
        }
        if (shown.length > 0) {
          parts.push('', `你们说过的话 — ${msgTotalText}`, '');
          parts.push(renderShown(shown, { includeExcluded, expand, repo, compactTime, extras, dshHome, tzOffsetMs }));
        }

        if (wantNote) {
          const trashHint = formatTrashHint(extras, sessionId);
          if (trashHint) parts.push('', trashHint);
        }

        const footerParts = [];
        if (wantMsg) footerParts.push(`原话 ${fmtCount(shown.length)}/${fmtCount(msgHitTotal)}`);
        if (wantNote || shownNotes.length > 0) {
          footerParts.push(
            noteTouchedCap
              ? `笔记 ${fmtCount(shownNotes.length)}/${NOTE_PROBE}+`
              : `笔记 ${fmtCount(shownNotes.length)}/${fmtCount(noteTotal)}`,
          );
        }
        parts.push('', footerParts.join('｜'));

        if (query && shown.length > 0 && shown.length < msgHitTotal) {
          parts.push(`截断提示：加 when 缩小范围（如 "2026-11-09..2026-11-12" 或 "7d"），或给更长的原话片段`);
        }
        if (note) parts.push(note);
        return parts.join('\n').replace(/^\n+/, '');
      } catch (error) {
        return [
          `记忆库现在读不到：${error?.message ?? String(error)}`,
          '（这不是「没聊过」，是库本身打不开或者坏了。）',
        ].join('\n');
      }
    },
  };
}

export const memorySearchTool = createSearchTool();
export default memorySearchTool;

export {
  DEFAULT_LIMIT as SEARCH_DEFAULT_LIMIT,
  NOTE_PROBE as SEARCH_NOTE_PROBE,
  QUERY_LABEL_MAX as SEARCH_QUERY_LABEL_MAX,
  DEFAULT_MIN_INDEX_COVERAGE as SEARCH_MIN_INDEX_COVERAGE,
};
