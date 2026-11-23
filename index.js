/**
 * dsh-verbatim —— DSH Host 插件入口。
 *
 * 这是插件形态的入口（`package.json` 的 `.`）；库形态在 `./src/index.js`。
 * 两者不冲突：DSH 加载 `.` 拿到 apply 函数，其他代码 import 'dsh-verbatim/lib' 拿到库。
 *
 * 插件做四件事：
 *   1. 打开记忆库（`$DSH_HOME/verbatim/memory.db`）
 *   2. 把 3 个工具注册进每个 Agent 的会话上下文
 *   3. 每次工具调用前，按 mtime 增量同步会话日志
 *      —— 这样"边聊边查得到"，不需要用户手动导入
 *   4. 暴露面板 RPC（`/verbatim-api/panel.<method>`，契约见 PANEL.md §5）
 *
 * 为什么按 agent 注册而不是全局注册：DSH 的工具属于 Agent 的 session 上下文
 * （参考 dsh-comfyui-panel 的做法）。全局 ctx 上注册在这个版本里不生效。
 *
 * ── 面板 RPC 的三条硬约束（ACCEPTANCE.md）──────────────────────────────
 *
 * ① **按会话隔离**（A2 / E1）：`status` / `timeline` / `notes` / `sample` /
 *    `set` / `rebuild` / `flags` 必须带 `sessionId`，缺了直接报错 ——
 *    绝不能像以前的 `/verbatim-api/stats` 那样默认返回全库（A 会话会看到 B 的数字）。
 *
 * ② **降级要明说**（B7）：`vector.state` 区分 ok / degraded / disabled，
 *    并附 `reason` 人话说明。不能假装正常。
 *
 * ③ **重建的安全闸门**（E3）：`panel.rebuild` 只重建派生数据（场景 / 向量），
 *    永远不删 `msg`；任何"清库"意图先过 `assertSafeToReset()`，
 *    只允许系统临时目录 / 项目 `.tmp/`，真实记忆库一律 403。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { openDb, defaultDbPath } from './src/store/db.js';
import { createRepo, createExtras } from './src/store/repo.js';
import { createSessionToolSet } from './src/tools/index.js';
import {
  assertSessionId,
  defaultSessionConfig,
  loadSessionConfig,
  loadSessionExcludeRanges,
  normalizeRanges,
  setSessionExcludeRanges,
  setSessionFlag,
} from './src/config/session-config.js';
import { ConfigError } from './src/config/exclude-range.js';
import { resolveTimeWindow } from './src/tools/time-route.js';
import { importSession } from './src/pipeline.js';
import { gistHeadline } from './src/derive/gist.js';
import { NOTE_MIN_SCORE_DEFAULT, PINNED_NOTE_MAX_DEFAULT, searchRankedNotes } from './src/search/note-rank.js';
import {
  dayKeyInZone,
  exportMessages,
  parseInstant,
  stripBridgeMetadata,
  textBlocksOf,
} from './src/ingest/export.js';
import { listSessionFiles, readSessionFile } from './src/ingest/reader.js';
import { loadGlobalConfig, saveGlobalConfig, globalConfigPath } from './src/config/global-config.js';
import {
  createConfigResolver,
  sanitizeGlobalConfig,
  buildEmbeddingView,
  buildLlmView,
  buildRerankView,
  buildVecExtView,
} from './src/host/config-views.js';
import { createModelProber } from './src/host/probe.js';
import { createDbAdmin } from './src/host/db-admin.js';
import { createRebuildManager } from './src/host/rebuild.js';
import { createSceneOps } from './src/host/scene-ops.js';
import { createSessionLock } from './src/host/session-lock.js';
import { createReranker } from './src/model/rerank.js';
import { dedupeBySpan, createSpanIndex } from './src/search/dedupe.js';
import { SCENE_FALLBACK_ENABLED } from './src/search/scene-fallback.js';

/** 本文件所在目录（项目根） */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 面板 RPC 前缀（client.js 的 fetch 前缀必须一致） */
export const API_PREFIX = '/verbatim-api';

/** 时间上界：比任何真实 at 都大（注意别用位运算，会把数截成 int32） */
const TIME_MAX = Number.MAX_SAFE_INTEGER;

