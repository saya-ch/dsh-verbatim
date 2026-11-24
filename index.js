// @ts-check
/**
 * dsh-verbatim —— DSH Host 插件入口。
 *
 * 这是插件形态的入口（`package.json` 的 `.`）；库形态在 `./src/index.js`；
 * 面板 RPC 业务层与 HTTP 适配层在 `./src/host/panel-api.js`。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, defaultDbPath } from './src/store/db.js';
import { createRepo, createExtras } from './src/store/repo.js';
import { createSessionToolSet } from './src/tools/index.js';
import { defaultSessionConfig } from './src/config/session-config.js';
import { importSession } from './src/pipeline.js';
import { dayKeyInZone } from './src/ingest/export.js';
import { loadGlobalConfig } from './src/config/global-config.js';
import { createSessionLock } from './src/host/session-lock.js';
import {
  API_PREFIX,
  PANEL_METHODS,
  PanelError,
  createPanelApi,
  createPanelHandler,
  findLatestSession,
  findSessionFile,
} from './src/host/panel-api.js';

export {
  API_PREFIX,
  PANEL_METHODS,
  PanelError,
  createPanelApi,
  createPanelHandler,
};

/** 依赖 DSH 的工具注册表与 HTTP 载体 */
export const inject = ['tools', 'webServer'];

function textOutput() {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value?.text ?? '') }];
    },
  };
}

