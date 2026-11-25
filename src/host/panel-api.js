/**
 * panel-api.js —— 面板 RPC 业务层与 HTTP 适配层
 *
 * 从 index.js 拆出，使 Host 插件入口与面板 RPC 契约职责分离。
 */

import os from 'node:os';
import path from 'node:path';

import { createExtras, createRepo } from '../store/repo.js';
import {
  assertSessionId,
  defaultSessionConfig,
  normalizeRanges,
  setSessionExcludeRanges,
  setSessionFlag,
} from '../config/session-config.js';
import { ConfigError } from '../config/exclude-range.js';
import { importSession } from '../pipeline.js';
import { gistHeadline } from '../derive/gist.js';
import {
  dayKeyInZone,
  stripBridgeMetadata,
} from '../ingest/export.js';
import { loadGlobalConfig, saveGlobalConfig, globalConfigPath } from '../config/global-config.js';
import {
  createConfigResolver,
  sanitizeGlobalConfig,
  buildEmbeddingView,
  buildLlmView,
  buildRerankView,
  buildVecExtView,
} from './config-views.js';
import { createModelProber } from './probe.js';
import { createDbAdmin } from './db-admin.js';
import { createRebuildManager } from './rebuild.js';
import { createSceneOps } from './scene-ops.js';
import { createSessionLock } from './session-lock.js';
import {
  API_PREFIX,
  PANEL_METHODS,
  PanelError,
  createPanelHandler,
} from './panel-http.js';
import { findSessionFile, findLatestSession } from './session-sync.js';
import {
  TIME_MAX,
  ALL_ROWS,
  intParam,
  boolParam,
  instantParam,
  createPanelSessionStore,
} from './panel-session-store.js';
import { createPanelSearch } from './panel-search.js';

export {
  API_PREFIX,
  PANEL_METHODS,
  PanelError,
  createPanelHandler,
  findSessionFile,
  findLatestSession,
};

/** 依赖 DSH 的工具注册表与 HTTP 载体 */

/**
 * 创建面板 RPC 的**业务层**（不依赖 HTTP，便于测试与复用）。
 *
 * @param {{
 *   handle: object, repo?: object, extras?: object,
 *   dbPath?: string, dshHome?: string, dbRoot?: string,
 *   config?: object, logger?: {info?(m:string):void, warn?(m:string):void},
 *   sessionLock?: object, recallLog?: object[],
 *   getHostLlm?: () => object|null, hostLlm?: object,
 *   syncSession?: (sessionId: string) => Promise<object>,
 * }} opts
 */