/** 「取该会话全部消息」的上限（库才几千条，够用且不用分页） */
const ALL_ROWS = 5_000_000;

/** 日志导出缓存最多留几个会话（45MB 日志解压后是纯 CPU，重复解太浪费） */
const LOG_CACHE_MAX = 2;

/** 会话日志文件清单的缓存时长（792 个目录的 stat，别每个请求都扫） */
const SESSION_FILE_TTL_MS = 30_000;

/**
 * 面板全部 20 个 RPC（PANEL.md §5，ACCEPTANCE E 组：一个都不能少）。
 * 必须与 createPanelApi() 的 `methods` 一一对应（panel-config.test.js 校验）。
 *
 *   会话面板 16 个：status … restoreNote + search / deletedNotes / setExcludeRanges
 *   重建轮询  1 个：task
 *   设置页    3 个：globalConfig / setGlobalConfig / probeLocal
 */
export const PANEL_METHODS = Object.freeze([
  'status',
  'timeline',
  'sceneDetail',
  'notes',
  'deletedNotes',
  'sample',
  'verify',
  'search',
  'set',
  'setExcludeRanges',
  'rebuild',
  'task',
  'flag',
  'flags',
  'unflag',
  'deleteNote',
  'restoreNote',
  'addNote',
  'globalConfig',
  'setGlobalConfig',
  'probeLocal',
  'dbOverview',
  'dbRows',
  'dbQuery',
  'dbMaintain',
  'recallLog',
  'mergeScene',
  'splitScene',
  'refineOneScene',
  'mediaPreview',
  'setMediaCaption',
  'findDuplicateNotes',
  'mergeNotes',
  'setSceneGist',
  'setMsgExcluded',
  'updateNote',
]);

/** 这套 API 之前的 4 个临时端点 —— 已废弃，明确告知迁移而不是静默 404 */
const LEGACY_PANEL_PATHS = new Set(['/stats', '/timeline', '/notes', '/flags']);

/** 依赖 DSH 的工具注册表与 HTTP 载体 */
export const inject = ['tools', 'webServer'];

/* ══════════════════════════════════════════════════════════════════════
 * 面板 RPC：错误类型与参数工具
 * ══════════════════════════════════════════════════════════════════════ */

/** 带 HTTP 状态码的 RPC 错误：前端能据此区分「参数错 / 目标不存在 / 内部错」 */
export class PanelError extends Error {
  /**
   * @param {string} code 稳定的错误码（前端可判断）
   * @param {string} message 人话说明
   * @param {number} [status] HTTP 状态码
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PanelError';
    this.code = code;
    this.status = status;
  }
}

/** 工具输出的统一声明（DSH 要求每个工具声明 output schema） */
function textOutput() {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    // **必须返回 content 数组**，不是字符串。
    // 之前这里 `return value?.text` 直接返回字符串，DSH 对它调 `.some()`
    // 就报 `content.some is not a function`（实测：工具能调，但一调就错）。
    render(_args, value) {
      return [{ type: 'text', text: String(value?.text ?? '') }];
    },
  };
}

/** 按 sessionId 快速定位会话日志（O(工作区目录数)，命中后按路径复用） */
function findSessionFile(dshHome, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const root = path.join(dshHome, 'sessions');
  if (!fs.existsSync(root)) return null;

  const sid = sessionId.trim();
  const candidates = [sid];
  if (sid.startsWith('session-')) candidates.push(sid.slice('session-'.length));
  else candidates.push(`session-${sid}`);

  for (const id of candidates) {
    const direct = path.join(root, id, 'session.v4.jsonl.zstd');
    if (fs.existsSync(direct)) return direct;
  }

  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    for (const id of candidates) {
      const p = path.join(wsDir, id, 'session.v4.jsonl.zstd');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** 在 $DSH_HOME/sessions 下找最近修改的 session.v4.jsonl.zstd */
function findLatestSession(dshHome) {
  const root = path.join(dshHome, 'sessions');
  if (!fs.existsSync(root)) return null;

  let best = null;
  let bestAt = 0;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'session.v4.jsonl.zstd') {
        try {
          const at = fs.statSync(p).mtimeMs;
          if (at > bestAt) { bestAt = at; best = p; }
        } catch { /* 读不到就跳过 */ }
      }
    }
  };
  try { walk(root, 0); } catch { /* 权限问题当没找到 */ }
  return best;
}