export function apply(ctx, config = {}) {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const dbPath = config.dbPath ?? defaultDbPath(dshHome);

  const dbRoot = dbPath === ':memory:'
    ? path.join(dshHome, 'verbatim')
    : path.dirname(path.resolve(dbPath));

  let configuredVecDim;
  try {
    const gCfg = loadGlobalConfig({ dshHome }).config;
    const rawDim = Number(config?.embedding?.dim ?? gCfg?.embedding?.dim);
    if (Number.isInteger(rawDim) && rawDim > 0) configuredVecDim = rawDim;
  } catch { /* ignore */ }

  let handle;
  try {
    handle = openDb({
      dbPath,
      vecDim: configuredVecDim,
      logger: { warn: (m) => ctx.logger?.warn?.(`[verbatim] ${m}`) },
    });
  } catch (e) {
    ctx.logger?.error?.(`[verbatim] 记忆库打不开：${e.message}`);
    return () => {};
  }

  const statusFile = path.join(dbPath === ':memory:' ? dbRoot : path.dirname(dbPath), 'plugin-status.json');
  const writeStatus = (patch) => {
    try {
      const prev = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
      fs.writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2));
    } catch { /* ignore */ }
  };
  const instanceId = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  writeStatus({ loaded: true, instanceId, dbPath, hasVec: handle.hasVec === true });

  const repo = createRepo(handle);
  const extras = createExtras(handle);
  ctx.logger?.info?.(`[verbatim] 记忆库已打开：${dbPath}（${handle.hasVec ? '向量可用' : '降级为暴力余弦'}）`);

  /* ───────── 增量同步与轻量自动补索引 ───────── */

  const hostSessionLock = createSessionLock();
  const lastMtimes = new Map();
  const readerCache = new Map();
  const syncingFiles = new Map();
  let disposed = false;
  let autoIndexing = null;
  let dbMutationEpoch = 0;

  const scheduleAutoIndex = () => {
    if (disposed || autoIndexing) return;
    let globalCfg;
    try {
      globalCfg = loadGlobalConfig({ dshHome }).config;
    } catch {
      return;
    }
    if (globalCfg?.index?.autoIndex !== true) return;

    const gEmb = globalCfg.embedding ?? {};
    const pEmb = config.embedding ?? {};
    const pick = (k) => (pEmb[k] !== undefined && pEmb[k] !== null && pEmb[k] !== '' ? pEmb[k] : gEmb[k]);
    const emb = {
      mode: pick('mode') === 'local' ? 'local' : 'remote',
      model: pick('model') || 'Qwen/Qwen3-Embedding-4B',
      dim: Number(pick('dim')) || 1024,
      baseUrl: pick('baseUrl') || pick('baseURL') || 'https://api.siliconflow.cn/v1',
      apiKey: typeof pick('apiKey') === 'string' ? pick('apiKey') : '',
      apiKeyEnv: pick('apiKeyEnv') ?? config.embeddingKeyEnv ?? '',
      maxBatch: Number(pick('maxBatch')) || 32,
      fetchImpl: pEmb.fetchImpl,
    };
    const local = emb.mode === 'local';
    const hasEnvKey = Boolean(emb.apiKeyEnv && process.env[emb.apiKeyEnv]);
    if (!emb.model || (!local && !emb.apiKey.trim() && !hasEnvKey)) return;

    try {
      if (extras.vecMeta.pending({ limit: 1 }).length === 0) return;
    } catch {
      return;
    }

    const startEpoch = dbMutationEpoch;
    autoIndexing = (async () => {
      try {
        const { createSiliconFlowEmbedding } = await import('./src/model/embedding.js');
        const { createVectorStore } = await import('./src/search/vector-store.js');
        const { createIndexer } = await import('./src/search/indexer.js');
        if (disposed) return;

        const provider = createSiliconFlowEmbedding({
          model: emb.model,
          dim: emb.dim,
          maxBatch: emb.maxBatch,
          baseURL: emb.baseUrl,
          apiKey: emb.apiKey.trim() || undefined,
          apiKeyEnv: emb.apiKeyEnv,
          local,
          fetchImpl: emb.fetchImpl,
        });
        const store = createVectorStore(handle, {
          dim: provider.dim,
          logger: { warn: (m) => ctx.logger?.warn?.(`[verbatim] ${m}`) },
        });
        const indexer = createIndexer({
          handle,
          provider,
          extras,
          store,
          logger: { warn: (m) => ctx.logger?.warn?.(`[verbatim] ${m}`) },
        });
        const r = await hostSessionLock.withLock('__auto_index__', () => indexer.indexPending({ limit: 64 }));
        // 若补索引期间发生过 clearSession / rebuild 等变更，顺手清理可能残留的孤儿向量
        if (!disposed && dbMutationEpoch !== startEpoch) {
          try { store.pruneOrphans(); } catch { /* ignore */ }
        }
        if (!disposed && r.indexed > 0) {
          ctx.logger?.info?.(`[verbatim] 自动增量补索引 ${r.indexed} 条（${r.elapsedMs}ms）`);
        }
      } catch (e) {
        if (!disposed) ctx.logger?.warn?.(`[verbatim] 自动补索引跳过：${e?.message ?? e}`);
      } finally {
        autoIndexing = null;
      }
    })();
  };

  const invalidateFresh = (sessionId) => {
    if (!sessionId) {
      lastMtimes.clear();
      return;
    }
    const file = config.sessionFile ?? findSessionFile(dshHome, sessionId);
    if (file) lastMtimes.delete(file);
  };

  const ensureFresh = async (target = null, syncOpts = {}) => {
    if (disposed) return { skipped: true, inserted: 0 };
    const sessionId = typeof target === 'string'
      ? target
      : (typeof target?.sessionId === 'string' ? target.sessionId : null);

    const file = config.sessionFile
      ?? (sessionId ? findSessionFile(dshHome, sessionId) : null)
      ?? findLatestSession(dshHome);
    if (!file) return { skipped: true, inserted: 0 };

    let stat;
    try { stat = fs.statSync(file); } catch { return { skipped: true, inserted: 0 }; }
    if (stat.mtimeMs === lastMtimes.get(file)) return { skipped: true, inserted: 0 };
    if (syncingFiles.has(file)) return syncingFiles.get(file);

    const job = (async () => {
      const t0 = Date.now();
      try {
        const lockKey = sessionId || file;
        const r = await hostSessionLock.withLock(lockKey, () => importSession(file, { handle, dbRoot, readerCache }));
        lastMtimes.set(file, stat.mtimeMs);
        const inserted = Number(r?.ingest?.inserted ?? 0);
        ctx.logger?.info?.(`[verbatim] 同步 ${Date.now() - t0}ms：${r?.ingest?.inserted ?? '?'} 条`);
        if (!syncOpts.skipAutoIndex && inserted > 0) {
          scheduleAutoIndex();
          if (sessionId) scheduleAutoRefine(sessionId);
        }
        return { skipped: false, inserted };
      } catch (e) {
        ctx.logger?.warn?.(`[verbatim] 同步失败（继续用现有数据）：${e.message}`);
        return { skipped: false, inserted: 0, error: e.message };
      } finally {
        syncingFiles.delete(file);
      }
    })();
    syncingFiles.set(file, job);
    return job;
  };

  /* ───────── 后台自动 LLM 场景摘要精炼（按会话并发 + 持久化日预算） ───────── */

  const explicitToolConfig = config.session && Object.keys(config.session).length
    ? { ...defaultSessionConfig(), ...config.session }
    : undefined;

  const recallLogEntries = [];
  const pushRecallEntry = (entry) => {
    recallLogEntries.unshift(entry);
    if (recallLogEntries.length > 50) recallLogEntries.length = 50;
  };

  const refiningSessions = new Set();
  const budgetFile = dbPath !== ':memory:' ? path.join(dbRoot, 'refine-budget.json') : null;
  const readRefineBudget = (today) => {
    if (budgetFile) {
      try {
        if (fs.existsSync(budgetFile)) {
          const parsed = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
          if (parsed && parsed.day === today && Number.isFinite(Number(parsed.used))) {
            return { day: today, used: Math.max(0, Math.trunc(Number(parsed.used))) };
          }
        }
      } catch { /* ignore */ }
    }
    return { day: today, used: 0 };
  };
  let dailyRefineBudget = readRefineBudget(dayKeyInZone(Date.now()));
  const saveRefineBudget = () => {
    if (!budgetFile) return;
    try {
      fs.mkdirSync(path.dirname(budgetFile), { recursive: true });
      fs.writeFileSync(budgetFile, JSON.stringify(dailyRefineBudget, null, 2));
    } catch { /* ignore */ }
  };

  const scheduleAutoRefine = (sessionId) => {
    if (disposed || !sessionId || refiningSessions.has(sessionId)) return;
    let g;
    try { g = loadGlobalConfig({ dshHome }).config; } catch { return; }
    const llm = g.llm ?? {};
    if (llm.enabled !== true || llm.autoRefine !== true || !llm.model) return;
    const today = dayKeyInZone(Date.now());
    if (dailyRefineBudget.day !== today) {
      dailyRefineBudget = readRefineBudget(today);
    }
    const limit = Number.isFinite(Number(llm.dailyLimit)) ? Math.max(0, Math.trunc(Number(llm.dailyLimit))) : 50;
    if (limit <= 0 || dailyRefineBudget.used >= limit) return;

    let hostLlm = null;
    try { hostLlm = (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm) ?? null; } catch { return; }
    if (!hostLlm) return;

    refiningSessions.add(sessionId);
    (async () => {
      try {
        const unrefined = await hostSessionLock.withLock(sessionId, () => (
          repo.scenesByTimeRange(sessionId, 0, Number.MAX_SAFE_INTEGER, 5000)
            .filter((s) => s.gistSource !== 'llm' && s.gistSource !== 'manual')
        ));
        const remain = Math.max(0, limit - dailyRefineBudget.used);
        const batch = unrefined.slice(0, Math.min(remain, 8));
        if (batch.length === 0) return;
        const { createHostLlmAdapter } = await import('./src/host/dsh-llm.js');
        const { generateGist } = await import('./src/derive/gist.js');
        const llmAdapter = createHostLlmAdapter(hostLlm, { provider: llm.provider || '', model: llm.model });
        let cursor = 0;
        let done = 0;
        const worker = async () => {
          while (!disposed && cursor < batch.length) {
            if (dailyRefineBudget.used >= limit) break;
            const sc = batch[cursor++];
            try {
              const msgs = await hostSessionLock.withLock(sessionId, () => repo.msgsByScene(sc.id, false));
              if (msgs.length === 0) continue;
              const gr = await generateGist({ llm: llmAdapter, msgs, startAt: sc.startAt, endAt: sc.endAt });
              if (disposed || !gr.ok || !gr.gist) continue;
              await hostSessionLock.withLock(sessionId, () => {
                if (dailyRefineBudget.used >= limit) return;
                // 写入前在会话锁内复核：避免覆盖人工摘要或已重建/合并的旧场景
                const latest = repo.sceneById(sc.id);
                if (!latest || latest.sessionId !== sessionId) return;
                if (latest.gistSource === 'llm' || latest.gistSource === 'manual') return;
                repo.setSceneGist(sc.id, gr.gist, { source: 'llm' });
                dailyRefineBudget.used += 1;
                done += 1;
                saveRefineBudget();
              });
            } catch { /* ignore */ }
          }
        };
        await Promise.all([worker(), worker()]);
        if (!disposed && done > 0) {
          ctx.logger?.info?.(`[verbatim] 后台空闲自动补齐 LLM 摘要 ${done} 场（今日已用 ${dailyRefineBudget.used}/${limit}）`);
        }
      } catch (e) {
        if (!disposed) ctx.logger?.warn?.(`[verbatim] 后台自动补齐摘要跳过：${e?.message ?? e}`);
      } finally {
        refiningSessions.delete(sessionId);
      }
    })();
  };

  /* ───────── 工具定义与生命周期 ───────── */

  const toDshTool = (t, sessionId) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    output: textOutput(),
    async execute(args) {
      const t0 = Date.now();
      await ensureFresh(sessionId);
      let trace = null;
      const onResult = t.name === 'memory_search'
        ? (info) => { trace = info; }
        : undefined;
      const text = await t.handler(args ?? {}, { handle, repo, extras, onResult });
      if (t.name === 'memory_search') {
        const hits = Array.isArray(trace?.hits) ? trace.hits : [];
        const sceneMap = new Map();
        for (const h of hits) {
          if (h.sceneId !== null && h.sceneId !== undefined) {
            const sid = Number(h.sceneId);
            const prev = sceneMap.get(sid);
            if (prev) prev.count += 1;
            else sceneMap.set(sid, { sceneId: sid, startAt: h.sceneStartAt ?? h.at, endAt: h.sceneEndAt ?? h.at, count: 1 });
          }
        }
        pushRecallEntry({
          id: `rc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          at: Date.now(),
          sessionId,
          query: String(args?.query ?? '').trim(),
          when: args?.when ? String(args.when) : null,
          scope: String(args?.scope ?? 'msg'),
          elapsedMs: Date.now() - t0,
          resultChars: String(text ?? '').length,
          hitCount: hits.length,
          counts: trace?.meta?.counts ?? { keyword: (trace?.keywordRows ?? []).length, vector: 0 },
          usedRoutes: trace?.meta?.usedRoutes ?? ((trace?.keywordRows ?? []).length > 0 ? ['keyword'] : []),
          reranked: trace?.meta?.reranked === true,
          rerankModel: trace?.meta?.rerankModel ?? null,
          hitScenes: [...sceneMap.values()].slice(0, 6),
        });
      }
      return { text: String(text) };
    },
  });

  const cleanups = new Map();
  const liveAgents = new Map();

  function registerFor(agent) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string') return;
    liveAgents.set(sessionId, agent);
    if (cleanups.has(sessionId)) return;

    const sessionCtx = agent.ctx;
    if (!sessionCtx?.tools?.register) return;

    let set;
    try {
      set = createSessionToolSet({
        handle,
        repo,
        extras,
        sessionId,
        dshHome,
        config: explicitToolConfig,
        logger: { warn: (m) => ctx.logger?.warn?.(m) },
      });
    } catch (e) {
      ctx.logger?.warn?.(`[verbatim] 会话 ${sessionId} 建工具集失败：${e.message}`);
      return;
    }

    const dshTools = set.tools.map((t) => toDshTool(t, sessionId));
    const undos = [];
    try {
      for (const def of dshTools) {
        undos.push(sessionCtx.tools.register(def));
      }
      undos.push(() => set.close());
      cleanups.set(sessionId, undos);
      writeStatus({ registeredFor: [...cleanups.keys()], toolCount: dshTools.length });
      ctx.logger?.info?.(
        `[verbatim] 已为会话 ${sessionId} 注册 ${dshTools.length} 个记忆工具`
        + (dshTools.length === 0 ? '（配置里两个开关都关着，不注册是对的）' : ''),
      );
    } catch (e) {
      for (const undo of undos) {
        try { undo?.(); } catch { /* ignore */ }
      }
      try { set.close(); } catch { /* ignore */ }
      ctx.logger?.warn?.(`[verbatim] 注册工具失败：${e.message}`);
    }
  }

  function unregisterFor(sessionId) {
    const undos = cleanups.get(sessionId);
    if (!undos) return;
    for (const undo of undos) {
      try { undo?.(); } catch { /* ignore */ }
    }
    cleanups.delete(sessionId);
  }

  function refreshToolsFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    unregisterFor(sessionId);
    let agent = liveAgents.get(sessionId);
    if (!agent) {
      try {
        const agents = ctx.get('agents');
        if (typeof agents?.get === 'function') agent = agents.get(sessionId);
      } catch { /* ignore */ }
    }
    if (agent) {
      registerFor(agent);
      return true;
    }
    return false;
  }

  try {
    const agents = ctx.get('agents');
    const proto = agents ? Object.getPrototypeOf(agents) : null;
    const keys = !agents ? '(服务不存在)' : proto ? Object.getOwnPropertyNames(proto).join(',') : '(无原型)';
    ctx.logger?.info?.(`[verbatim] agents 服务原型方法: ${keys}`);
    const list = typeof agents?.list === 'function' ? agents.list()
      : typeof agents?.all === 'function' ? agents.all()
      : typeof agents?.values === 'function' ? [...agents.values()]
      : [];
    ctx.logger?.info?.(`[verbatim] 现有 Agent 数量: ${Array.isArray(list) ? list.length : '(不是数组)'}`);
    for (const agent of list) registerFor(agent);

    try {
      const listIds = (Array.isArray(list) ? list : []).map((a) => a?.session?.id).filter(Boolean);
      const dirRoot = path.join(dshHome, 'sessions');
      const diskIds = [];
      if (fs.existsSync(dirRoot)) {
        for (const ws of fs.readdirSync(dirRoot, { withFileTypes: true })) {
          if (!ws.isDirectory()) continue;
          const wsd = path.join(dirRoot, ws.name);
          let subs = [];
          try { subs = fs.readdirSync(wsd, { withFileTypes: true }); } catch { continue; }
          for (const s of subs) {
            if (s.isDirectory() && fs.existsSync(path.join(wsd, s.name, 'session.v4.jsonl.zstd'))) {
              diskIds.push(s.name);
            }
          }
        }
      }
      const gettable = diskIds.filter((id) => {
        if (listIds.includes(id)) return true;
        try { return agents?.get?.(id) !== undefined; } catch { return false; }
      });
      writeStatus({
        diag: {
          agentsListCount: listIds.length,
          agentsListIds: listIds.slice(0, 8),
          diskSessionCount: diskIds.length,
          gettableCount: gettable.length,
          gettableSample: gettable.slice(0, 8),
          hasGet: typeof agents?.get === 'function',
        },
      });
      ctx.logger?.info?.(
        `[verbatim] agents.list=${listIds.length} / 磁盘会话=${diskIds.length} / 能拿到 Agent 的=${gettable.length}`,
      );
    } catch (e) { ctx.logger?.warn?.(`[verbatim] 诊断失败：${e.message}`); }

    const latestLog = config.sessionFile ?? findLatestSession(dshHome);
    if (latestLog) {
      const sid = path.basename(path.dirname(latestLog));
      if (!cleanups.has(sid)) {
        const agent = typeof agents?.get === 'function' ? agents.get(sid) : undefined;
        if (agent) {
          registerFor(agent);
          ctx.logger?.info?.(`[verbatim] 已补注册当前会话 ${sid}`);
        } else {
          writeStatus({ missedSession: sid, note: 'agents.get 拿不到这个会话的 Agent，等 agent/created' });
          ctx.logger?.warn?.(`[verbatim] agents.get(${sid}) 拿不到 Agent —— 当前会话暂时没有工具，等下一次 agent/created`);
        }
      }
    }
  } catch (e) { ctx.logger?.warn?.(`[verbatim] 遍历 Agent 失败：${e.message}`); }

  const unsubCreated = ctx.on('agent/created', ({ agent }) => registerFor(agent));
  const unsubDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id;
    if (typeof sessionId === 'string') {
      unregisterFor(sessionId);
      liveAgents.delete(sessionId);
    }
  });

  const panelApi = createPanelApi({
    handle,
    repo,
    extras,
    dbPath,
    dshHome,
    config,
    sessionLock: hostSessionLock,
    recallLog: recallLogEntries,
    logger: ctx.logger,
    getHostLlm: () => {
      try {
        return (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm) ?? null;
      } catch {
        return null;
      }
    },
    syncSession: async (sid) => {
      invalidateFresh(sid);
      return await ensureFresh(sid, { skipAutoIndex: true });
    },
  });

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: createPanelHandler(panelApi, {
        beforeRequest: ensureFresh,
        afterCall: ({ method, params }) => {
          if (method === 'dbMaintain' && params?.action === 'clearSession') {
            dbMutationEpoch += 1;
            invalidateFresh(params.sessionId);
          }
          if (method === 'rebuild') {
            dbMutationEpoch += 1;
          }
          if (method === 'set' && params?.key === 'record' && params?.value === true) {
            invalidateFresh(params.sessionId);
          }
          if (method === 'set' && (params?.key === 'tools' || params?.key === 'record') && typeof params?.sessionId === 'string') {
            refreshToolsFor(params.sessionId);
          }
          if (method === 'batchSetSessionFlags' && (params?.key === 'tools' || params?.key === 'record' || params?.tools !== undefined || params?.record !== undefined)) {
            for (const sid of [...liveAgents.keys()]) refreshToolsFor(sid);
          }
        },
      }),
    }),
    'dsh-verbatim: panel api',
  );

  ctx.logger?.info?.(
    `[verbatim] 面板 RPC 已挂载：${API_PREFIX}/panel.{${PANEL_METHODS.join(',')}}`,
  );

  return () => {
    disposed = true;
    try { if (typeof unsubCreated === 'function') unsubCreated(); } catch { /* ignore */ }
    try { if (typeof unsubDisposed === 'function') unsubDisposed(); } catch { /* ignore */ }
    for (const sessionId of [...cleanups.keys()]) unregisterFor(sessionId);
    try { handle.close(); } catch { /* ignore */ }
  };
}

export default { inject, apply };