export function createPanelApi(opts = {}) {
  const handle = opts.handle;
  if (!handle?.db) throw new TypeError('createPanelApi: 需要 openDb() 返回的 handle');

  const repo = opts.repo ?? createRepo(handle);
  const extras = opts.extras ?? createExtras(handle);
  const db = handle.db;
  const dbPath = opts.dbPath ?? handle.dbPath ?? ':memory:';
  const dshHome = opts.dshHome ?? handle.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const dbRoot = opts.dbRoot ?? (dbPath && dbPath !== ':memory:'
    ? path.dirname(dbPath)
    : path.join(dshHome, 'verbatim'));
  const sessionsRoot = path.join(dshHome, 'sessions');
  const config = opts.config ?? {};
  const logger = opts.logger ?? {};
  const syncSession = typeof opts.syncSession === 'function' ? opts.syncSession : null;
  const getHostLlm = typeof opts.getHostLlm === 'function'
    ? opts.getHostLlm
    : (opts.hostLlm ? () => opts.hostLlm : () => null);

  /** 预编译语句缓存（面板一次请求会查十几次，别每次都 prepare） */
  const stmtCache = new Map();
  const stmt = (sql) => {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmtCache.set(sql, s);
    }
    return s;
  };

  const {
    getGlobal,
    invalidateGlobal,
    embCfg,
    hasEmbeddingKey,
    llmCfg,
    hasLlmReady,
    rerankCfg,
  } = createConfigResolver({ config, dshHome, logger, getHostLlm });

  /** note 表有没有 session_id 列（v6 起已加；保留探测以兼容未迁移的 v5 老库） */
  let noteColsCache = null;
  function noteHasSessionColumn() {
    if (noteColsCache !== null) return noteColsCache;
    try {
      noteColsCache = db
        .prepare('PRAGMA table_info(note)')
        .all()
        .some((c) => c.name === 'session_id');
    } catch {
      noteColsCache = false;
    }
    return noteColsCache;
  }

  const {
    sessionFiles,
    findLogFile,
    loadLog,
    safeLoadLog,
    readSessionConfig,
    sessionAggregate,
    vectorStatus,
    buildWarnings,
    cachedLogs,
  } = createPanelSessionStore({
    handle,
    repo,
    extras,
    db,
    stmt,
    dbRoot,
    sessionsRoot,
    logger,
    embCfg,
    hasEmbeddingKey,
    noteHasSessionColumn,
  });

  const {
    recentTasks,
    assertSafeToReset,
    makeEmbeddingProvider,
    findRunningTask,
    startRebuildTask,
    getTask,
  } = createRebuildManager({
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
  });

  /* ══════════════════════════════ 20 个 RPC ══════════════════════════════ */

  /**
   * E1：需要会话范围的方法必须带 sessionId，缺了报错 —— **绝不默认全库**。
   * @param {string} method
   * @param {object} params
   * @returns {string}
   */
  function requireSession(method, params) {
    const raw = params?.sessionId;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new PanelError(
        'SESSION_ID_REQUIRED',
        `panel.${method} 必须带 sessionId（D-014：一个对话一个面板）。`
        + '不带 sessionId 会把别的会话的数据混进来 —— 这正是旧 /verbatim-api/stats 的 bug，不再允许。',
        400,
      );
    }
    try {
      return assertSessionId(raw);
    } catch (error) {
      throw new PanelError('BAD_SESSION_ID', error?.message ?? String(error), 400);
    }
  }

  /** 可选 sessionId（按 id 定位的方法用它做跨会话保护；不传 = 全库管理视角） */
  function optionalSession(method, params) {
    const raw = params?.sessionId;
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') {
      throw new PanelError('BAD_SESSION_ID', `panel.${method} 的 sessionId 必须是非空字符串`, 400);
    }
    try {
      return assertSessionId(raw);
    } catch (error) {
      throw new PanelError('BAD_SESSION_ID', error?.message ?? String(error), 400);
    }
  }

  /**
   * `panel.status({ sessionId })` → { enabled, stats, vector }（B3~B7）
   *
   * - enabled 只有 record / tools 两个开关（D-166：autoRecall 不进面板）
   * - stats 只算**这个会话**（A2），compactedMsgs 是面板最核心的数字（B4）
   * - rewindedMsgs 从原始日志重新数（库里是物理删除的，查不到，B5）
   * - vector.state 明确区分 ok / degraded / disabled（B6/B7）
   */
  function status(params) {
    const sessionId = requireSession('status', params);
    const cfg = readSessionConfig(sessionId);
    const agg = sessionAggregate(sessionId);
    const log = safeLoadLog(sessionId);
    const rewindedMsgs = log ? Number(log.stats.rewoundCount ?? 0) : null;
    const rewindedChars = log ? Number(log.stats.rewoundChars ?? 0) : null;
    const excludedMsgs = agg.excludedMsgs;
    const deletedNotesCount = noteHasSessionColumn()
      ? extras.note.count({ sessionId, deletedOnly: true })
      : extras.note.count({ deletedOnly: true });
    let scenesWithGist = 0;
    let llmGistScenes = 0;
    try {
      scenesWithGist = Number(
        stmt("SELECT COUNT(*) AS c FROM scene WHERE session_id = ? AND gist IS NOT NULL AND TRIM(gist) != ''").get(sessionId)?.c ?? 0,
      );
      llmGistScenes = Number(
        stmt("SELECT COUNT(*) AS c FROM scene WHERE session_id = ? AND gist_source = 'llm'").get(sessionId)?.c ?? 0,
      );
    } catch {
      scenesWithGist = 0;
      llmGistScenes = 0;
    }
    const llmGistRatio = agg.sceneCount > 0 ? Math.round((llmGistScenes / agg.sceneCount) * 100) : 0;
    const llmConf = llmCfg();

    return {
      enabled: { record: cfg.record === true, tools: cfg.tools === true },
      excludeRanges: cfg.excludeRanges,
      stats: {
        totalMsgs: agg.totalMsgs,
        totalChars: agg.totalChars,
        startAt: agg.startAt,
        compactedMsgs: agg.compactedMsgs,
        compactedChars: agg.compactedChars,
        rewindedMsgs,
        rewindedChars,
        excludedMsgs,
        deletedNotesCount,
        sceneCount: agg.sceneCount,
        scenesWithGist,
        llmGistScenes,
        llmGistRatio,
        dayCount: agg.dayCount,
      },
      vector: vectorStatus(sessionId, agg.totalMsgs),
      llm: {
        ready: hasLlmReady(),
        enabled: llmConf.enabled,
        mode: llmConf.mode,
        model: llmConf.model,
      },
      sessionId,
      dbPath,
      hasVec: handle.hasVec === true,
      warnings: buildWarnings(),
      tasks: recentTasks(),
    };
  }

  /**
   * `panel.timeline({ sessionId, from?, to?, limit? })`
   * → [{ date, msgCount, sceneCount, chars, scenes: [{ id, startAt, endAt, msgCount, compacted }] }]
   *
   * 按天分组，默认最近 7 天（PANEL §3.4「默认展开最近 7 天」）。
   * `limit` 是**天数**，不是消息数。
   */
  function timeline(params) {
    const sessionId = requireSession('timeline', params);
    const limit = intParam(params.limit, 'limit', { def: 7, min: 1, max: 100 });
    const from = instantParam(params.from, 'from', 0);
    const to = instantParam(params.to, 'to', TIME_MAX);
    if (to <= from) throw new PanelError('BAD_RANGE', `to（${to}）必须大于 from（${from}）`, 400);

    const scenes = repo.scenesByTimeRange(sessionId, from, to, ALL_ROWS);

    /** @type {Map<string, {date:string, msgCount:number, sceneCount:number, chars:number, scenes:object[]}>} */
    const byDay = new Map();
    const ensure = (date) => {
      let d = byDay.get(date);
      if (!d) {
        d = { date, msgCount: 0, sceneCount: 0, pendingMsgs: 0, chars: 0, scenes: [] };
        byDay.set(date, d);
      }
      return d;
    };

    for (const m of stmt(
      'SELECT at, LENGTH(text) AS len, scene_id FROM msg WHERE session_id = ? AND at >= ? AND at < ?',
    ).iterate(sessionId, from, to)) {
      const d = ensure(dayKeyInZone(Number(m.at)));
      d.msgCount += 1;
      d.chars += Number(m.len ?? 0);
      if (m.scene_id === null || m.scene_id === undefined) {
        d.pendingMsgs += 1;
      }
    }
    for (const s of scenes) {
      // 场景归到「它在查询区间内的第一天」（不是 startAt 那天）：
      // 一场可能跨午夜（11-15 18:25 → 11-16 04:35），如果按 startAt 归组，
      // from=11-16 时会在 11-15 凭空造出一个 msgCount=0 的天，看起来像 bug。
      const day = dayKeyInZone(Math.max(s.startAt, from));
      const d = ensure(day);
      d.scenes.push({
        id: s.id,
        startAt: s.startAt,
        endAt: s.endAt,
        msgCount: s.msgCount,
        gist: gistHeadline(s.gist, 42),
        gistSource: s.gistSource ?? null,
        locked: s.locked === 1,
        // 这一场里有没有被压缩掉的（D-141：压缩的内容必须还在库里）
        compacted: s.crossesCompaction === 1 || s.outOfSurfaceCount > 0,
      });
    }

    const days = [...byDay.values()]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit);
    for (const d of days) {
      d.scenes.sort((a, b) => a.startAt - b.startAt);
      d.sceneCount = d.scenes.length;
    }
    return days;
  }

  /**
   * `panel.sceneDetail({ sceneId })`
   * → { startAt, endAt, msgs: [{ id, at, speaker, text, inSurface }], leadIn }
   *
   * 按 id 定位，不需要 sessionId（E1 豁免）。
   */
  function sceneDetail(params) {
    const sceneId = intParam(params.sceneId, 'sceneId', { min: 1 });
    const scene = repo.sceneById(sceneId);
    if (!scene) throw new PanelError('SCENE_NOT_FOUND', `没有 id=${sceneId} 的场景`, 404);

    // includeExcluded=true：核对时被排除的那段也要看得见（不然会以为"没记"）
    const rawMsgs = repo.msgsByScene(sceneId, true);
    const mediaByMsg = extras?.media?.byMsgIds ? extras.media.byMsgIds(rawMsgs.map((m) => m.id)) : new Map();
    const msgs = rawMsgs.map((m) => ({
      id: m.id,
      at: m.at,
      speaker: m.speaker,
      text: m.text,
      inSurface: m.inSurface,
      excluded: m.excluded ?? 0,
      media: mediaByMsg.get(Number(m.id)) ?? [],
    }));

    let leadIn = null;
    if (scene.leadIn !== null && scene.leadIn !== undefined) {
      try {
        leadIn = JSON.parse(scene.leadIn);
      } catch {
        leadIn = scene.leadIn; // 老数据可能不是 JSON，原样给出，别让面板崩
      }
    }

    return {
      sceneId: scene.id,
      sessionId: scene.sessionId,
      startAt: scene.startAt,
      endAt: scene.endAt,
      msgCount: scene.msgCount,
      precededBy: scene.precededBy ?? null,
      followedBy: scene.followedBy ?? null,
      locked: scene.locked === 1,
      gist: gistHeadline(scene.gist, 60),
      gistSource: scene.gistSource ?? null,
      compacted: scene.crossesCompaction === 1 || scene.outOfSurfaceCount > 0,
      msgs,
      leadIn,
    };
  }

  /**
   * `panel.notes({ sessionId, limit?, offset? })` → [{ id, content, about, at }]
   *
   * A2 会话隔离：`note` 表从 v6 起有 `session_id` 列，按会话过滤（TA记的是
   * 「在这个对话里记的」，面板也是「一个对话一个面板」）。
   * 老库（v5 及更早、还没迁移完）没有这一列时才退回全库，并在 warnings 里明说。
   */
  function notes(params) {
    const sessionId = requireSession('notes', params);
    const limit = intParam(params.limit, 'limit', { def: 100, min: 1, max: 500 });
    const offset = intParam(params.offset, 'offset', { def: 0, min: 0, max: 1_000_000 });

    const rows = noteHasSessionColumn()
      ? extras.note.list({ sessionId, limit, offset })
      : extras.note.list({ limit, offset });
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      about: r.about ?? null,
      at: r.at,
    }));
  }

  /**
   * `panel.deletedNotes({ sessionId, limit?, offset? })` → { items, total }
   * 回收站：仅列该会话已被软删、仍在 30 天保留期内的笔记，并在读取前顺手清理过期条目。
   */
  function deletedNotes(params) {
    const NOTE_RETENTION_MS = 30 * 86_400_000;
    const sessionId = requireSession('deletedNotes', params);
    const limit = intParam(params.limit, 'limit', { def: 50, min: 1, max: 500 });
    const offset = intParam(params.offset, 'offset', { def: 0, min: 0, max: 1_000_000 });
    const hasSessionCol = noteHasSessionColumn();

    try {
      if (hasSessionCol) extras.note.purgeExpired(NOTE_RETENTION_MS, Date.now(), { sessionId });
      else extras.note.purgeExpired(NOTE_RETENTION_MS, Date.now());
    } catch {
      // best-effort：清理失败不影响列回收站
    }

    const filter = hasSessionCol ? { sessionId, deletedOnly: true } : { deletedOnly: true };
    const rows = extras.note.list({ ...filter, limit, offset });
    const total = extras.note.count(filter);
    return {
      items: rows.map((r) => ({
        id: r.id,
        content: r.content,
        about: r.about ?? null,
        at: r.at,
        deletedAt: r.deletedAt,
        expiresAt: r.deletedAt ? r.deletedAt + NOTE_RETENTION_MS : null,
      })),
      total,
    };
  }

  /**
   * `panel.search({ sessionId, query, when?, limit?, includeExcluded? })`
   * 面板搜索：关键词路优先；命中 < 5 条且本会话向量可用时按需补语义路（RRF 融合）。
   */
  const search = createPanelSearch({
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
  });


  /**
   * `panel.sample({ sessionId })` → { id, at, speaker, text, scene }
   *
   * 「抽一条」用于核对（C4）。该会话没有任何消息时返回 null（面板显示空态）。
   */
  function sample(params) {
    const sessionId = requireSession('sample', params);
    const total = Number(stmt('SELECT COUNT(*) AS c FROM msg WHERE session_id = ?').get(sessionId)?.c ?? 0);
    if (total === 0) return null;

    // 均匀随机：O(1) 抽样，不把全库消息正文拉进内存
    const offset = Math.floor(Math.random() * total);
    const picked = stmt('SELECT id FROM msg WHERE session_id = ? ORDER BY seq LIMIT 1 OFFSET ?').get(sessionId, offset);
    if (!picked) return null;
    const m = repo.msgsByIds([Number(picked.id)])[0];
    if (!m) return null;
    const scene = m.sceneId ? repo.sceneById(m.sceneId) : null;
    return {
      id: m.id,
      seq: m.seq,
      sessionId,
      at: m.at,
      speaker: m.speaker,
      text: m.text,
      inSurface: m.inSurface,
      scene: scene
        ? { id: scene.id, startAt: scene.startAt, endAt: scene.endAt, msgCount: scene.msgCount }
        : null,
    };
  }

  /**
   * `panel.verify({ msgId })` → { dbText, logText, identical }（C4 / E2，P0）
   *
   * 这是整个面板最重要的功能：让你亲眼确认「库里存的字」和「日志里的字」一模一样。
   *
   * dbText  —— 库里存的（已经清洗过桥接元数据，D-216）
   * logText —— 从原始会话日志重导出并**再清洗一次**（stripBridgeMetadata）后的正文
   * identical —— 两者是否逐字相同
   */
  function verify(params) {
    const msgId = intParam(params.msgId, 'msgId', { min: 1 });
    const row = repo.msgsByIds([msgId])[0];
    if (!row) {
      throw new PanelError(
        'MSG_NOT_FOUND',
        `没有 id=${msgId} 的消息。原文是唯一事实来源，查不到就是真的不在库里（可能已撤回，或 id 不属于这个库）。`,
        404,
      );
    }

    const log = safeLoadLog(row.sessionId);
    let logText = null;
    let source = 'no-log';
    let reason = null;

    if (log) {
      const entry = log.raw.get(row.seq);
      if (entry) {
        // 库里存的是清洗后的正文（D-216）；比对必须用同一条清洗路径，
        // 否则每条带 `【当前时间】…` 的消息都会假失败。
        logText = stripBridgeMetadata(entry.raw);
        source = 'log';
      } else {
        source = 'log-missing-seq';
        reason = `日志里没有 seq=${row.seq}（可能已被撤回、或日志已轮转）`;
      }
    } else {
      reason = '找不到这个会话的原始日志文件，无法比对';
    }

    const identical = typeof logText === 'string' && logText === row.text;
    return {
      dbText: row.text,
      logText,
      identical,
      msgId: row.id,
      sessionId: row.sessionId,
      seq: row.seq,
      at: row.at,
      speaker: row.speaker,
      source,
      reason,
    };
  }

  /**
   * `panel.set({ sessionId, key, value })` → 落盘后的开关状态（E4：写操作必须明确返回）
   *
   * key: 'record' | 'tools' | 'autoRecall'
   * 走 `setSessionFlag`（T9 的配置层），**不自己写文件**。
   */
  function set(params) {
    const sessionId = requireSession('set', params);
    const key = String(params.key ?? '');
    if (!['record', 'tools', 'autoRecall'].includes(key)) {
      throw new PanelError(
        'BAD_KEY',
        `开关名只能是 "record" / "tools" / "autoRecall"，收到 ${JSON.stringify(params.key)}`,
        400,
      );
    }
    const value = boolParam(params.value, 'value');

    let cfg;
    try {
      cfg = setSessionFlag(sessionId, key, value, { dbRoot });
    } catch (error) {
      throw new PanelError('CONFIG_WRITE_FAILED', `开关没保存上：${error?.message ?? error}`, 500);
    }

    const applies = key === 'record'
      ? '已保存。下一次同步开始按新开关执行（关掉后新消息不再入库，已有数据一条不删）。'
      : key === 'tools'
        ? '已保存。已尝试热更新当前会话的工具注入；若对话未加载，将在下次打开时生效。'
        : '已保存（autoRecall 是预留配置项，面板不显示开关，D-166）。';

    return {
      ok: true,
      sessionId,
      key,
      value,
      // 面板只渲染两个开关（D-166）；autoRecall 保留在协议里但前端不显示
      enabled: { record: cfg.record === true, tools: cfg.tools === true },
      config: {
        record: cfg.record === true,
        tools: cfg.tools === true,
        autoRecall: cfg.autoRecall === true,
        excludeRanges: cfg.excludeRanges,
      },
      applies,
    };
  }

  /**
   * `panel.setExcludeRanges({ sessionId, ranges })` → { ok: true, sessionId, excludeRanges, synced }
   * 写回排除区间配置，并立刻同步更新数据库里的 `msg.excluded` 与 `scene.excluded_count/has_excluded`。
   */
  function setExcludeRanges(params) {
    const sessionId = requireSession('setExcludeRanges', params);
    const rawRanges = params.ranges !== undefined ? params.ranges : params.excludeRanges;
    if (!Array.isArray(rawRanges)) {
      throw new PanelError('BAD_EXCLUDE_RANGE', 'ranges 必须是数组', 400);
    }

    let cfg;
    let normalized;
    try {
      cfg = setSessionExcludeRanges(sessionId, rawRanges, { dbRoot });
      normalized = normalizeRanges(cfg.excludeRanges);
    } catch (err) {
      if (err instanceof ConfigError || err?.name === 'ConfigError') {
        throw new PanelError('BAD_EXCLUDE_RANGE', err.message, 400);
      }
      throw new PanelError('CONFIG_WRITE_FAILED', `排除区间没保存上：${err?.message ?? err}`, 500);
    }

    const synced = extras.sceneAssign.syncExcludedForSession(sessionId, normalized);
    return {
      ok: true,
      sessionId,
      excludeRanges: cfg.excludeRanges,
      synced,
    };
  }

  /**
   * `panel.rebuild({ sessionId, scope })` → { taskId }（然后轮询 panel.task）
   *
   * scope:
   *   'scene'  —— 从 msg 重建场景（切分 + 邻接），原文一条不动
   *   'vector' —— 重建向量索引（需要 embedding key）
   *   'derive' —— 场景 + gist（要 llm）+ 向量（要 embedding），缺什么就明确说跳过
   *
   * 安全闸门（E3）：任何 `reset: true` 的清库意图先过 assertSafeToReset()，
   * 真实记忆库直接 403；即使临时库也只重建派生数据，**永不删 msg**。
   */
  function rebuild(params) {
    const sessionId = requireSession('rebuild', params);
    const scope = params.scope === undefined || params.scope === null || params.scope === ''
      ? 'derive'
      : String(params.scope);
    if (!['scene', 'vector', 'derive', 'incremental', 'gist'].includes(scope)) {
      throw new PanelError(
        'BAD_SCOPE',
        `scope 只能是 "scene" / "vector" / "derive" / "incremental" / "gist"，收到 ${JSON.stringify(params.scope)}`,
        400,
      );
    }

    if (params.reset === true) {
      // 真实库会在这里被 403 拒绝（可复现的闸门）
      assertSafeToReset(dbPath);
      // 临时库也不清原文：重建只重建派生数据
      logger.warn?.(`[verbatim] panel.rebuild reset 请求：库在临时目录下，仍只重建派生数据（不删 msg）`);
    }

    // 向量重建依赖 embedding key：没有就**当场明确拒绝**（E4 / B7），
    // 不要先返回 taskId 再在后台失败 —— 前端会一直以为"还在跑"。
    if (scope === 'vector' && !hasEmbeddingKey()) {
      throw new PanelError(
        'NO_EMBEDDING',
        '没有配置 embedding 的 API Key，向量索引无法重建。去设置页填一个，或把服务类型改成「本地」。'
        + '时间轴与关键词检索不受影响 —— 这不是失败，是「语义搜索未启用」（B7）。',
        503,
      );
    }

    if (scope === 'gist' && !hasLlmReady()) {
      throw new PanelError(
        'NO_LLM',
        '尚未启用或未配好场景摘要 LLM。请先在「设置 → 逐字记忆 → 场景摘要 LLM」启用并完成配置（未启用时已自动使用零成本抽取式摘要）。',
        503,
      );
    }

    // 同会话已有同类（或全量）向量任务在跑时直接复用，避免连点造成并发重算
    const active = findRunningTask(sessionId, scope);
    if (active) {
      return {
        taskId: active.id,
        scope: active.scope,
        sessionId,
        state: active.state,
        progress: active.progress ?? null,
        reused: true,
      };
    }

    const useLlm = params.useLlm === false ? false : undefined;
    const onlyUnrefined = params.onlyUnrefined === true;
    const concurrency = Number.isFinite(Number(params.concurrency)) ? Number(params.concurrency) : undefined;
    const task = startRebuildTask({ sessionId, scope, useLlm, onlyUnrefined, concurrency });
    return { taskId: task.id, scope, sessionId, state: task.state, progress: task.progress ?? null };
  }

  /** `panel.task({ taskId })` → 重建任务进度（PANEL §5「然后轮询进度」的落点） */
  function taskInfo(params) {
    const taskId = String(params.taskId ?? '');
    if (!taskId) throw new PanelError('BAD_ARG', '缺少 taskId', 400);
    const t = getTask(taskId);
    if (!t) throw new PanelError('TASK_NOT_FOUND', `没有 taskId=${taskId} 的重建任务（任务只保留最近 20 个）`, 404);
    return {
      taskId: t.id,
      scope: t.scope,
      sessionId: t.sessionId,
      state: t.state,
      progress: t.progress ?? null,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      result: t.result,
      error: t.error,
    };
  }

  /**
   * `panel.flag({ msgId, reason? })` → { id }
   *
   * 只记一笔，不删任何东西（C5 / D-167）。标记后检索照常返回该条。
   */
  function flag(params) {
    const msgId = intParam(params.msgId, 'msgId', { min: 1 });
    const row = repo.msgsByIds([msgId])[0];
    if (!row) throw new PanelError('MSG_NOT_FOUND', `没有 id=${msgId} 的消息，标不了`, 404);
    const reason = params.reason === undefined || params.reason === null || params.reason === ''
      ? null
      : String(params.reason);

    let id;
    try {
      id = extras.flag.insert({ msgId, reason });
    } catch (error) {
      throw new PanelError('FLAG_FAILED', `标记没记上：${error?.message ?? error}`, 500);
    }
    return { id, msgId, reason, at: Date.now(), sessionId: row.sessionId };
  }

  /**
   * `panel.flags({ sessionId, limit? })` → [{ id, msgId, reason, at, snippet }]
   *
   * 只要未取消的标记（resolved_at IS NULL）。snippet 供核对页直接显示原文开头。
   */
  function flags(params) {
    const sessionId = requireSession('flags', params);
    const limit = intParam(params.limit, 'limit', { def: 50, min: 1, max: 500 });

    const rows = extras.flag.list({ sessionId, openOnly: true, limit });
    const ids = rows.map((r) => r.msgId);
    const byId = new Map(repo.msgsByIds(ids).map((m) => [m.id, m]));

    return rows.map((r) => {
      const msg = byId.get(r.msgId);
      const text = msg?.text ?? '';
      return {
        id: r.id,
        msgId: r.msgId,
        reason: r.reason ?? null,
        at: r.at,
        snippet: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      };
    });
  }

  /** `panel.unflag({ id })` → { ok }（只撤销标记，不碰原文） */
  function unflag(params) {
    const id = intParam(params.id, 'id', { min: 1 });
    const changed = extras.flag.resolve(id);
    return {
      ok: changed,
      id,
      message: changed ? '已取消标记（这条原文没有任何变化）' : '没有可取消的标记（不存在，或已经取消过了）',
    };
  }

  /**
   * `panel.deleteNote({ id, sessionId?, reason? })` → { ok }（软删，30 天内可恢复）
   *
   * 带 sessionId 时只删该会话的笔记（A1：B 会话不能凭编号删掉 A 的）；
   * 不带 = 全库管理视角（PANEL §5 的契约只写了 id，这里向后兼容）。
   */
  function deleteNote(params) {
    const id = intParam(params.id, 'id', { min: 1 });
    const sessionId = optionalSession('deleteNote', params);
    const reason = params.reason === undefined || params.reason === null || params.reason === ''
      ? null
      : String(params.reason);

    const row = extras.note.byId(id, sessionId ? { sessionId } : {});
    if (!row) {
      throw new PanelError(
        'NOTE_NOT_FOUND',
        `没有 id=${id} 的笔记${sessionId ? `（会话 ${sessionId} 里没有这条）` : ''}`,
        404,
      );
    }
    if (row.deletedAt !== null) {
      return { ok: false, id, deletedAt: row.deletedAt, message: '这条笔记之前已经删过了（30 天内可以在回收站恢复）' };
    }

    const deletedAt = Date.now();
    const changed = extras.note.softDelete(id, deletedAt, sessionId ? { sessionId } : {});
    if (changed) {
      try {
        if (handle.hasVec) db.prepare('DELETE FROM vec_note WHERE note_id = ?').run(BigInt(id));
      } catch { /* ignore */ }
      try {
        extras.audit.insert({
          action: 'forget',
          target: `note:${id}`,
          detail: { via: 'panel', reason, sessionId },
        });
      } catch {
        // 审计失败不该让删除回滚：笔记已经标记删除了
      }
    }
    return {
      ok: changed,
      id,
      deletedAt: changed ? deletedAt : null,
      message: changed ? '已删除（软删，30 天内可在回收站恢复）' : '删除没生效（可能刚刚被删过）',
    };
  }

  /**
   * `panel.restoreNote({ id, sessionId? })` → { ok }
   *
   * 带 sessionId 时只恢复该会话的笔记（和 deleteNote 同一套归属判断）。
   */
  function restoreNote(params) {
    const id = intParam(params.id, 'id', { min: 1 });
    const sessionId = optionalSession('restoreNote', params);
    const row = extras.note.byId(id, sessionId ? { sessionId } : {});
    if (!row) {
      throw new PanelError(
        'NOTE_NOT_FOUND',
        `没有 id=${id} 的笔记${sessionId ? `（会话 ${sessionId} 里没有这条）` : ''}`,
        404,
      );
    }
    if (row.deletedAt === null) {
      return { ok: false, id, message: '这条笔记没有被删过，不需要恢复' };
    }
    const changed = extras.note.restore(id, sessionId ? { sessionId } : {});
    if (changed) {
      try {
        extras.audit.insert({ action: 'restore', target: `note:${id}`, detail: { via: 'panel', sessionId } });
      } catch {
        // 同上
      }
    }
    return { ok: changed, id, message: changed ? '已恢复' : '恢复没生效' };
  }

  /**
   * `panel.addNote({ sessionId, content, about? })` → { ok, id, note }
   * 允许用户在面板里主动补记一条笔记（与 Agent 的 memory_remember 共用 note 表，严格按会话隔离）。
   */
  function addNote(params) {
    const sessionId = requireSession('addNote', params);
    const content = typeof params.content === 'string' ? params.content.trim() : '';
    if (!content) throw new PanelError('BAD_ARG', '笔记内容不能为空', 400);
    if (content.length > 2000) throw new PanelError('BAD_ARG', '单条笔记最多 2000 字', 400);
    const rawAbout = params.about === undefined || params.about === null || params.about === ''
      ? null
      : String(params.about).trim();
    if (rawAbout !== null && !['me', 'him', 'us'].includes(rawAbout)) {
      throw new PanelError('BAD_ARG', `about 只能是 me / him / us 或留空，收到 ${JSON.stringify(params.about)}`, 400);
    }
    const at = Date.now();
    const id = extras.note.insert({ sessionId, content, about: rawAbout, at });
    try {
      extras.audit.insert({ action: 'remember', target: `note:${id}`, detail: { via: 'panel', sessionId, about: rawAbout } });
    } catch { /* 审计失败不影响写入 */ }
    const note = extras.note.byId(id, { sessionId }) ?? { id, sessionId, content, about: rawAbout, at, deletedAt: null };
    return { ok: true, id, note };
  }

  function globalConfig(params) {
    optionalSession('globalConfig', params);
    const { config: loadedCfg, exists, warnings } = loadGlobalConfig({ dshHome });
    return {
      config: sanitizeGlobalConfig(loadedCfg),
      path: globalConfigPath({ dshHome }),
      exists,
      warnings,
      embedding: buildEmbeddingView(loadedCfg),
      llm: buildLlmView(loadedCfg, Boolean(getHostLlm())),
      rerank: buildRerankView(loadedCfg),
      vecExt: buildVecExtView(handle),
    };
  }

  const probeLocal = createModelProber({ embCfg, llmCfg, rerankCfg, getHostLlm });

  /** 写全局配置（深合并）。白名单字段，避免前端乱写把配置搞坏。 */
  function setGlobalConfig(params) {
    optionalSession('setGlobalConfig', params);
    const patch = params.patch ?? params.config;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new PanelError('BAD_ARG', 'patch 必须是一个对象', 400);
    }
    const allowed = new Set(['defaults', 'embedding', 'llm', 'rerank', 'search', 'index']);
    const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw new PanelError(
        'BAD_KEY',
        `不认识的配置块：${unknown.join(', ')}。可写：${[...allowed].join(' / ')}`,
        400,
      );
    }
    // Key 直接存（作者 2026-11-18：不绕环境变量）。只是提醒一下会明文落盘。
    const patchKey = patch?.embedding?.apiKey;
    if (typeof patchKey === 'string' && patchKey.length > 500) {
      throw new PanelError('BAD_ARG', 'embedding.apiKey 太长了（上限 500 字符）', 400);
    }
    const patchLlmKey = patch?.llm?.apiKey;
    if (typeof patchLlmKey === 'string' && patchLlmKey.length > 500) {
      throw new PanelError('BAD_ARG', 'llm.apiKey 太长了（上限 500 字符）', 400);
    }
    const patchRerankKey = patch?.rerank?.apiKey;
    if (typeof patchRerankKey === 'string' && patchRerankKey.length > 500) {
      throw new PanelError('BAD_ARG', 'rerank.apiKey 太长了（上限 500 字符）', 400);
    }
    const checkInt = (val, label, min, max) => {
      if (val === undefined) return;
      if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max) {
        throw new PanelError('BAD_ARG', `${label} 必须是 ${min}~${max} 的整数`, 400);
      }
    };
    if (patch.embedding) checkInt(patch.embedding.dim, 'embedding.dim', 16, 16384);
    if (patch.rerank) {
      checkInt(patch.rerank.topN, 'rerank.topN', 1, 100);
      checkInt(patch.rerank.timeoutMs, 'rerank.timeoutMs', 500, 60000);
    }
    if (patch.search) {
      checkInt(patch.search.defaultLimit, 'search.defaultLimit', 1, 100);
      checkInt(patch.search.maxLimit, 'search.maxLimit', 1, 500);
    }

    const next = saveGlobalConfig(patch, { dshHome });
    invalidateGlobal();   // 设置页改完立即生效，不用重启插件
    return {
      ok: true,
      config: sanitizeGlobalConfig(next),
      path: globalConfigPath({ dshHome }),
      embedding: buildEmbeddingView(next),
      llm: buildLlmView(next, Boolean(getHostLlm())),
      rerank: buildRerankView(next),
      vecExt: buildVecExtView(handle),
      applies: '已保存，立即生效。新会话按新默认值走；已有会话各自的开关不受影响（对话级优先）。',
    };
  }


  /* ───────────────────────── 数据库管理台（全局 + 跨会话切换视图） ───────────────────────── */

  const { dbOverview, dbRows, dbQuery, dbMaintain } = createDbAdmin({
    handle,
    db,
    repo,
    extras,
    dbPath,
    dbRoot,
    stmt,
    noteHasSessionColumn,
    requireSession,
    optionalSession,
    readSessionConfig,
    intParam,
    PanelError,
    logger,
  });


  const {
    mergeScene,
    splitScene,
    refineOneScene,
    setSceneGist,
    setMsgExcluded,
    updateNote,
    mediaPreview,
    setMediaCaption,
    findDuplicateNotes,
    mergeNotes,
  } = createSceneOps({
    handle,
    db,
    repo,
    extras,
    stmt,
    requireSession,
    intParam,
    PanelError,
    llmCfg,
    getHostLlm,
    hasEmbeddingKey,
    makeEmbeddingProvider,
    noteHasSessionColumn,
    dshHome,
    dbRoot,
    logger,
  });

  const recallEntries = Array.isArray(opts.recallLog) ? opts.recallLog : [];
  function recallLog(params) {
    const sid = optionalSession('recallLog', params);
    const limit = intParam(params.limit, 'limit', { def: 20, min: 1, max: 50 });
    const list = sid ? recallEntries.filter((e) => e.sessionId === sid) : recallEntries;
    return { items: list.slice(0, limit), total: list.length };
  }

  const sessionLock = opts.sessionLock ?? createSessionLock();
  const lockWrite = (key, fn) => sessionLock.withLock(key, fn);

  const methods = {
    status,
    timeline,
    sceneDetail,
    notes,
    deletedNotes,
    sample,
    verify,
    search,
    set,
    setExcludeRanges,
    rebuild,
    flag,
    flags,
    unflag,
    deleteNote,
    restoreNote,
    addNote,
    globalConfig,
    setGlobalConfig,
    probeLocal,
    dbOverview,
    dbRows,
    dbQuery,
    dbMaintain: (p) => (
      ['clearSession', 'importSession', 'vacuum'].includes(p?.action)
        ? lockWrite(p?.sessionId || p?.payload?.sessionId || '__global__', () => dbMaintain(p))
        : dbMaintain(p)
    ),
    recallLog,
    mergeScene: (p) => lockWrite(p?.sessionId, () => mergeScene(p)),
    splitScene: (p) => lockWrite(p?.sessionId, () => splitScene(p)),
    refineOneScene: (p) => lockWrite(p?.sessionId, () => refineOneScene(p)),
    mediaPreview,
    setMediaCaption,
    findDuplicateNotes,
    mergeNotes,
    setSceneGist: (p) => lockWrite(p?.sessionId, () => setSceneGist(p)),
    setMsgExcluded: (p) => lockWrite(p?.sessionId, () => setMsgExcluded(p)),
    updateNote,
    // 补充方法：PANEL §5 的 rebuild 说「→ { taskId } 然后轮询进度」，
    // 没有它前端无法轮询（详见报告）。
    task: taskInfo,
  };

  return {
    methods,
    /** 统一入口：未知方法 404，业务错误统一成 PanelError */
    async call(method, params) {
      const name = String(method ?? '');
      const fn = methods[name];
      if (typeof fn !== 'function') {
        throw new PanelError(
          'METHOD_NOT_FOUND',
          `没有 panel.${name} 这个方法。可用：${Object.keys(methods).map((k) => `panel.${k}`).join(', ')}`,
          404,
        );
      }
      return await fn(params ?? {});
    },
    /** 测试/诊断用：当前日志缓存状态 */
    debug() {
      return {
        methodNames: Object.keys(methods),
        cachedLogs: cachedLogs(),
        tasks: recentTasks(),
        dbRoot,
        dbPath,
      };
    },
  };
}
