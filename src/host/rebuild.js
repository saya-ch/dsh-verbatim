// @ts-check
/**
 * 后台重建任务与安全闸门（incremental / vector / scene / gist / derive）。
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWindowsForSession, rebuildDerived, rebuildScenesForSession } from '../pipeline.js';
import { generateGist } from '../derive/gist.js';
import { createHostLlmAdapter } from './dsh-llm.js';
import { recreateVecTables } from '../store/db.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIME_MAX = Number.MAX_SAFE_INTEGER;
const ALL_ROWS = 5_000_000;
const TASK_KEEP = 20;

export function createRebuildManager({
  handle,
  repo,
  extras,
  dbPath,
  embCfg,
  llmCfg,
  hasEmbeddingKey,
  hasLlmReady,
  getHostLlm,
  noteHasSessionColumn,
  syncSession,
  logger,
  PanelError,
}) {
  const tasks = new Map();

  function recentTasks() {
    const out = [];
    for (const t of tasks.values()) {
      out.push({
        taskId: t.id,
        scope: t.scope,
        sessionId: t.sessionId,
        state: t.state,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        progress: t.progress ?? null,
        error: t.error ?? null,
      });
    }
    return out.slice(-10).reverse();
  }

  function trimTasks() {
    if (tasks.size <= TASK_KEEP) return;
    const finished = [...tasks.values()]
      .filter((t) => t.state !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const t of finished.slice(0, Math.max(0, tasks.size - TASK_KEEP))) tasks.delete(t.id);
  }

  function assertSafeToReset(targetDbPath) {
    const resolved = path.resolve(targetDbPath);
    const allowedRoots = [path.resolve(os.tmpdir()), path.resolve(ROOT_DIR, '.tmp')];
    const allowed = allowedRoots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!allowed) {
      throw new PanelError(
        'UNSAFE_RESET',
        `拒绝清空 ${resolved}\n`
        + '面板重建只重建派生数据（场景 / 向量），永远不会删记忆库原文。\n'
        + '任何「清库」操作只允许在系统临时目录或项目 .tmp/ 下的库上执行。\n'
        + '这看起来是真实的记忆库 —— 它的原文是唯一的事实来源，不能被重建删掉。',
        403,
      );
    }
    return resolved;
  }

  async function makeEmbeddingProvider() {
    const emb = embCfg();
    const local = emb.mode === 'local';
    const key = emb.apiKey.trim();
    const envName = emb.apiKeyEnv;
    const hasEnvKey = Boolean(envName && process.env[envName]);

    if (!local && !key && !hasEnvKey) {
      throw new PanelError(
        'NO_EMBEDDING',
        '没有配 embedding 的 API Key。去「设置 → 逐字记忆」填一个，'
        + '或者把服务类型改成「本地」（Ollama / LM Studio 之类不需要 key）。'
        + '时间轴与关键词检索不受影响 —— 这不是失败，是「语义搜索未启用」。',
        503,
      );
    }
    const { createSiliconFlowEmbedding } = await import('../model/embedding.js');
    return createSiliconFlowEmbedding({
      model: emb.model,
      dim: emb.dim,
      maxBatch: emb.maxBatch,
      baseURL: emb.baseUrl,
      apiKey: key || undefined,
      apiKeyEnv: envName,
      local,
      fetchImpl: emb.fetchImpl,
    });
  }

  async function makeLlmProvider() {
    const c = llmCfg();
    const hostLlm = getHostLlm?.();
    if (!c.enabled) {
      throw new PanelError('LLM_DISABLED', '对话模型未启用（当前使用零成本抽取式摘要）', 503);
    }
    if (!hostLlm) {
      throw new PanelError('NO_LLM', '当前未连接到 DSH 模型服务（ctx.llm），无法执行摘要精炼。', 503);
    }
    if (!c.model) {
      throw new PanelError('NO_LLM', '请先在「设置 → 逐字记忆 → 摘要模型」中选择一个 DSH 模型。', 503);
    }
    return createHostLlmAdapter(hostLlm, { provider: c.provider, model: c.model });
  }

  function updateTaskProgress(task, info = {}) {
    const prev = task.progress ?? {};
    const done = Number.isFinite(info.done) ? Math.max(0, Math.trunc(info.done)) : (prev.done ?? 0);
    const hasTotal = info.total !== undefined;
    const total = hasTotal
      ? (Number.isFinite(info.total) && info.total >= 0 ? Math.trunc(info.total) : null)
      : (prev.total ?? null);
    const pct = total !== null && total > 0
      ? Math.min(100, Math.round((done / total) * 100))
      : (total === 0 ? 100 : null);
    const phase = String(info.phase ?? prev.phase ?? 'running');
    const defaultLabel = phase === 'sync' ? '正在同步会话消息入库…'
      : phase === 'prepare' ? '准备索引数据…'
        : phase === 'gist' ? '正在用 LLM 精炼场景摘要…'
          : phase === 'chunk' ? '正在切片嵌入长消息…'
            : phase === 'window' ? '正在建立对话窗向量…'
              : phase === 'scene' ? '正在建立场景向量…'
              : phase === 'msg' ? '正在生成向量索引…'
                : '处理中…';
    task.progress = {
      phase,
      label: typeof info.label === 'string' && info.label ? info.label : defaultLabel,
      done,
      total,
      pct,
      chunks: Number.isFinite(info.chunks) ? Math.trunc(info.chunks) : (prev.chunks ?? 0),
      updatedAt: Date.now(),
    };
  }

  async function indexSessionScenes(task, sessionId, provider, opts = {}) {
    const { createVectorStore } = await import('../search/vector-store.js');
    const { createIndexer } = await import('../search/indexer.js');
    const store = opts.store ?? createVectorStore(handle, {
      dim: provider.dim,
      logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
    });
    const indexer = createIndexer({
      handle,
      provider,
      extras,
      store,
      logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
      onProgress: (info) => updateTaskProgress(task, info),
    });
    const skipSet = opts.skipSceneIds ? new Set(opts.skipSceneIds.map(Number)) : null;
    const scList = repo
      .scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_ROWS)
      .filter((s) => !skipSet || !skipSet.has(Number(s.id)))
      .map((s) => ({ id: s.id, gist: s.gist }));
    if (scList.length === 0) return 0;
    const sr = await indexer.indexScenes(scList);
    return sr.indexed ?? 0;
  }

  async function refineSessionGists(task, sessionId, opts = {}) {
    const onlySet = opts.onlySceneIds ? new Set(opts.onlySceneIds.map(Number)) : null;
    const onlyUnrefined = opts.onlyUnrefined === true;
    const allRows = repo.scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_ROWS);
    let scRows = onlySet ? allRows.filter((s) => onlySet.has(Number(s.id))) : allRows;
    const beforeUnrefined = scRows.length;
    // 人工手写摘要（manual）永远保护不被批量 LLM 覆盖；onlyUnrefined 同时跳过已 LLM 精炼的场景
    scRows = scRows.filter((s) => s.gistSource !== 'manual' && (!onlyUnrefined || s.gistSource !== 'llm'));
    const skippedRefined = beforeUnrefined - scRows.length;
    if (scRows.length === 0) {
      return {
        totalScenes: allRows.length,
        targetedScenes: 0,
        skippedRefined,
        llmGists: 0,
        llmGistErrors: 0,
        updatedSceneIds: [],
      };
    }
    const llm = await makeLlmProvider();
    const totalScenes = scRows.length;
    const concurrency = Math.max(1, Math.min(8, Math.trunc(Number(opts.concurrency)) || 4));
    let llmGists = 0;
    let llmGistErrors = 0;
    let completed = 0;
    let cursor = 0;
    const updatedSceneIds = [];
    const label = onlyUnrefined ? '正在补齐未精炼场景摘要…' : '正在用 LLM 精炼场景摘要…';
    updateTaskProgress(task, { phase: 'gist', label, done: 0, total: totalScenes });

    async function worker() {
      while (cursor < scRows.length) {
        const sc = scRows[cursor++];
        try {
          const msgs = repo.msgsByScene(sc.id, false);
          if (msgs.length > 0) {
            const gr = await generateGist({ llm, msgs, startAt: sc.startAt, endAt: sc.endAt });
            if (gr.ok && gr.gist) {
              repo.setSceneGist(sc.id, gr.gist, { source: 'llm' });
              updatedSceneIds.push(Number(sc.id));
              llmGists++;
            } else {
              llmGistErrors++;
            }
          }
        } catch (e) {
          llmGistErrors++;
          logger.warn?.(`[verbatim] 场景 #${sc.id} LLM 摘要精炼失败（保留原有摘要）：${e?.message ?? e}`);
        }
        completed++;
        updateTaskProgress(task, { phase: 'gist', label, done: completed, total: totalScenes });
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, scRows.length) }, () => worker()));
    return {
      totalScenes: allRows.length,
      targetedScenes: totalScenes,
      skippedRefined,
      llmGists,
      llmGistErrors,
      updatedSceneIds,
    };
  }

  async function runRebuildTask(task) {
    const { sessionId, scope } = task;

    let synced = 0;
    if (syncSession) {
      updateTaskProgress(task, { phase: 'sync', label: '正在同步最新对话入库…', done: 0, total: null });
      try {
        const syncRes = await syncSession(sessionId);
        synced = Number(syncRes?.inserted ?? 0);
      } catch (e) {
        logger.warn?.(`[verbatim] 任务前同步失败（继续用库内数据）：${e?.message ?? e}`);
      }
    }

    if (scope === 'incremental') {
      if (!hasEmbeddingKey()) {
        return {
          scope,
          sessionId,
          synced,
          msgs: 0,
          indexed: 0,
          chunks: 0,
          totalPending: 0,
          skipped: '未配置 embedding，已完成消息入库，跳过向量索引',
        };
      }
      const provider = await makeEmbeddingProvider();
      const { createVectorStore } = await import('../search/vector-store.js');
      const { createIndexer } = await import('../search/indexer.js');
      const store = createVectorStore(handle, {
        dim: provider.dim,
        logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
      });
      const indexer = createIndexer({
        handle,
        provider,
        extras,
        store,
        logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
        onProgress: (info) => updateTaskProgress(task, info),
      });
      const r = await indexer.indexPending({ sessionId });
      let windowVectors = 0;
      try {
        ensureWindowsForSession({ repo, extras, sessionId });
        const wr = await indexer.indexPendingWindows({ sessionId });
        windowVectors = wr.indexed ?? 0;
      } catch { /* 对话窗向量补建失败不影响主索引 */ }
      let noteVectors = 0;
      try {
        const activeNotes = noteHasSessionColumn()
          ? extras.note.list({ sessionId, limit: ALL_ROWS })
          : extras.note.list({ limit: ALL_ROWS });
        if (activeNotes.length > 0 && typeof store.missingNoteIds === 'function') {
          const miss = new Set(store.missingNoteIds(activeNotes.map((n) => n.id)));
          const todoNotes = activeNotes.filter((n) => miss.has(Number(n.id)));
          if (todoNotes.length > 0) {
            const nr = await indexer.indexNotes(todoNotes);
            noteVectors = nr.indexed ?? 0;
          }
        }
      } catch { /* note 向量补建失败不影响主索引 */ }
      return {
        scope,
        sessionId,
        synced,
        msgs: r.indexed,
        indexed: r.indexed,
        chunks: r.chunks,
        windowVectors,
        noteVectors,
        totalPending: r.totalPending,
        batches: r.batches,
        hasMore: r.hasMore,
        elapsedMs: r.elapsedMs,
      };
    }

    if (scope === 'scene') {
      let embProvider = null;
      let sceneStore = null;
      if (hasEmbeddingKey()) {
        try {
          embProvider = await makeEmbeddingProvider();
          const { createVectorStore } = await import('../search/vector-store.js');
          sceneStore = createVectorStore(handle, {
            dim: embProvider.dim,
            logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
          });
        } catch {
          embProvider = null;
          sceneStore = null;
        }
      }
      const r = rebuildScenesForSession({
        repo,
        extras,
        sessionId,
        db: handle.db,
        vectorStore: sceneStore,
      });
      let llmGists = 0;
      let llmGistErrors = 0;
      if (task.useLlm !== false && hasLlmReady() && (r.changedSceneIds?.length ?? 0) > 0) {
        try {
          const g = await refineSessionGists(task, sessionId, { onlySceneIds: r.changedSceneIds });
          llmGists = g.llmGists;
          llmGistErrors = g.llmGistErrors;
        } catch (e) {
          logger.warn?.(`[verbatim] LLM 场景摘要精炼跳过（保留抽取式摘要）：${e?.message ?? e}`);
        }
      }
      let sceneVectors = 0;
      let windowVectors = 0;
      if (embProvider && r.scenes > 0) {
        try {
          sceneVectors = await indexSessionScenes(task, sessionId, embProvider, {
            store: sceneStore,
            skipSceneIds: r.reusedVectorSceneIds,
          });
        } catch (e) {
          logger.warn?.(`[verbatim] 场景重建后写入 vec_scene 跳过：${e?.message ?? e}`);
        }
        try {
          const { createIndexer } = await import('../search/indexer.js');
          const winIndexer = createIndexer({
            handle,
            provider: embProvider,
            extras,
            store: sceneStore,
            logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
            onProgress: (info) => updateTaskProgress(task, info),
          });
          const wr = await winIndexer.indexPendingWindows({ sessionId });
          windowVectors = wr.indexed ?? 0;
        } catch (e) {
          logger.warn?.(`[verbatim] 场景重建后写入 vec_window 跳过：${e?.message ?? e}`);
        }
      }
      return {
        scope,
        sessionId,
        synced,
        scenes: r.scenes,
        reusedScenes: r.reusedSceneIds?.length ?? 0,
        reusedVectors: r.reusedVectors ?? 0,
        llmGists,
        llmGistErrors,
        sceneVectors,
        windowVectors,
        msgsAssigned: r.msgsAssigned,
        scenesWithOutOfSurface: r.scenesWithOutOfSurface,
      };
    }

    if (scope === 'gist') {
      const onlyUnrefined = task.onlyUnrefined === true;
      const { totalScenes, targetedScenes, skippedRefined, llmGists, llmGistErrors, updatedSceneIds } =
        await refineSessionGists(task, sessionId, {
          onlyUnrefined,
          concurrency: task.concurrency,
        });
      let sceneVectors = 0;
      const needEmbed = onlyUnrefined ? updatedSceneIds.length > 0 : totalScenes > 0;
      if (hasEmbeddingKey() && needEmbed) {
        try {
          const provider = await makeEmbeddingProvider();
          const allIds = onlyUnrefined
            ? repo.scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_ROWS).map((s) => Number(s.id))
            : [];
          const updatedSet = new Set(updatedSceneIds);
          const skipSceneIds = onlyUnrefined ? allIds.filter((id) => !updatedSet.has(id)) : undefined;
          sceneVectors = await indexSessionScenes(task, sessionId, provider, { skipSceneIds });
        } catch (e) {
          logger.warn?.(`[verbatim] 精炼摘要后写入 vec_scene 跳过：${e?.message ?? e}`);
        }
      }
      return {
        scope,
        sessionId,
        synced,
        scenes: totalScenes,
        targetedScenes,
        skippedRefined,
        llmGists,
        llmGistErrors,
        sceneVectors,
      };
    }

    if (scope === 'vector') {
      const provider = await makeEmbeddingProvider();
      if (recreateVecTables(handle.db, provider.dim, { hasVec: handle.hasVec })) {
        logger.info?.(`[verbatim] 检测到向量维度变更，已按 ${provider.dim} 维重建 vec0 虚表`);
      }
      const { createVectorStore } = await import('../search/vector-store.js');
      const { createIndexer } = await import('../search/indexer.js');
      const store = createVectorStore(handle, {
        dim: provider.dim,
        logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
      });
      const indexer = createIndexer({
        handle,
        provider,
        extras,
        store,
        logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
        onProgress: (info) => updateTaskProgress(task, info),
      });
      const scenes = repo
        .scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_ROWS)
        .map((s) => ({ id: s.id, gist: s.gist }));
      const notes = noteHasSessionColumn()
        ? extras.note.list({ sessionId, limit: ALL_ROWS })
        : extras.note.list({ limit: ALL_ROWS });
      try {
        ensureWindowsForSession({ repo, extras, sessionId, force: true });
      } catch { /* ignore */ }
      const r = await /** @type {any} */ (indexer).rebuild({ force: true, scenes, notes });
      return { scope, sessionId, synced, ...r };
    }

    let embedding = null;
    let embeddingSkip = null;
    if (hasEmbeddingKey()) {
      try {
        embedding = await makeEmbeddingProvider();
        if (recreateVecTables(handle.db, embedding.dim, { hasVec: handle.hasVec })) {
          logger.info?.(`[verbatim] 全库重建检测到向量维度变更，已按 ${embedding.dim} 维重建 vec0 虚表`);
        }
      } catch (error) {
        embeddingSkip = error?.message ?? String(error);
      }
    } else {
      embeddingSkip = '没有配 embedding 的 API Key，跳过向量索引';
    }
    let llm = null;
    let llmSkip = null;
    if (hasLlmReady()) {
      try {
        llm = await makeLlmProvider();
      } catch (error) {
        llmSkip = error?.message ?? String(error);
      }
    } else {
      llmSkip = '对话模型未启用或未配置，保留零成本抽取式摘要';
    }
    const r = await /** @type {any} */ (rebuildDerived)({
      handle,
      sessionId,
      llm,
      embedding,
      vectors: Boolean(embedding),
      quiet: true,
      onProgress: (info) => updateTaskProgress(task, info),
    });
    return {
      scope,
      sessionId,
      synced,
      scenes: r.scenes,
      gist: r.gist,
      beats: r.beats,
      llmSkip,
      vectors: r.vectors,
      warnings: [...(r.warnings ?? []), ...(embeddingSkip ? [embeddingSkip] : [])],
      totalMs: r.totalMs,
    };
  }

  function startRebuildTask({ sessionId, scope, useLlm, onlyUnrefined, concurrency }) {
    const taskId = `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id: taskId,
      scope,
      useLlm,
      onlyUnrefined: onlyUnrefined === true,
      concurrency: Number.isFinite(Number(concurrency)) ? Number(concurrency) : undefined,
      sessionId,
      dbPath,
      state: 'running',
      progress: {
        phase: scope === 'incremental' ? 'sync' : 'prepare',
        label: scope === 'incremental' ? '正在同步最新对话入库…' : '准备重建…',
        done: 0,
        total: null,
        pct: null,
        chunks: 0,
        updatedAt: Date.now(),
      },
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
    };
    tasks.set(taskId, task);

    setTimeout(() => {
      runRebuildTask(task)
        .then((result) => {
          task.result = result;
          task.state = 'done';
          if (task.progress) {
            const finalDone = Number.isFinite(result?.msgs) ? result.msgs : task.progress.done;
            const finalTotal = Number.isFinite(result?.totalPending) ? result.totalPending : task.progress.total;
            task.progress = {
              ...task.progress,
              phase: 'done',
              done: finalDone,
              total: finalTotal,
              pct: 100,
              updatedAt: Date.now(),
            };
          }
          logger.info?.(`[verbatim] 重建完成（${scope}，${sessionId}）：${JSON.stringify(result).slice(0, 200)}`);
        })
        .catch((error) => {
          task.state = 'failed';
          task.error = error?.message ?? String(error);
          logger.warn?.(`[verbatim] 重建失败（${scope}，${sessionId}）：${task.error}`);
        })
        .finally(() => {
          task.finishedAt = Date.now();
          trimTasks();
        });
    }, 0);

    return task;
  }

  function getTask(taskId) {
    return tasks.get(taskId) ?? null;
  }

  function findRunningTask(sessionId, scope) {
    for (const t of tasks.values()) {
      if (
        t.state === 'running'
        && t.sessionId === sessionId
        && (t.scope === scope || (scope === 'incremental' && t.scope === 'vector'))
      ) {
        return t;
      }
    }
    return null;
  }

  return {
    recentTasks,
    assertSafeToReset,
    makeEmbeddingProvider,
    findRunningTask,
    startRebuildTask,
    getTask,
  };
}