/** 取整参数（缺省给默认值；范围外/非整数直接报错，不静默截断） */
function intParam(value, name, { def, min = -Infinity, max = Infinity } = {}) {
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
function boolParam(value, name) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  throw new PanelError('BAD_ARG', `${name} 必须是 true/false，收到 ${JSON.stringify(value)}`, 400);
}

/** 时间参数：数字（epoch ms）或 `YYYY-MM-DD` / ISO 串；解析不了就报错 */
function instantParam(value, name, def) {
  if (value === undefined || value === null || value === '') return def;
  const at = parseInstant(value);
  if (at === null || !Number.isFinite(at)) {
    throw new PanelError('BAD_ARG', `${name} 看不懂：${JSON.stringify(value)}（支持 epoch 毫秒 / YYYY-MM-DD / ISO）`, 400);
  }
  return at;
}

/** query 串里的数字/布尔还原成真类型（手工 fetch 时不必自己 encode） */
function coerceParams(input) {
  const INT_KEYS = new Set(['msgId', 'sceneId', 'id', 'limit', 'offset']);
  const BOOL_KEYS = new Set(['value', 'reset', 'includeExcluded', 'excluded']);
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    if (INT_KEYS.has(k) && /^-?\d+$/.test(v.trim())) { out[k] = Number(v); continue; }
    if (BOOL_KEYS.has(k) && (v === 'true' || v === 'false')) { out[k] = v === 'true'; continue; }
    out[k] = v;
  }
  return out;
}

/**
 * 读 HTTP 请求体（JSON）。GET/HEAD 没有 body。
 * 返回 null 表示 body 存在但不是合法 JSON —— 调用方要回 400，不能静默当成 {}。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object|null>}
 */
function readRequestBody(req) {
  return new Promise((resolve) => {
    if (!req || req.method === 'GET' || req.method === 'HEAD') return resolve({});
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) return finish(null); // 1MB 足够，防止被灌爆
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return finish({});
      try {
        const parsed = JSON.parse(text);
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish({}));
  });
}

