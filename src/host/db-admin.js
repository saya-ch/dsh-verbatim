// @ts-check
/**
 * 数据库管理台 RPC（dbOverview / dbRows / dbQuery / dbMaintain）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, constants as sqliteConstants } from 'node:sqlite';
import { loadSessionConfig, sessionConfigPath, sessionsDir } from '../config/session-config.js';
import { deleteVecRows, withTx } from '../store/repo.js';

const TIME_MAX = Number.MAX_SAFE_INTEGER;
const ALL_ROWS = 5_000_000;

function statSizeSafe(filePath) {
  if (!filePath || filePath === ':memory:') return 0;
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

export function createDbAdmin({
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
}) {
  function dbOverview() {
    const isMemory = dbPath === ':memory:';
    const dbBytes = statSizeSafe(dbPath);
    const walBytes = isMemory ? 0 : statSizeSafe(`${dbPath}-wal`);
    let schemaVersion = 0;
    try { schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0); } catch { schemaVersion = 0; }

    const sessionMap = new Map();
    const ensureEntry = (sid) => {
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, {
          sessionId: sid,
          totalMsgs: 0,
          totalChars: 0,
          compactedMsgs: 0,
          excludedMsgs: 0,
          indexedMsgs: 0,
          pendingMsgs: 0,
          firstAt: null,
          lastAt: null,
          sceneCount: 0,
          noteCount: 0,
          deletedNoteCount: 0,
          flagCount: 0,
          chunkCount: 0,
          mediaCount: 0,
          windowCount: 0,
          windowKinds: { window: 0, exchange: 0, thread: 0 },
          models: [],
          enabled: { record: false, tools: false },
        });
      }
      return sessionMap.get(sid);
    };

    const msgRows = stmt(
      `SELECT session_id AS sid,
              COUNT(*) AS totalMsgs,
              COALESCE(SUM(LENGTH(text)), 0) AS totalChars,
              SUM(CASE WHEN in_surface = 0 THEN 1 ELSE 0 END) AS compactedMsgs,
              SUM(CASE WHEN excluded = 1 THEN 1 ELSE 0 END) AS excludedMsgs,
              SUM(CASE WHEN vec_model IS NOT NULL THEN 1 ELSE 0 END) AS indexedMsgs,
              SUM(CASE WHEN excluded = 0 AND vec_model IS NULL THEN 1 ELSE 0 END) AS pendingMsgs,
              MIN(at) AS firstAt,
              MAX(at) AS lastAt
       FROM msg
       GROUP BY session_id`,
    ).all();
    for (const r of msgRows) {
      const e = ensureEntry(String(r.sid));
      e.totalMsgs = Number(r.totalMsgs ?? 0);
      e.totalChars = Number(r.totalChars ?? 0);
      e.compactedMsgs = Number(r.compactedMsgs ?? 0);
      e.excludedMsgs = Number(r.excludedMsgs ?? 0);
      e.indexedMsgs = Number(r.indexedMsgs ?? 0);
      e.pendingMsgs = Number(r.pendingMsgs ?? 0);
      e.firstAt = r.firstAt === null || r.firstAt === undefined ? null : Number(r.firstAt);
      e.lastAt = r.lastAt === null || r.lastAt === undefined ? null : Number(r.lastAt);
    }

    try {
      const sceneRows = stmt(
        `SELECT session_id AS sid, COUNT(*) AS n,
                SUM(CASE WHEN gist_source = 'llm' THEN 1 ELSE 0 END) AS llmN
         FROM scene GROUP BY session_id`,
      ).all();
      for (const r of sceneRows) {
        const e = ensureEntry(String(r.sid));
        e.sceneCount = Number(r.n ?? 0);
        e.llmGistScenes = Number(r.llmN ?? 0);
      }
    } catch {
      const sceneRows = stmt('SELECT session_id AS sid, COUNT(*) AS n FROM scene GROUP BY session_id').all();
      for (const r of sceneRows) {
        ensureEntry(String(r.sid)).sceneCount = Number(r.n ?? 0);
      }
    }

    let orphanNotes = 0;
    if (noteHasSessionColumn()) {
      const noteRows = stmt(
        `SELECT session_id AS sid,
                SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live,
                SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
         FROM note
         GROUP BY session_id`,
      ).all();
      for (const r of noteRows) {
        if (!r.sid) {
          orphanNotes += Number(r.live ?? 0);
          continue;
        }
        const e = ensureEntry(String(r.sid));
        e.noteCount = Number(r.live ?? 0);
        e.deletedNoteCount = Number(r.deleted ?? 0);
      }
    }

    try {
      const flagRows = stmt(
        `SELECT m.session_id AS sid, COUNT(*) AS n
         FROM flag f JOIN msg m ON m.id = f.msg_id
         GROUP BY m.session_id`,
      ).all();
      for (const r of flagRows) {
        ensureEntry(String(r.sid)).flagCount = Number(r.n ?? 0);
      }
    } catch { /* 老库可能无 flag 表 */ }

    try {
      const chunkRows = stmt(
        `SELECT m.session_id AS sid, COUNT(*) AS n
         FROM chunk c JOIN msg m ON m.id = c.msg_id
         GROUP BY m.session_id`,
      ).all();
      for (const r of chunkRows) {
        ensureEntry(String(r.sid)).chunkCount = Number(r.n ?? 0);
      }
    } catch { /* 忽略 */ }

    try {
      const mediaRows = stmt(
        `SELECT m.session_id AS sid, COUNT(*) AS n
         FROM media md JOIN msg m ON m.id = md.msg_id
         GROUP BY m.session_id`,
      ).all();
      for (const r of mediaRows) {
        ensureEntry(String(r.sid)).mediaCount = Number(r.n ?? 0);
      }
    } catch { /* 老库可能无 media 表 */ }

    try {
      const winRows = stmt(
        "SELECT session_id AS sid, COALESCE(kind, 'window') AS kind, COUNT(*) AS n FROM window GROUP BY session_id, COALESCE(kind, 'window')",
      ).all();
      for (const r of winRows) {
        const entry = ensureEntry(String(r.sid));
        const n = Number(r.n ?? 0);
        const k = r.kind === 'exchange' || r.kind === 'thread' ? r.kind : 'window';
        entry.windowCount += n;
        entry.windowKinds[k] += n;
      }
    } catch { /* 老库可能无 window 表 */ }

    try {
      const modelRows = stmt(
        `SELECT session_id AS sid, vec_model AS model, vec_dim AS dim, COUNT(*) AS n
         FROM msg WHERE vec_model IS NOT NULL
         GROUP BY session_id, vec_model, vec_dim
         ORDER BY n DESC`,
      ).all();
      for (const r of modelRows) {
        ensureEntry(String(r.sid)).models.push({
          model: String(r.model),
          dim: r.dim === null || r.dim === undefined ? null : Number(r.dim),
          count: Number(r.n ?? 0),
        });
      }
    } catch { /* 忽略 */ }

    try {
      const sdir = sessionsDir({ dbRoot });
      if (fs.existsSync(sdir)) {
        for (const name of fs.readdirSync(sdir)) {
          if (!name.endsWith('.json')) continue;
          const sid = name.slice(0, -5);
          if (sid) ensureEntry(sid);
        }
      }
    } catch { /* 忽略目录扫描异常 */ }

    for (const entry of sessionMap.values()) {
      try {
        const cfg = loadSessionConfig(entry.sessionId, { dbRoot });
        entry.enabled = { record: cfg.record === true, tools: cfg.tools === true };
      } catch {
        entry.enabled = { record: false, tools: false };
      }
      entry.tables = {
        msg: entry.totalMsgs,
        scene: entry.sceneCount,
        window: entry.windowCount,
        note: entry.noteCount + entry.deletedNoteCount,
        flag: entry.flagCount,
        chunk: entry.chunkCount,
        media: entry.mediaCount,
      };
    }

    const sessions = [...sessionMap.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));

    let globalModels = [];
    try {
      globalModels = stmt(
        `SELECT vec_model AS model, vec_dim AS dim, COUNT(*) AS n
         FROM msg WHERE vec_model IS NOT NULL
         GROUP BY vec_model, vec_dim
         ORDER BY n DESC`,
      ).all().map((r) => ({
        model: String(r.model),
        dim: r.dim === null || r.dim === undefined ? null : Number(r.dim),
        count: Number(r.n ?? 0),
      }));
    } catch { globalModels = []; }

    let totalChunks = 0;
    try { totalChunks = Number(stmt('SELECT COUNT(*) AS c FROM chunk').get()?.c ?? 0); } catch { totalChunks = 0; }
    let totalFlags = 0;
    try { totalFlags = Number(stmt('SELECT COUNT(*) AS c FROM flag').get()?.c ?? 0); } catch { totalFlags = 0; }
    let totalNotes = 0;
    let totalDeletedNotes = 0;
    try {
      const nr = stmt(
        `SELECT SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live,
                SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
         FROM note`,
      ).get();
      totalNotes = Number(nr?.live ?? 0);
      totalDeletedNotes = Number(nr?.deleted ?? 0);
    } catch { /* 忽略 */ }

    const totals = {
      sessions: sessions.length,
      msgs: sessions.reduce((s, x) => s + x.totalMsgs, 0),
      chars: sessions.reduce((s, x) => s + x.totalChars, 0),
      compactedMsgs: sessions.reduce((s, x) => s + x.compactedMsgs, 0),
      excludedMsgs: sessions.reduce((s, x) => s + x.excludedMsgs, 0),
      indexedMsgs: sessions.reduce((s, x) => s + x.indexedMsgs, 0),
      pendingMsgs: sessions.reduce((s, x) => s + x.pendingMsgs, 0),
      scenes: sessions.reduce((s, x) => s + x.sceneCount, 0),
      windows: sessions.reduce((s, x) => s + (x.windowCount ?? 0), 0),
      windowKinds: {
        window: sessions.reduce((s, x) => s + (x.windowKinds?.window ?? 0), 0),
        exchange: sessions.reduce((s, x) => s + (x.windowKinds?.exchange ?? 0), 0),
        thread: sessions.reduce((s, x) => s + (x.windowKinds?.thread ?? 0), 0),
      },
      notes: totalNotes,
      deletedNotes: totalDeletedNotes,
      orphanNotes,
      flags: totalFlags,
      chunks: totalChunks,
    };

    const health = [];
    if (globalModels.length > 1) {
      health.push({ kind: 'warn', text: `库内混存 ${globalModels.length} 套向量模型，建议执行一次全库重建` });
    }
    if (totals.pendingMsgs > 0) {
      health.push({ kind: 'warn', text: `全库共有 ${totals.pendingMsgs} 条消息尚未建向量索引` });
    }
    if (orphanNotes > 0) {
      health.push({ kind: 'warn', text: `存在 ${orphanNotes} 条无会话归属（session_id 为空）的遗留笔记` });
    }
    if (totalDeletedNotes > 0) {
      health.push({ kind: 'info', text: `笔记回收站内有 ${totalDeletedNotes} 条软删记录` });
    }
    if (handle.hasVec !== true) {
      health.push({ kind: 'warn', text: 'sqlite-vec 未加载，向量检索当前走暴力余弦降级路径' });
    }
    if (health.length === 0) {
      health.push({ kind: 'ok', text: '库结构与向量索引状态正常' });
    }

    return {
      dbPath,
      isMemory,
      dbBytes,
      walBytes,
      schemaVersion,
      hasVec: handle.hasVec === true,
      totals,
      models: globalModels,
      health,
      sessions,
      tables: {
        msg: totals.msgs,
        scene: totals.scenes,
        window: extras?.window?.count ? extras.window.count() : 0,
        note: totalNotes + totalDeletedNotes,
        flag: totalFlags,
        chunk: totalChunks,
        media: extras?.media?.count ? extras.media.count() : 0,
      },
    };
  }

  function dbRows(params) {
    const allowed = ['msg', 'scene', 'window', 'note', 'flag', 'chunk', 'media'];
    const table = String(params.table ?? 'msg');
    if (!allowed.includes(table)) {
      throw new PanelError('BAD_TABLE', `不支持的表：${table}。可用：${allowed.join(', ')}`, 400);
    }
    const sid = optionalSession('dbRows', params);
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const limit = intParam(params.limit, 'limit', { def: 20, min: 1, max: 100 });
    const offset = intParam(params.offset, 'offset', { def: 0, min: 0, max: 1_000_000 });
    const like = query ? `%${query}%` : null;

    const kindFilter = typeof params.kind === 'string' ? params.kind.trim() : '';
    const vecFilter = typeof params.vec === 'string' ? params.vec.trim() : '';

    const where = [];
    const args = [];
    let countSql;
    let dataSql;
    let columns;
    let kindCounts = null;

    if (table === 'msg') {
      if (sid) { where.push('session_id = ?'); args.push(sid); }
      if (like) { where.push('text LIKE ?'); args.push(like); }
      if (vecFilter === 'yes') where.push('vec_model IS NOT NULL');
      else if (vecFilter === 'no') where.push('vec_model IS NULL');
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      countSql = `SELECT COUNT(*) AS c FROM msg ${w}`;
      dataSql = `SELECT id, session_id, seq, at, speaker, text, in_surface, excluded, scene_id, vec_model, vec_dim
                 FROM msg ${w} ORDER BY at DESC, seq DESC LIMIT ? OFFSET ?`;
      columns = ['id', 'session_id', 'seq', 'at', 'speaker', 'text', 'in_surface', 'excluded', 'scene_id', 'vec_model', 'vec_dim'];
    } else if (table === 'scene') {
      if (sid) { where.push('session_id = ?'); args.push(sid); }
      if (like) { where.push('gist LIKE ?'); args.push(like); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      countSql = `SELECT COUNT(*) AS c FROM scene ${w}`;
      dataSql = `SELECT id, session_id, start_at, end_at, msg_count, has_out_of_surface, excluded_count, gist, created_at
                 FROM scene ${w} ORDER BY start_at DESC, id DESC LIMIT ? OFFSET ?`;
      columns = ['id', 'session_id', 'start_at', 'end_at', 'msg_count', 'has_out_of_surface', 'excluded_count', 'gist', 'created_at'];
    } else if (table === 'window') {
      const kcWhere = sid ? 'WHERE session_id = ?' : '';
      const kcArgs = sid ? [sid] : [];
      try {
        const kcRows = db.prepare(`SELECT COALESCE(kind, 'window') AS k, COUNT(*) AS c FROM window ${kcWhere} GROUP BY k`).all(...kcArgs);
        kindCounts = { window: 0, exchange: 0, thread: 0 };
        for (const r of kcRows) {
          if (r.k === 'thread' || r.k === 'exchange' || r.k === 'window') kindCounts[r.k] = Number(r.c ?? 0);
        }
      } catch {
        kindCounts = null;
      }
      if (sid) { where.push('session_id = ?'); args.push(sid); }
      if (like) { where.push('text LIKE ?'); args.push(like); }
      if (kindFilter && ['window', 'exchange', 'thread'].includes(kindFilter)) {
        where.push("COALESCE(kind, 'window') = ?");
        args.push(kindFilter);
      }
      if (vecFilter === 'yes') where.push('vec_model IS NOT NULL');
      else if (vecFilter === 'no') where.push('vec_model IS NULL');
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      countSql = `SELECT COUNT(*) AS c FROM window ${w}`;
      dataSql = `SELECT id, session_id, scene_id, idx, COALESCE(kind, 'window') AS kind, start_msg_id, end_msg_id, start_at, end_at, msg_count, text, vec_model, vec_dim
                 FROM window ${w} ORDER BY start_at DESC, id DESC LIMIT ? OFFSET ?`;
      columns = ['id', 'session_id', 'scene_id', 'idx', 'kind', 'start_msg_id', 'end_msg_id', 'start_at', 'end_at', 'msg_count', 'text', 'vec_model', 'vec_dim'];
    } else if (table === 'note') {
      const hasSid = noteHasSessionColumn();
      if (sid && hasSid) { where.push('session_id = ?'); args.push(sid); }
      if (like) { where.push('content LIKE ?'); args.push(like); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      countSql = `SELECT COUNT(*) AS c FROM note ${w}`;
      dataSql = hasSid
        ? `SELECT id, session_id, content, about, at, deleted_at
           FROM note ${w} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`
        : `SELECT id, NULL AS session_id, content, about, at, deleted_at
           FROM note ${w} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`;
      columns = ['id', 'session_id', 'content', 'about', 'at', 'deleted_at'];
    } else if (table === 'flag') {
      if (sid) { where.push('m.session_id = ?'); args.push(sid); }
      if (like) { where.push('(f.reason LIKE ? OR m.text LIKE ?)'); args.push(like, like); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      countSql = `SELECT COUNT(*) AS c FROM flag f LEFT JOIN msg m ON m.id = f.msg_id ${w}`;
      dataSql = `SELECT f.id, f.msg_id, m.session_id, m.speaker, f.at, m.text, f.reason, f.resolved_at
                 FROM flag f LEFT JOIN msg m ON m.id = f.msg_id ${w}
                 ORDER BY f.at DESC, f.id DESC LIMIT ? OFFSET ?`;
      columns = ['id', 'msg_id', 'session_id', 'speaker', 'at', 'text', 'reason', 'resolved_at'];
    } else if (table === 'chunk') {
      if (sid) { where.push('m.session_id = ?'); args.push(sid); }
      if (like) { where.push('m.text LIKE ?'); args.push(like); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      countSql = `SELECT COUNT(*) AS c FROM chunk c LEFT JOIN msg m ON m.id = c.msg_id ${w}`;
      dataSql = `SELECT c.id, c.msg_id, m.session_id, c.idx, c.start_char, c.end_char,
                        substr(m.text, c.start_char + 1, MIN(MAX(c.end_char - c.start_char, 0), 200)) AS snippet
                 FROM chunk c LEFT JOIN msg m ON m.id = c.msg_id ${w}
                 ORDER BY c.id DESC LIMIT ? OFFSET ?`;
      columns = ['id', 'msg_id', 'session_id', 'idx', 'start_char', 'end_char', 'snippet'];
    } else {
      if (sid) { where.push('m.session_id = ?'); args.push(sid); }
      if (like) { where.push('(md.path LIKE ? OR md.caption LIKE ? OR m.text LIKE ?)'); args.push(like, like, like); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      countSql = `SELECT COUNT(*) AS c FROM media md LEFT JOIN msg m ON m.id = md.msg_id ${w}`;
      dataSql = `SELECT md.id, md.msg_id, m.session_id, m.scene_id, m.at, md.path, md.sha256, md.width, md.height, md.caption, md.created_at
                 FROM media md LEFT JOIN msg m ON m.id = md.msg_id ${w}
                 ORDER BY md.id DESC LIMIT ? OFFSET ?`;
      columns = ['id', 'msg_id', 'session_id', 'scene_id', 'at', 'path', 'sha256', 'width', 'height', 'caption', 'created_at'];
    }

    const total = Number(db.prepare(countSql).get(...args)?.c ?? 0);
    const rows = db.prepare(dataSql).all(...args, limit, offset).map((r) => ({ ...r }));
    return {
      table,
      sessionId: sid,
      query,
      total,
      limit,
      offset,
      columns,
      rows,
      ...(kindCounts ? { kindCounts } : {}),
    };
  }

  function dbQuery(params) {
    const raw = typeof params.sql === 'string' ? params.sql.trim() : '';
    if (!raw) throw new PanelError('BAD_SQL', '请输入 SQL 查询语句', 400);
    const sql = raw.replace(/;\s*$/, '');
    if (!sql) throw new PanelError('BAD_SQL', '请输入 SQL 查询语句', 400);

    const stripped = sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/"(?:""|[^"])*"/g, '""')
      .replace(/`(?:``|[^`])*`/g, '``')
      .replace(/\[[^\]]*\]/g, '[]')
      .replace(/'(?:''|[^'])*'/g, "''");

    if (stripped.includes(';')) {
      throw new PanelError('READONLY_SQL', '只允许执行单条只读语句（禁止多语句）', 400);
    }
    if (!/^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(stripped)) {
      throw new PanelError('READONLY_SQL', '只允许只读查询（SELECT / PRAGMA / EXPLAIN / WITH）', 400);
    }
    const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
    if (forbidden.test(stripped)) {
      throw new PanelError('READONLY_SQL', '检测到写入或结构变更关键字，已拦截（仅支持只读查询）', 400);
    }
    if (/^\s*PRAGMA\b/i.test(stripped)) {
      const readonlyPragma = /^\s*PRAGMA\s+(?:[a-z_]+\.)?(?:table_info|table_xinfo|index_list|index_info|foreign_key_list|table_list|database_list)\s*\([^)]*\)\s*$|^\s*PRAGMA\s+(?:[a-z_]+\.)?[a-z_]+\s*$/i;
      if (!readonlyPragma.test(stripped)) {
        throw new PanelError('READONLY_SQL', '禁止修改 PRAGMA 设置（仅允许只读 PRAGMA 查询）', 400);
      }
    }

    const limit = intParam(params.limit, 'limit', { def: 50, min: 1, max: 200 });
    const t0 = Date.now();
    const collected = [];
    let truncated = false;

    const readonlyPragmaAllowed = new Set([
      'table_info', 'table_xinfo', 'index_list', 'index_info',
      'foreign_key_list', 'table_list', 'database_list',
    ]);
    const installReadonlyAuthorizer = (conn) => {
      if (typeof conn.setAuthorizer !== 'function' || !sqliteConstants) return false;
      const {
        SQLITE_OK,
        SQLITE_DENY,
        SQLITE_SELECT,
        SQLITE_READ,
        SQLITE_FUNCTION,
        SQLITE_PRAGMA,
      } = sqliteConstants;
      conn.setAuthorizer((actionCode, arg1, arg2) => {
        if (actionCode === SQLITE_SELECT || actionCode === SQLITE_READ || actionCode === SQLITE_FUNCTION) {
          return SQLITE_OK;
        }
        if (actionCode === SQLITE_PRAGMA) {
          // 仅放行只读 PRAGMA：不带赋值参数，或白名单自省函数
          const name = typeof arg1 === 'string' ? arg1.toLowerCase() : '';
          if (arg2 === null || arg2 === undefined) return SQLITE_OK;
          if (readonlyPragmaAllowed.has(name)) return SQLITE_OK;
          return SQLITE_DENY;
        }
        // 拦截一切写入、DDL、ATTACH、TRANSACTION 以及 SQLITE_RECURSIVE（防无限递归 CTE 卡死单线程）
        return SQLITE_DENY;
      });
      return true;
    };

    const runBounded = (conn) => {
      const s = conn.prepare(sql);
      for (const r of s.iterate()) {
        if (Date.now() - t0 > 3000) {
          truncated = true;
          break;
        }
        if (collected.length >= limit) {
          truncated = true;
          break;
        }
        collected.push({ ...r });
      }
    };

    if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
      const ro = new DatabaseSync(dbPath, { readOnly: true });
      try {
        ro.exec('PRAGMA busy_timeout = 3000; PRAGMA query_only = ON');
        installReadonlyAuthorizer(ro);
        runBounded(ro);
      } catch (e) {
        const msg = e?.message ?? String(e);
        if (/not authorized/i.test(msg)) {
          throw new PanelError('READONLY_SQL', `SQL 被只读沙箱拦截：${msg}`, 400);
        }
        throw new PanelError('SQL_ERROR', `SQL 执行失败：${msg}`, 400);
      } finally {
        try { ro.setAuthorizer?.(null); } catch { /* ignore */ }
        try { ro.close(); } catch { /* ignore */ }
      }
    } else {
      const hasAuth = installReadonlyAuthorizer(db);
      if (!hasAuth) db.exec('PRAGMA query_only = ON');
      try {
        runBounded(db);
      } catch (e) {
        const msg = e?.message ?? String(e);
        if (/not authorized/i.test(msg)) {
          throw new PanelError('READONLY_SQL', `SQL 被只读沙箱拦截：${msg}`, 400);
        }
        throw new PanelError('SQL_ERROR', `SQL 执行失败：${msg}`, 400);
      } finally {
        if (hasAuth) {
          try { db.setAuthorizer(null); } catch { /* ignore */ }
        } else {
          try { db.exec('PRAGMA query_only = OFF'); } catch { /* ignore */ }
        }
      }
    }

    const columns = collected.length > 0 ? Object.keys(collected[0]) : [];
    return {
      columns,
      rows: collected,
      rowCount: collected.length,
      truncated,
      elapsedMs: Date.now() - t0,
    };
  }

  function dbMaintain(params) {
    const action = String(params.action ?? '');
    if (!['backup', 'vacuum', 'purgeTrash', 'exportSession', 'clearSession', 'importSession'].includes(action)) {
      throw new PanelError(
        'BAD_ACTION',
        `不支持的维护动作：${action}。可用：backup / vacuum / purgeTrash / exportSession / clearSession / importSession`,
        400,
      );
    }

    if (action === 'backup') {
      if (!dbPath || dbPath === ':memory:') {
        throw new PanelError('MEMORY_DB', '内存数据库不支持写入磁盘备份', 400);
      }
      const backupDir = path.join(dbRoot, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const now = new Date();
      const pad = (v) => String(v).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, '0')}`;
      let backupPath = path.join(backupDir, `memory-${stamp}.db`);
      if (fs.existsSync(backupPath)) {
        backupPath = path.join(backupDir, `memory-${stamp}-${Math.random().toString(36).slice(2, 6)}.db`);
      }
      const escaped = backupPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}'`);
      const bytes = statSizeSafe(backupPath);
      logger.info?.(`[verbatim] 数据库热备份完成：${backupPath}（${bytes} bytes）`);
      return { ok: true, action, backupPath, bytes };
    }

    if (action === 'vacuum') {
      const beforeBytes = statSizeSafe(dbPath) + (dbPath === ':memory:' ? 0 : statSizeSafe(`${dbPath}-wal`));
      try { db.exec("INSERT INTO msg_fts(msg_fts) VALUES('rebuild')"); } catch { /* 无 msg_fts 时忽略 */ }
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 内存库忽略 */ }
      db.exec('VACUUM');
      const afterBytes = statSizeSafe(dbPath) + (dbPath === ':memory:' ? 0 : statSizeSafe(`${dbPath}-wal`));
      return {
        ok: true,
        action,
        beforeBytes,
        afterBytes,
        savedBytes: Math.max(0, beforeBytes - afterBytes),
      };
    }

    if (action === 'purgeTrash') {
      const sid = optionalSession('dbMaintain', params);
      let purged = 0;
      if (params.all === true) {
        if (sid && noteHasSessionColumn()) {
          purged = Number(stmt('DELETE FROM note WHERE deleted_at IS NOT NULL AND session_id = ?').run(sid).changes);
        } else {
          purged = Number(stmt('DELETE FROM note WHERE deleted_at IS NOT NULL').run().changes);
        }
      } else {
        purged = extras.note.purgeExpired();
      }
      return { ok: true, action, purged };
    }

    if (action === 'importSession') {
      const payload = params.payload && typeof params.payload === 'object' ? params.payload : params;
      const sid = requireSession('dbMaintain', { sessionId: payload.sessionId ?? params.sessionId });
      const rawMsgs = Array.isArray(payload.msgs) ? payload.msgs : [];
      const rawNotes = Array.isArray(payload.notes) ? payload.notes : [];
      if (rawMsgs.length === 0 && rawNotes.length === 0) {
        throw new PanelError('BAD_ARG', '导入数据为空（缺少 msgs 或 notes 数组）', 400);
      }
      const imported = withTx(db, () => {
        const cleanMsgs = rawMsgs
          .filter((m) => m && Number.isFinite(Number(m.seq)) && Number.isFinite(Number(m.at)) && typeof m.text === 'string' && m.text.length > 0 && (m.speaker === 'user' || m.speaker === 'assistant'))
          .map((m) => ({
            sessionId: sid,
            seq: Math.trunc(Number(m.seq)),
            at: Math.trunc(Number(m.at)),
            speaker: m.speaker,
            text: m.text,
            inSurface: m.inSurface === 0 || m.in_surface === 0 ? 0 : 1,
            compactedAt: Number.isFinite(Number(m.compactedAt ?? m.compacted_at)) ? Math.trunc(Number(m.compactedAt ?? m.compacted_at)) : null,
            excluded: m.excluded === 1 || m.excluded === true ? 1 : 0,
          }));
        if (cleanMsgs.length > 0) repo.insertMsgs(cleanMsgs);

        let notesAdded = 0;
        const existingNoteSet = new Set(
          (noteHasSessionColumn() ? extras.note.list({ sessionId: sid, limit: ALL_ROWS }) : extras.note.list({ limit: ALL_ROWS }))
            .map((n) => `${n.at}:${n.content}`),
        );
        for (const n of rawNotes) {
          if (!n || typeof n.content !== 'string' || !n.content.trim()) continue;
          const at = Number.isFinite(Number(n.at)) ? Math.trunc(Number(n.at)) : Date.now();
          const key = `${at}:${n.content.trim()}`;
          if (existingNoteSet.has(key)) continue;
          const about = ['me', 'him', 'us'].includes(n.about) ? n.about : null;
          extras.note.insert({ sessionId: sid, content: n.content.trim(), about, at });
          existingNoteSet.add(key);
          notesAdded += 1;
        }
        return { msgs: cleanMsgs.length, notes: notesAdded };
      });
      logger.info?.(`[verbatim] 已导入会话 ${sid}：msgs=${imported.msgs}, notes=${imported.notes}`);
      return { ok: true, action, sessionId: sid, imported };
    }

    if (action === 'clearSession') {
      const sid = requireSession('dbMaintain', params);
      const runClear = () => withTx(db, () => {
        const msgIds = stmt('SELECT id FROM msg WHERE session_id = ?').all(sid).map((r) => Number(r.id));
        const sceneIds = stmt('SELECT id FROM scene WHERE session_id = ?').all(sid).map((r) => Number(r.id));
        const noteIds = noteHasSessionColumn()
          ? stmt('SELECT id FROM note WHERE session_id = ?').all(sid).map((r) => Number(r.id))
          : [];
        let chunkIds = [];
        if (msgIds.length > 0) {
          try {
            const CHUNK = 400;
            for (let i = 0; i < msgIds.length; i += CHUNK) {
              const slice = msgIds.slice(i, i + CHUNK);
              const ph = slice.map(() => '?').join(',');
              for (const r of db.prepare(`SELECT id FROM chunk WHERE msg_id IN (${ph})`).all(...slice)) {
                chunkIds.push(Number(r.id));
              }
            }
          } catch { chunkIds = []; }
        }
        let windowIds = [];
        try {
          windowIds = stmt('SELECT id FROM window WHERE session_id = ?').all(sid).map((r) => Number(r.id));
        } catch { windowIds = []; }
        deleteVecRows(db, 'msg', msgIds);
        deleteVecRows(db, 'scene', sceneIds);
        deleteVecRows(db, 'chunk', chunkIds);
        deleteVecRows(db, 'note', noteIds);
        deleteVecRows(db, 'window', windowIds);

        const notesDel = noteHasSessionColumn()
          ? Number(stmt('DELETE FROM note WHERE session_id = ?').run(sid).changes)
          : 0;
        try { stmt('DELETE FROM window WHERE session_id = ?').run(sid); } catch { /* ignore */ }
        try { stmt('DELETE FROM recall_log WHERE session_id = ?').run(sid); } catch { /* ignore */ }
        const msgsDel = Number(stmt('DELETE FROM msg WHERE session_id = ?').run(sid).changes);
        const scenesDel = Number(stmt('DELETE FROM scene WHERE session_id = ?').run(sid).changes);
        return { msgs: msgsDel, scenes: scenesDel, notes: notesDel };
      });
      let deleted;
      try {
        deleted = runClear();
      } catch (err) {
        // external-content FTS5（msg_fts）若与 msg 失步，DELETE 触发器会报 database disk image is malformed；
        // 先重建 msg_fts 索引再重试一次即可无损自愈。
        if (!/malformed|corrupt/i.test(String(err?.message ?? err))) throw err;
        logger.warn?.(`[verbatim] 清空会话 ${sid} 时检测到 FTS5 索引失步，正在自动重建 msg_fts 后重试…`);
        db.exec("INSERT INTO msg_fts(msg_fts) VALUES('rebuild')");
        deleted = runClear();
      }
      let configRemoved = false;
      if (params.removeConfig === true) {
        try {
          const cfgPath = sessionConfigPath(sid, { dbRoot });
          if (fs.existsSync(cfgPath)) {
            fs.unlinkSync(cfgPath);
            configRemoved = true;
          }
        } catch (err) {
          logger.warn?.(`[verbatim] 删除会话配置 ${sid} 失败：${err?.message ?? err}`);
        }
      }
      logger.info?.(`[verbatim] 已清空会话 ${sid} 数据：msgs=${deleted.msgs}, scenes=${deleted.scenes}, notes=${deleted.notes}, configRemoved=${configRemoved}`);
      return { ok: true, action, sessionId: sid, deleted, configRemoved };
    }

    const sid = requireSession('dbMaintain', params);
    const cfg = readSessionConfig(sid);
    const msgs = repo.msgsByTimeRange(sid, 0, TIME_MAX, ALL_ROWS, true);
    const scenes = repo.scenesByTimeRange(sid, 0, TIME_MAX, ALL_ROWS);
    const notes = noteHasSessionColumn()
      ? extras.note.list({ sessionId: sid, limit: ALL_ROWS })
      : extras.note.list({ limit: ALL_ROWS });
    return {
      ok: true,
      action,
      sessionId: sid,
      exportedAt: Date.now(),
      config: cfg,
      counts: { msgs: msgs.length, scenes: scenes.length, notes: notes.length },
      msgs,
      scenes,
      notes,
    };
  }

  return { dbOverview, dbRows, dbQuery, dbMaintain };
}
