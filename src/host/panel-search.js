// @ts-check
/**
 * panel-search.js —— 面板 `panel.search` RPC 实现
 *
 * 与 Agent 工具共用同一套检索内核（`createSearchTool`），同时补齐场景摘要与置顶笔记。
 */

import { resolveTimeWindow } from '../tools/time-route.js';
import { createReranker } from '../model/rerank.js';
import { NOTE_MIN_SCORE_DEFAULT, PINNED_NOTE_MAX_DEFAULT, searchRankedNotes } from '../search/note-rank.js';
import { PanelError } from './panel-http.js';
import { intParam } from './panel-session-store.js';

export function createPanelSearch({
  handle,
  repo,
  extras,
  db,
  dshHome,
  logger,
  requireSession,
  vectorStatus,
  hasEmbeddingKey,
  makeEmbeddingProvider,
  rerankCfg,
  noteHasSessionColumn,
}) {
  return async function search(params) {
    const sessionId = requireSession('search', params);
    const query = String(params.query ?? '').trim();
    if (!query) throw new PanelError('BAD_ARG', '缺少搜索关键词 query', 400);
    const limit = intParam(params.limit, 'limit', { def: 20, min: 1, max: 50 });
    const includeExcluded =
      params.includeExcluded === 'false' || params.includeExcluded === '0'
        ? false
        : Boolean(params.includeExcluded);

    const whenRaw = params.when === undefined || params.when === null ? '' : String(params.when).trim();
    let from;
    let to;
    if (whenRaw) {
      const win = resolveTimeWindow({ when: whenRaw });
      if (win.kind === 'unknown') {
        throw new PanelError(
          'BAD_WHEN',
          `看不懂的时间范围：${JSON.stringify(whenRaw)}（支持如 2026-11-09、11-09、2026-11、2026-11-09..2026-11-12 或 7d）`,
          400,
        );
      }
      if (Number.isFinite(win.from)) from = Number(win.from);
      if (Number.isFinite(win.to)) to = Number(win.to);
    }

    const kwOpts = { sessionId, includeExcluded };
    if (from !== undefined) kwOpts.from = from;
    if (to !== undefined) kwOpts.to = to;
    const kwTotal = extras.search.countKeyword(query, kwOpts);

    // 场景摘要（scene.gist）同样参与检索：关键词匹配 + 语义路 vec_scene 匹配
    const sceneMatchMap = new Map();
    try {
      const likePat = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      const conds = ['session_id = ?', "gist IS NOT NULL AND gist LIKE ? ESCAPE '\\'"];
      const binds = [sessionId, likePat];
      if (!includeExcluded) conds.push('NOT (has_excluded = 1 AND excluded_count >= msg_count)');
      if (from !== undefined) { conds.push('end_at >= ?'); binds.push(from); }
      if (to !== undefined) { conds.push('start_at < ?'); binds.push(to); }
      const scKw = db.prepare(
        `SELECT id, start_at, end_at, msg_count, gist
         FROM scene
         WHERE ${conds.join(' AND ')}
         ORDER BY end_at DESC
         LIMIT 4`,
      ).all(...binds);
      for (const s of scKw) {
        sceneMatchMap.set(Number(s.id), {
          id: Number(s.id),
          startAt: Number(s.start_at),
          endAt: Number(s.end_at),
          msgCount: Number(s.msg_count ?? 0),
          gist: String(s.gist ?? ''),
          sources: ['keyword'],
          score: null,
        });
      }
    } catch { /* best-effort */ }

    const totalMsgs = extras.stats.get({ sessionId }).msgs;
    const vecStat = vectorStatus(sessionId, totalMsgs);
    let shown = [];
    let total = kwTotal;
    let used = false;
    let semanticNote = null;
    let semProvider = null;
    let semStore = null;
    let reranked = false;
    let rerankModel = null;
    let rerankError = null;

    const canSemantic = hasEmbeddingKey() && (vecStat.state === 'ok' || vecStat.state === 'degraded');
    if (!canSemantic) {
      semanticNote = vecStat.reason;
    } else {
      if (vecStat.state === 'degraded') semanticNote = vecStat.reason;
      try {
        semProvider = await makeEmbeddingProvider();
      } catch (err) {
        semanticNote = `语义搜索失败，已降级为仅关键词：${err?.message ?? err}`;
      }
    }

    let rerankerObj = null;
    const rr = rerankCfg();
    const rrApiKey = rr.apiKey || (rr.apiKeyEnv ? process.env[rr.apiKeyEnv] : '') || '';
    if (rr.enabled && rr.model && rr.baseUrl && (rr.mode === 'local' || rrApiKey)) {
      rerankerObj = createReranker({
        model: rr.model,
        baseURL: rr.baseUrl,
        apiKey: rrApiKey,
        local: rr.mode === 'local',
      });
    }

    // 与 Agent 工具共用同一套 v15 检索内核（避免双套代码漂移）
    let trace = null;
    const { createSearchTool } = await import('../tools/memory-search.js');
    const searchTool = createSearchTool({
      handle,
      repo,
      extras,
      dshHome,
      sessionId,
      ...(semProvider ? { provider: semProvider, semantic: true } : { semantic: false }),
      ...(rerankerObj ? { reranker: rerankerObj, rerankTopN: rr.topN || 50 } : { rerank: false }),
      logger: { warn: (m) => logger.warn?.(m) },
      onResult: (tr) => { trace = tr; },
    });
    await searchTool.handler({
      query,
      ...(whenRaw ? { when: whenRaw } : {}),
      limit,
      includeExcluded,
      scope: 'msg',
    }, { allowExcluded: true });

    shown = Array.isArray(trace?.shownHits) ? trace.shownHits : [];
    total = Math.max(kwTotal, Array.isArray(trace?.hits) ? trace.hits.length : shown.length);
    if (trace?.meta) {
      used = canSemantic && Boolean(semProvider) && !trace.meta.vectorSkipped && !trace.meta.vectorError;
      if (trace.meta.vectorError) {
        used = false;
        semanticNote = `语义搜索失败，已降级为仅关键词：${trace.meta.vectorError}`;
      }
      reranked = Boolean(trace.meta.reranked);
      rerankModel = trace.meta.rerankModel ?? null;
      rerankError = trace.meta.rerankError ?? null;
    }

    const matchedScenes = [...sceneMatchMap.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.endAt - a.endAt))
      .slice(0, 4);

    // 笔记高权重置顶召回（关键词 + vec_note 语义融合 + 分数门槛 >= 0.58）
    let matchedNotes = [];
    try {
      const noteCount = noteHasSessionColumn()
        ? extras.note.count({ sessionId })
        : extras.note.count({});
      if (noteCount > 0) {
        if (!semStore && hasEmbeddingKey()) {
          try {
            if (!semProvider) semProvider = await makeEmbeddingProvider();
            const { createVectorStore } = await import('../search/vector-store.js');
            semStore = createVectorStore(handle, {
              dim: semProvider.dim,
              logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
            });
          } catch { /* 装配失败则只走笔记关键词路 */ }
        }
        const nr = await searchRankedNotes({
          extras,
          sessionId: noteHasSessionColumn() ? sessionId : null,
          query,
          from: from ?? null,
          to: to ?? null,
          provider: semProvider,
          store: semStore,
          minScore: NOTE_MIN_SCORE_DEFAULT,
          limit: PINNED_NOTE_MAX_DEFAULT,
        });
        matchedNotes = nr.hits.map((/** @type {any} */ n) => ({
          id: Number(n.id),
          content: String(n.content ?? ''),
          about: n.about ?? null,
          at: Number(n.at),
          score: typeof n.score === 'number' ? n.score : null,
          sources: Array.isArray(n.sources) ? n.sources : ['keyword'],
        }));
      }
    } catch { /* 笔记检索失败不影响主流程 */ }

    return {
      query,
      total,
      matchedNotes,
      matchedScenes,
      hits: shown.map((r) => ({
        id: Number(r.id),
        seq: r.seq,
        at: r.at,
        speaker: r.speaker,
        text: r.text,
        inSurface: r.inSurface ?? 1,
        excluded: r.excluded ?? 0,
        sceneId: r.sceneId ?? null,
        sceneStartAt: r.sceneStartAt ?? null,
        sceneEndAt: r.sceneEndAt ?? null,
        sceneMsgCount: r.sceneMsgCount ?? null,
        sources: Array.isArray(r.sources) ? r.sources : ['keyword'],
        score: typeof r.score === 'number' ? r.score : null,
        chunk: r.chunk ?? null,
        window: r.window ?? null,
        ...(r.focusExchange ? { focusExchange: r.focusExchange } : {}),
        ...(Array.isArray(r.relatedTimeline) && r.relatedTimeline.length > 0
          ? {
              relatedTimeline: r.relatedTimeline.map((rt) => ({
                at: rt.at ?? rt.sceneStartAt ?? null,
                sceneId: rt.sceneId ?? null,
              })),
            }
          : {}),
      })),
      semantic: { used, state: vecStat.state, note: semanticNote, reranked, rerankModel, rerankError },
    };
  };
}