/**
 * 创建面板 RPC 的**业务层**（不依赖 HTTP，便于测试与复用）。
 *
 * @param {{
 *   handle: object, repo?: object, extras?: object,
 *   dbPath?: string, dshHome?: string, dbRoot?: string,
 *   config?: object, logger?: {info?(m:string):void, warn?(m:string):void},
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

  /* ───────────────────────── 会话与日志定位 ───────────────────────── */

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
   *
   * 库里 `msg.session_id` 有两种形态（实测都出现过）：
   *   `session-<uuid>`（日志头 id / 目录名带前缀）
   *   `<uuid>`（有的工作区目录名不带前缀）
   * 所以两种都试，不要只认一种。
   *
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

  /** 日志缓存（按文件路径；只留最近 2 个会话，避免几百 MB 常驻） */
  const logCache = new Map();

  /**
   * 从原始日志重导出某个会话（按 mtime+size 缓存）。
   *
   * 为什么面板要读日志：
   *   - `rewindedMsgs`（已撤回排除 N 条）在库里查不到 —— 撤回是物理删除（D-118），
   *     只能从日志的 rewind 事件重新数；
   *   - `panel.verify` 要拿「日志原文」和「库里的正文」逐字比对（C4/E2）。
   *
   * 返回 null 表示这个会话找不到日志（不是错误：面板照样能显示库里的数据）。
   *
   * @param {string} sessionId
   * @returns {{file: string, raw: Map<number, {speaker: string, at: number, raw: string}>, stats: object}|null}
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

    // 排除区间只影响 excluded 标记，不影响 rewound 计数；配置坏了也不该让面板崩
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

    // verify 要的是「日志原文」：保留清洗前的 text 块，比对时再 stripBridgeMetadata（D-216）
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

  /* ───────────────────────── 配置与开关 ───────────────────────── */

  /** 读该会话的配置（文件不存在 → 默认值，不落盘） */
  function readSessionConfig(sessionId) {
    try {
      return loadSessionConfig(sessionId, { dbRoot });
    } catch (error) {
      throw new PanelError('CONFIG_INVALID', `会话配置读不出来：${error?.message ?? error}`, 500);
    }
  }

  /* ───────────────────────── 会话统计（按会话，不是全库） ───────────────────────── */

  /**
   * 该会话的聚合数字。
   *
   * 全部走 repo（不写 SQL）。`extras.stats.get({ sessionId })` 也能给基础数字，
   * 但面板还要两样它没有的：in_surface=0 的条数/字数（B4 的核心数字）、
   * 按天去重的 dayCount。所以这里把该会话的消息一次取出来自己算
   * （2815 条约 20ms，比多跑几条聚合 SQL 简单，口径也只有一处）。
   *
   * @param {string} sessionId
   */
  function sessionAggregate(sessionId) {
    // includeExcluded=true：被按日期排除的消息也入库了，统计条数时要算进去
    const msgs = repo.msgsByTimeRange(sessionId, 0, TIME_MAX, ALL_ROWS, true);
    let totalChars = 0;
    let compactedMsgs = 0;
    let compactedChars = 0;
    const days = new Set();
    for (const m of msgs) {
      totalChars += m.text.length;
      if (m.inSurface === 0) {
        compactedMsgs += 1;
        compactedChars += m.text.length;
      }
      days.add(dayKeyInZone(m.at));
    }
    const scenes = repo.scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_ROWS);
    return {
      msgs,
      scenes,
      totalMsgs: msgs.length,
      totalChars,
      startAt: msgs.length ? msgs[0].at : null,
      compactedMsgs,
      compactedChars,
      sceneCount: scenes.length,
      dayCount: days.size,
    };
  }

  /* ───────────────────────── 向量状态（B6 / B7） ───────────────────────── */

  const {
    getGlobal,
    invalidateGlobal,
    embCfg,
    hasEmbeddingKey,
    llmCfg,
    hasLlmReady,
    rerankCfg,
  } = createConfigResolver({ config, dshHome, logger, getHostLlm });

  /**
   * 面板索引状态 —— **「索引是什么」这个实体的唯一窗口**（2026-11-18 重构）。
   *
   * A1 审计的核心结论：系统之前没有「索引」这个实体，只有散落在 msg.vec_model /
   * 各向量表 / config.json / 内存 tasks 里的碎片。于是三个问题永远答不出来：
   *   ① 库里用的是什么模型？  ② 现在配的是什么模型？  ③ 两者一致吗 / 混过吗？
   *
   * 现在一次答完：
   *   models          库里**全部**的 (模型, 维度, 条数) —— 不是只报多数派
   *   configured      当前配置的模型（归一化后的 id）
   *   consistent      库里是否只有一种模型
   *   modelMatch      库里模型是否 == 当前配置
   *   state           7 态：disabled / mixed / empty / mismatch / partial / degraded / ok
   *                   （model-mismatch 优先级高于 degraded/ok；降级要明说，不能假装正常）
   *
   * @param {string} sessionId
   * @param {number} totalMsgs 该会话的入库条数（= 索引分母）
   */
  function vectorStatus(sessionId, totalMsgs) {
    // ① 库里**全部**模型分组（之前 `LIMIT 1` 只报多数派，混用时另一组静默消失）
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
      models = [];   // 老库没有 vec_model 列
      indexed = 0;
    }

    // ② 当前配置的模型（归一化后与库里同样的格式）
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

    // ③ 一致性判定
    const consistent = models.length <= 1;                       // 库里没混模型
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
      // **混用**：两种模型的向量空间不可比，混算不报错但结果无意义 —— 必须先重建
      state = 'mixed';
      reason = `库里有 ${models.length} 套向量（${models.map((m) => `${m.model} ${m.count} 条`).join(' / ')}）。`
        + '不同模型的向量不可比，语义搜索现在不可用；重建一次就好（原文不会动）。';
    } else if (indexed === 0) {
      state = 'empty';
      reason = `语义搜索还没建索引（0 / ${totalMsgs} 条）。点 [重建] 建一次就能用；在那之前检索只走关键词和时间轴，不会白跑 embedding。`;
    } else if (modelMatch === false) {
      // **模型换了但没重建**：这之前显示「正常」，实际每次查询都抛 vec:err
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
      // 兼容旧字段（面板和测试都读 model/dim）
      model: top?.model ?? null,
      dim: top?.dim ?? null,
      models,                 // 全部模型分组
      configured,             // 当前配置
      consistent,             // 库里没混模型
      modelMatch,             // 库里 == 当前配置（null = 不知道）
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

  /* ───────────────────────── 空态/限制说明（B7 的诚实原则） ───────────────────────── */

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

  function buildWarnings() {
    const warnings = [];
    if (!noteHasSessionColumn()) {
      warnings.push(
        'note 表没有 session_id 列（老库还没迁移到 v6），「TA的笔记」只能显示全库笔记，暂时无法按会话过滤。'
        + '其余统计（条数/字数/场景/压缩/撤回）都只算当前会话。',
      );
    } else {
      // 遗留笔记（v6 之前写的，没有会话归属）不属于任何对话，面板按会话过滤时看不到。
      // 这个数字要说出来，否则用户会以为"我记的笔记没了"。
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
    let excludedMsgs = 0;
    for (const m of agg.msgs) {
      if (m.excluded === 1) excludedMsgs += 1;
    }
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

    const msgs = repo.msgsByTimeRange(sessionId, from, to, ALL_ROWS, true);
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

    for (const m of msgs) {
      const d = ensure(dayKeyInZone(m.at));
      d.msgCount += 1;
      d.chars += m.text.length;
      if (m.sceneId === null || m.sceneId === undefined) {
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
  async function search(params) {
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

    // （跨句多词关键词检索已移除：与 vec_window 语义召回重叠且易引入噪声）

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
    const { createSearchTool } = await import('./src/tools/memory-search.js');
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
            const { createVectorStore } = await import('./src/search/vector-store.js');
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
        matchedNotes = nr.hits.map((n) => ({
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
  }


  /**
   * `panel.sample({ sessionId })` → { id, at, speaker, text, scene }
   *
   * 「抽一条」用于核对（C4）。该会话没有任何消息时返回 null（面板显示空态）。
   */
  function sample(params) {
    const sessionId = requireSession('sample', params);
    const msgs = repo.msgsByTimeRange(sessionId, 0, TIME_MAX, ALL_ROWS, true);
    if (msgs.length === 0) return null;

    // 均匀随机：每次「抽一条」都可能是不同的，人才能靠抽查建立信任
    const m = msgs[Math.floor(Math.random() * msgs.length)];
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
        cachedLogs: [...logCache.keys()],
        tasks: recentTasks(),
        dbRoot,
        dbPath,
      };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 面板 RPC：HTTP 适配层
 * ══════════════════════════════════════════════════════════════════════ */

/** 统一的 JSON 响应（永远带 no-store：面板看的是实时状态） */
function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 不依赖会话日志的面板 RPC：跳过同步，保证设置页/探测/轮询/写开关/异步任务发起/库管理即时响应 */
const SKIP_SYNC_METHODS = new Set([
  'globalConfig',
  'setGlobalConfig',
  'probeLocal',
  'task',
  'rebuild',
  'set',
  'setExcludeRanges',
  'addNote',
  'dbOverview',
  'dbRows',
  'dbQuery',
  'dbMaintain',
  'recallLog',
  'mergeScene',
  'splitScene',
  'refineOneScene',
  'mediaPreview',
  'setMediaCaption',
  'findDuplicateNotes',
  'mergeNotes',
  'setSceneGist',
  'setMsgExcluded',
  'updateNote',
]);

/**
 * 把 createPanelApi() 适配成 DSH webServer 的 handler。
 *
 * 路径约定：`${API_PREFIX}/panel.<method>`（PANEL.md §5）。
 * 参数同时接受 query（GET）和 JSON body（POST）。
 *
 * @param {object} api createPanelApi() 的返回值
 * @param {{beforeRequest?: (ctx: {method: string, sessionId: string|null}) => Promise<void>|void}} [opts]
 */
export function createPanelHandler(api, opts = {}) {
  const beforeRequest = typeof opts.beforeRequest === 'function' ? opts.beforeRequest : null;
  const afterCall = typeof opts.afterCall === 'function' ? opts.afterCall : null;

  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendJson(res, { ok: false, code: 'BAD_URL', error: '请求地址解析不了' }, 400);
    }

    const rawPath = url.pathname;
    const p = rawPath.startsWith(API_PREFIX) ? rawPath.slice(API_PREFIX.length) || '/' : rawPath;

    if (!p.startsWith('/panel.')) {
      const legacy = LEGACY_PANEL_PATHS.has(p);
      return sendJson(
        res,
        {
          ok: false,
          code: legacy ? 'LEGACY_ENDPOINT' : 'NOT_FOUND',
          error: legacy
            ? `旧端点 ${p} 已废弃：它不按会话过滤，会把别的对话的数据混进来（A2 的 bug）。`
              + `请改用 ${API_PREFIX}/panel.status 等 RPC（见 PANEL.md §5）。`
            : `没有这个端点：${p}。RPC 路径形如 ${API_PREFIX}/panel.status`,
          methods: [...PANEL_METHODS],
        },
        legacy ? 410 : 404,
      );
    }

    const method = p.slice('/panel.'.length);
    const body = await readRequestBody(req);
    if (body === null) {
      return sendJson(res, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON 对象' }, 400);
    }

    const query = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const params = coerceParams({ ...query, ...body });

    // 先把目标会话数据同步到最新，否则面板看到的是旧数字（失败就用现有数据）
    if (beforeRequest && !SKIP_SYNC_METHODS.has(method)) {
      const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId.trim()
        : null;
      try {
        await beforeRequest({ method, sessionId });
      } catch { /* 同步失败不影响读取 */ }
    }

    try {
      const result = await api.call(method, params);
      if (afterCall) {
        try { await afterCall({ method, params, result }); } catch { /* 后置钩子失败不影响响应 */ }
      }
      return sendJson(res, result, 200);
    } catch (error) {
      const status = error instanceof PanelError ? error.status : 500;
      return sendJson(
        res,
        {
          ok: false,
          method: `panel.${method}`,
          code: error?.code ?? 'INTERNAL_ERROR',
          error: error?.message ?? String(error),
        },
        status,
      );
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 插件入口
 * ══════════════════════════════════════════════════════════════════════ */

export function apply(ctx, config = {}) {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const dbPath = config.dbPath ?? defaultDbPath(dshHome);

  // 运行时配置根 = 库所在目录（D-175：`$DSH_HOME/verbatim/sessions/<id>.json`）。
  // 注意不是 dshHome：`<dshHome>/verbatim/sessions` 才是对的，传错就永远读不到会话开关。
  const dbRoot = dbPath === ':memory:'
    ? path.join(dshHome, 'verbatim')
    : path.dirname(path.resolve(dbPath));

  let handle;
  try {
    handle = openDb({ dbPath, logger: { warn: (m) => ctx.logger?.warn?.(`[verbatim] ${m}`) } });
  } catch (e) {
    // 库打不开是致命问题，但不能拖垮整个 Harness
    ctx.logger?.error?.(`[verbatim] 记忆库打不开：${e.message}`);
    return () => {};
  }

  // 诊断状态文件：DSH 主进程日志不好取，把关键状态写到库目录旁边，方便外部确认
  // （这不是功能，只是让我能验证"插件到底加载了没、给哪个会话注册了工具"）
  const statusFile = path.join(dbPath === ':memory:' ? dbRoot : path.dirname(dbPath), 'plugin-status.json');
  const writeStatus = (patch) => {
    try {
      const prev = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
      fs.writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2));
    } catch { /* 写不进去就算了，不能因为诊断影响插件 */ }
  };
  const instanceId = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  writeStatus({ loaded: true, instanceId, dbPath, hasVec: handle.hasVec === true });

  const repo = createRepo(handle);
  const extras = createExtras(handle);
  ctx.logger?.info?.(`[verbatim] 记忆库已打开：${dbPath}（${handle.hasVec ? '向量可用' : '降级为暴力余弦'}）`);

  /* ───────── 增量同步与轻量自动补索引 ───────── */

  /** 按会话日志文件独立记录 mtime 与并发同步 Promise（多会话切换互不覆盖） */
  const lastMtimes = new Map();
  const syncingFiles = new Map();
  let disposed = false;
  let autoIndexing = null;

  /**
   * 后台轻量增量补索引（仅当全局配置 index.autoIndex === true 时启用）。
   * 不阻塞工具返回和面板读取；单次最多补 64 条，出错或模型不一致只告警，不破坏已有向量。
   */
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
        const r = await indexer.indexPending({ limit: 64 });
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

  /** 开关被改写（如打开 record）后失效该会话日志的 mtime 缓存，确保下次读取立即重同步 */
  const invalidateFresh = (sessionId) => {
    if (!sessionId) {
      lastMtimes.clear();
      return;
    }
    const file = config.sessionFile ?? findSessionFile(dshHome, sessionId);
    if (file) lastMtimes.delete(file);
  };

  /**
   * 增量同步指定会话（或最新会话）的日志到记忆库。
   * @param {string|{sessionId?: string|null}|null} [target]
   * @param {{skipAutoIndex?: boolean}} [syncOpts]
   */
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
        const r = await hostSessionLock.withLock(lockKey, () => importSession(file, { handle, dbRoot }));
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

  /* ───────── 工具定义 ───────── */

  // 插件 config 里如果显式给了 `session`（测试/排障用手动覆盖），就用它当所有会话的配置；
  // 平时不传 —— 开关必须按会话读 `$DSH_HOME/verbatim/sessions/<id>.json`（A3）。
  const explicitToolConfig = config.session && Object.keys(config.session).length
    ? { ...defaultSessionConfig(), ...config.session }
    : undefined;

  const hostSessionLock = createSessionLock();
  const recallLogEntries = [];
  const pushRecallEntry = (entry) => {
    recallLogEntries.unshift(entry);
    if (recallLogEntries.length > 50) recallLogEntries.length = 50;
  };

  let autoRefining = null;
  const dailyRefineBudget = { day: '', used: 0 };
  const scheduleAutoRefine = (sessionId) => {
    if (disposed || autoRefining || !sessionId) return;
    let g;
    try { g = loadGlobalConfig({ dshHome }).config; } catch { return; }
    const llm = g.llm ?? {};
    if (llm.enabled !== true || llm.autoRefine !== true || !llm.model) return;
    const today = dayKeyInZone(Date.now());
    if (dailyRefineBudget.day !== today) {
      dailyRefineBudget.day = today;
      dailyRefineBudget.used = 0;
    }
    const limit = Number.isFinite(Number(llm.dailyLimit)) ? Math.max(0, Math.trunc(Number(llm.dailyLimit))) : 50;
    if (limit <= 0 || dailyRefineBudget.used >= limit) return;

    let hostLlm = null;
    try { hostLlm = (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm) ?? null; } catch { return; }
    if (!hostLlm) return;

    autoRefining = (async () => {
      try {
        const unrefined = repo.scenesByTimeRange(sessionId, 0, Number.MAX_SAFE_INTEGER, 5000)
          .filter((s) => s.gistSource !== 'llm');
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
            const sc = batch[cursor++];
            try {
              const msgs = repo.msgsByScene(sc.id, false);
              if (msgs.length === 0) continue;
              const gr = await generateGist({ llm: llmAdapter, msgs, startAt: sc.startAt, endAt: sc.endAt });
              if (gr.ok && gr.gist) {
                repo.setSceneGist(sc.id, gr.gist, { source: 'llm' });
                dailyRefineBudget.used += 1;
                done += 1;
              }
            } catch { /* 单场失败静默跳过 */ }
          }
        };
        await Promise.all([worker(), worker()]);
        if (!disposed && done > 0) {
          ctx.logger?.info?.(`[verbatim] 后台空闲自动补齐 LLM 摘要 ${done} 场（今日已用 ${dailyRefineBudget.used}/${limit}）`);
        }
      } catch (e) {
        if (!disposed) ctx.logger?.warn?.(`[verbatim] 后台自动补齐摘要跳过：${e?.message ?? e}`);
      } finally {
        autoRefining = null;
      }
    })();
  };

  /** 把库里的 handler 包成 DSH 工具定义（绑定所属 sessionId 以精确同步该会话） */
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
      // 工具实例本身已经闭包了 sessionId（createSessionToolSet），这里传 handle 不会丢会话
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

  /* ───────── 注册：给每个 Agent 的 session 上下文装一份 ───────── */

  const cleanups = new Map(); // sessionId -> cleanup[]
  const liveAgents = new Map(); // sessionId -> agent

  function registerFor(agent) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string') return;
    liveAgents.set(sessionId, agent);
    if (cleanups.has(sessionId)) return;

    const sessionCtx = agent.ctx;
    if (!sessionCtx?.tools?.register) return;

    // **工具必须按会话建**（A1）：createSessionToolSet 把 sessionId 闭包进每个 handler，
    // TA在 A 会话里查不到 B 会话的 msg / scene / note；开关也按
    // `$DSH_HOME/verbatim/sessions/<id>.json` 读（A3），A 关掉不影响 B。
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
      // 注销时一并收尾：set.close() 是引用计数，不会关掉别的会话共用的那条连接
      undos.push(() => set.close());
      cleanups.set(sessionId, undos);
      writeStatus({ registeredFor: [...cleanups.keys()], toolCount: dshTools.length });
      ctx.logger?.info?.(
        `[verbatim] 已为会话 ${sessionId} 注册 ${dshTools.length} 个记忆工具`
        + (dshTools.length === 0 ? '（配置里两个开关都关着，不注册是对的）' : ''),
      );
    } catch (e) {
      // 注册失败要回滚已经注册的那几个，不留半截状态
      for (const undo of undos) {
        try { undo?.(); } catch { /* 回滚失败也没别的办法 */ }
      }
      try { set.close(); } catch { /* 同上 */ }
      ctx.logger?.warn?.(`[verbatim] 注册工具失败：${e.message}`);
    }
  }

  function unregisterFor(sessionId) {
    const undos = cleanups.get(sessionId);
    if (!undos) return;
    for (const undo of undos) {
      try { undo?.(); } catch { /* 已经没了就算了 */ }
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

  // 已经在跑的 Agent（插件热装/重载时会走到这里）
  try {
    const agents = ctx.get('agents');
    // 诊断：agents 服务到底暴露了什么（一次性，用来确定怎么列出当前 Agent）
    const proto = agents ? Object.getPrototypeOf(agents) : null;
    const keys = !agents ? '(服务不存在)' : proto ? Object.getOwnPropertyNames(proto).join(',') : '(无原型)';
    ctx.logger?.info?.(`[verbatim] agents 服务原型方法: ${keys}`);
    const list = typeof agents?.list === 'function' ? agents.list()
      : typeof agents?.all === 'function' ? agents.all()
      : typeof agents?.values === 'function' ? [...agents.values()]
      : [];
    ctx.logger?.info?.(`[verbatim] 现有 Agent 数量: ${Array.isArray(list) ? list.length : '(不是数组)'}`);
    for (const agent of list) registerFor(agent);

    // ── 诊断：agents 服务到底覆盖哪些会话 ──
    // 实测踩到：Web GUI 里正在跑的这个 agent 不在 list() 里，
    // 结果是"插件装好了、库在同步、但TA在当前会话看不到工具"。
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

    // **补注册当前会话**（实测踩到：list() 里往往没有"正在跑的这一轮"的 Agent）。
    // 办法是从最近修改的会话日志反推 sessionId，再 agents.get(id) 拿 Agent。
    // 不这么做的话：插件装好了、库里数据也在同步，但TA在这个会话里根本看不到工具。
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

  /* ───────── 面板 RPC（PANEL.md §5，共 17 个方法） ───────── */

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
          // 打开 record 时清除该会话 mtime 缓存，下一次刷新面板/调工具立即补同步历史日志
          if (method === 'set' && params?.key === 'record' && params?.value === true) {
            invalidateFresh(params.sessionId);
          }
          // 切换 tools 或 record 时热更新当前活跃 Agent 的工具注入（memory_remember 依赖两者）
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

  /* ───────── 清理 ───────── */

  return () => {
    disposed = true;
    try { if (typeof unsubCreated === 'function') unsubCreated(); } catch { /* ignore */ }
    try { if (typeof unsubDisposed === 'function') unsubDisposed(); } catch { /* ignore */ }
    for (const sessionId of [...cleanups.keys()]) unregisterFor(sessionId);
    try { handle.close(); } catch { /* 关不上也不影响退出 */ }
  };
}
