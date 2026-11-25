// @ts-check
/**
 * panel-session-store.js —— 面板会话日志定位、缓存、配置读取与向量状态聚合
 */

import fs from 'node:fs';

import {
  loadSessionConfig,
  loadSessionExcludeRanges,
} from '../config/session-config.js';
import {
  dayKeyInZone,
  exportMessages,
  parseInstant,
  textBlocksOf,
} from '../ingest/export.js';
import { listSessionFiles, readSessionFile } from '../ingest/reader.js';
import { PanelError } from './panel-http.js';

/** 时间上界：比任何真实 at 都大（注意别用位运算，会把数截成 int32） */
export const TIME_MAX = Number.MAX_SAFE_INTEGER;

/** 「取该会话全部消息」的上限（库才几千条，够用且不用分页） */
export const ALL_ROWS = 5_000_000;

/** 日志导出缓存最多留几个会话（45MB 日志解压后是纯 CPU，多会话切换时适当保留） */
const LOG_CACHE_MAX = 8;

/** 会话日志文件清单的缓存时长（792 个目录的 stat，别每个请求都扫） */
const SESSION_FILE_TTL_MS = 30_000;

/**
 * 取整参数（缺省给默认值；范围外/非整数直接报错，不静默截断）
 * @param {unknown} value
 * @param {string} name
 * @param {{ def?: number, min?: number, max?: number }} [opts]
 */
export function intParam(value, name, { def, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (def === undefined) throw new PanelError('BAD_ARG', `缺少参数 ${name}`, 400);
    return def;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new PanelError('BAD_ARG', `${name} 必须是整数，收到 ${JSON.stringify(value)}`, 400);
  }
  if (n < min || n > max) {
    throw new PanelError('BAD_ARG', `${name} 超出范围 [${min}, ${max}]：${n}`, 400);
  }
  return n;
}

/** 取布尔参数：接受 true/false、'true'/'false'、1/0（query 串里全是字符串） */
export function boolParam(value, name) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  throw new PanelError('BAD_ARG', `${name} 必须是 true/false，收到 ${JSON.stringify(value)}`, 400);
}

/** 时间参数：数字（epoch ms）或 `YYYY-MM-DD` / ISO 串；解析不了就报错 */
export function instantParam(value, name, def) {
  if (value === undefined || value === null || value === '') return def;
  const at = parseInstant(value);
  if (at === null || !Number.isFinite(at)) {
    throw new PanelError('BAD_ARG', `${name} 看不懂：${JSON.stringify(value)}（支持 epoch 毫秒 / YYYY-MM-DD / ISO）`, 400);
  }
  return at;
}

/**
 * 创建面板会话状态、日志缓存与向量健康度读取器。
 */
export function createPanelSessionStore({
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
}) {
  /** 会话日志文件清单缓存（listSessionFiles 要 stat 792 个目录） */
  let filesCache = { at: 0, list: [] };
  function sessionFiles() {
    const now = Date.now();
    if (now - filesCache.at < SESSION_FILE_TTL_MS) return filesCache.list;
    let list = [];
    try {
      list = listSessionFiles(sessionsRoot);
    } catch {
      list = [];
    }
    filesCache = { at: now, list };
    return list;
  }

  /**
   * 按 sessionId 找原始日志文件。
   * @param {string} sessionId
   * @returns {string|null}
   */
  function findLogFile(sessionId) {
    const wanted = [sessionId];
    if (sessionId.startsWith('session-')) wanted.push(sessionId.slice('session-'.length));
    else wanted.push(`session-${sessionId}`);
    const list = sessionFiles();
    for (const id of wanted) {
      const hit = list.find((f) => f.sessionId === id);
      if (hit) return hit.filePath;
    }
    return null;
  }

  /** 日志缓存（按文件路径；最多留 LOG_CACHE_MAX 个会话） */
  const logCache = new Map();

  /**
   * 从原始日志重导出某个会话（按 mtime+size 缓存）。
   * @param {string} sessionId
   */
  function loadLog(sessionId) {
    const file = findLogFile(sessionId);
    if (!file) return null;

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }

    const cached = logCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

    let reader;
    try {
      reader = readSessionFile(file);
    } catch (error) {
      logger.warn?.(`[verbatim] 读会话日志失败（面板按「无日志」处理）：${error?.message ?? error}`);
      return null;
    }

    let excludeRanges = [];
    try {
      excludeRanges = loadSessionExcludeRanges(sessionId, { dbRoot });
    } catch {
      excludeRanges = [];
    }

    const exported = exportMessages(reader.events, {
      sessionId,
      includeRewound: true,
      excludeRanges,
    });

    const raw = new Map();
    for (const ev of reader.events) {
      if (ev?.type !== 'user/message' && ev?.type !== 'assistant/message') continue;
      const text = textBlocksOf(ev);
      if (!text.trim()) continue;
      raw.set(ev.seq, {
        speaker: ev.type === 'user/message' ? 'user' : 'assistant',
        at: typeof ev.time === 'number' ? ev.time : null,
        raw: text,
      });
    }

    const entry = {
      file,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId,
      raw,
      stats: exported.stats,
    };
    logCache.set(file, entry);
    while (logCache.size > LOG_CACHE_MAX) logCache.delete(logCache.keys().next().value);
    return entry;
  }

  /** 读日志但永不抛：面板不该因为日志缺失就整个打不开 */
  function safeLoadLog(sessionId) {
    try {
      return loadLog(sessionId);
    } catch (error) {
      logger.warn?.(`[verbatim] 导出会话日志失败：${error?.message ?? error}`);
      return null;
    }
  }

  /** 读该会话的配置（文件不存在 → 默认值，不落盘） */
  function readSessionConfig(sessionId) {
    try {
      return loadSessionConfig(sessionId, { dbRoot });
    } catch (error) {
      throw new PanelError('CONFIG_INVALID', `会话配置读不出来：${error?.message ?? error}`, 500);
    }
  }

  /**
   * 该会话的聚合数字（仅查聚合与轻量字段，避免把全量 msg.text 拉进 JS 内存）。
   * @param {string} sessionId
   */
  function sessionAggregate(sessionId) {
    const row = stmt(
      `SELECT COUNT(*) AS totalMsgs,
              COALESCE(SUM(LENGTH(text)), 0) AS totalChars,
              MIN(at) AS startAt,
              COALESCE(SUM(CASE WHEN in_surface = 0 THEN 1 ELSE 0 END), 0) AS compactedMsgs,
              COALESCE(SUM(CASE WHEN in_surface = 0 THEN LENGTH(text) ELSE 0 END), 0) AS compactedChars,
              COALESCE(SUM(CASE WHEN excluded = 1 THEN 1 ELSE 0 END), 0) AS excludedMsgs
       FROM msg
       WHERE session_id = ?`,
    ).get(sessionId) ?? {};
    const sceneCount = Number(
      stmt('SELECT COUNT(*) AS c FROM scene WHERE session_id = ?').get(sessionId)?.c ?? 0,
    );
    const days = new Set();
    for (const r of stmt('SELECT at FROM msg WHERE session_id = ?').iterate(sessionId)) {
      days.add(dayKeyInZone(Number(r.at)));
    }
    return {
      totalMsgs: Number(row.totalMsgs ?? 0),
      totalChars: Number(row.totalChars ?? 0),
      startAt: row.startAt === null || row.startAt === undefined ? null : Number(row.startAt),
      compactedMsgs: Number(row.compactedMsgs ?? 0),
      compactedChars: Number(row.compactedChars ?? 0),
      excludedMsgs: Number(row.excludedMsgs ?? 0),
      sceneCount,
      dayCount: days.size,
    };
  }

  /**
   * 面板索引状态 —— 「索引是什么」这个实体的唯一窗口。
   * @param {string} sessionId
   * @param {number} totalMsgs
   */
  function vectorStatus(sessionId, totalMsgs) {
    let models = [];
    let indexed = 0;
    try {
      models = stmt(
        `SELECT vec_model AS model, vec_dim AS dim, COUNT(*) AS n
         FROM msg
         WHERE session_id = ? AND vec_model IS NOT NULL
         GROUP BY vec_model, vec_dim
         ORDER BY n DESC`,
      ).all(sessionId).map((r) => ({
        model: String(r.model),
        dim: r.dim === null || r.dim === undefined ? null : Number(r.dim),
        count: Number(r.n),
      }));
      indexed = models.reduce((s, m) => s + m.count, 0);
    } catch {
      models = [];
      indexed = 0;
    }

    let configured = null;
    try {
      const emb = embCfg();
      const norm = String(emb.model ?? '').trim().replace(/:latest$/i, '').replace(/\/+$/, '');
      configured = norm ? { model: `sf:${norm}@${emb.dim}`, dim: emb.dim } : null;
    } catch {
      configured = null;
    }

    const key = hasEmbeddingKey();
    const vecLoaded = handle.hasVec === true;

    const consistent = models.length <= 1;
    const top = models[0] ?? null;
    const modelMatch = configured === null ? null
      : (top !== null && top.model === configured.model && top.dim === configured.dim);

    const coverage = totalMsgs > 0 ? indexed / totalMsgs : 0;
    const MIN_COVERAGE = 0.5;

    let state;
    let reason;
    if (!key) {
      state = 'disabled';
      reason = '语义搜索未启用：没有配 embedding 的 API Key（去设置页填，或把服务类型改成「本地」）。时间轴与关键词检索照常可用。';
    } else if (models.length > 1) {
      state = 'mixed';
      reason = `库里有 ${models.length} 套向量（${models.map((m) => `${m.model} ${m.count} 条`).join(' / ')}）。`
        + '不同模型的向量不可比，语义搜索现在不可用；重建一次就好（原文不会动）。';
    } else if (indexed === 0) {
      state = 'empty';
      reason = `语义搜索还没建索引（0 / ${totalMsgs} 条）。点 [重建] 建一次就能用；在那之前检索只走关键词和时间轴，不会白跑 embedding。`;
    } else if (modelMatch === false) {
      state = 'mismatch';
      reason = `索引是用 ${top.model} 建的，现在配置的是 ${configured?.model ?? '（未配置）'}。`
        + '两者不是同一个模型，语义搜索用不了 —— 用新模型重建一次就行（原文不会动）。';
    } else if (coverage < MIN_COVERAGE) {
      state = 'partial';
      reason = `语义搜索的索引只覆盖了 ${indexed} / ${totalMsgs} 条（${(coverage * 100).toFixed(1)}%）。`
        + '覆盖率太低时语义召回会系统性偏向已索引的部分，所以这时不跑语义路；点 [重建] 可以补全。';
    } else if (!vecLoaded) {
      state = 'degraded';
      reason = 'sqlite-vec 加载失败，已降级为暴力余弦（功能等价、结果一致，只是稍慢）。';
    } else {
      state = 'ok';
      reason = '语义检索可用。';
    }

    let pending = 0;
    try {
      pending = typeof extras?.vecMeta?.countPending === 'function'
        ? extras.vecMeta.countPending({ sessionId })
        : Math.max(0, totalMsgs - indexed);
    } catch {
      pending = Math.max(0, totalMsgs - indexed);
    }

    let windowTotal = 0;
    let windowPending = 0;
    const windowKinds = { window: 0, exchange: 0, thread: 0 };
    try {
      windowTotal = typeof extras?.window?.count === 'function' ? extras.window.count({ sessionId }) : 0;
      windowPending = typeof extras?.window?.countPending === 'function' ? extras.window.countPending({ sessionId }) : 0;
      if (windowTotal > 0) {
        const kRows = db.prepare(
          "SELECT COALESCE(kind, 'window') AS kind, COUNT(*) AS n FROM window WHERE session_id = ? GROUP BY COALESCE(kind, 'window')",
        ).all(sessionId);
        for (const r of kRows) {
          const k = r.kind === 'exchange' || r.kind === 'thread' ? r.kind : 'window';
          windowKinds[k] += Number(r.n ?? 0);
        }
      }
    } catch {
      windowTotal = 0;
      windowPending = 0;
    }
    const windowIndexed = Math.max(0, windowTotal - windowPending);

    return {
      model: top?.model ?? null,
      dim: top?.dim ?? null,
      models,
      configured,
      consistent,
      modelMatch,
      indexed,
      total: totalMsgs,
      pending,
      coverage,
      state,
      reason,
      hasVec: vecLoaded,
      hasKey: key,
      windows: {
        total: windowTotal,
        indexed: windowIndexed,
        pending: windowPending,
        kinds: windowKinds,
      },
    };
  }

  function buildWarnings() {
    const warnings = [];
    if (!noteHasSessionColumn()) {
      warnings.push(
        'note 表没有 session_id 列（老库还没迁移到 v6），「TA的笔记」只能显示全库笔记，暂时无法按会话过滤。'
        + '其余统计（条数/字数/场景/压缩/撤回）都只算当前会话。',
      );
    } else {
      try {
        const orphan = Number(
          stmt('SELECT COUNT(*) AS c FROM note WHERE deleted_at IS NULL AND session_id IS NULL').get().c ?? 0,
        );
        if (orphan > 0) {
          warnings.push(
            `有 ${orphan} 条 v6 之前写下的遗留笔记没有会话归属（session_id 为空），`
            + '它们不属于任何一个对话，所以不在这个面板里显示 —— 不是丢了。',
          );
        }
      } catch {
        // 查询失败就不提，不影响主统计
      }
    }
    if (!hasEmbeddingKey()) {
      warnings.push(
        `语义搜索未启用（缺 embedding API Key）。时间轴与关键词检索不受影响。`,
      );
    } else if (handle.hasVec !== true) {
      warnings.push('sqlite-vec 未加载，向量检索降级为暴力余弦（结果一致、稍慢）。');
    }
    return warnings;
  }

  return {
    sessionFiles,
    findLogFile,
    loadLog,
    safeLoadLog,
    readSessionConfig,
    sessionAggregate,
    vectorStatus,
    buildWarnings,
    cachedLogs: () => [...logCache.keys()],
  };
}
