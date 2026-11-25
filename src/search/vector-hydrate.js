/**
 * 向量检索外层过滤（hydration）与降级模式预过滤模块。
 *
 * 将 KNN 候选 id 批量回表 JOIN 过滤（sessionId / 时间区间 / excluded），
 * 并提供降级模式下的 SQLite 预过滤以减少全量点积开销。
 */

const MSG_SELECT = `m.id, m.session_id, m.seq, m.at, m.speaker, m.text,
  m.in_surface, m.compacted_at, m.excluded, m.scene_id,
  s.start_at AS scene_start_at, s.end_at AS scene_end_at, s.msg_count AS scene_msg_count`;

const MAX_IN_CHUNK = 400;

/** 拼 `?,?,?` */
export function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

/** IN 列表里每个 id 都过一遍安全整数校验（vec0 的 rowid 是整数） */
function toParams(ids) {
  return ids.map((id) => {
    const n = Number(id);
    if (!Number.isSafeInteger(n)) throw new TypeError(`候选 id 不是安全整数：${String(id)}`);
    return n;
  });
}

/** 分片执行 `IN (...)` 查询（避免超出 SQLITE_MAX_VARIABLE_NUMBER 且不污染 stmtCache） */
export function queryByIds(ids, runSlice) {
  const clean = toParams(ids);
  for (let i = 0; i < clean.length; i += MAX_IN_CHUNK) {
    runSlice(clean.slice(i, i + MAX_IN_CHUNK));
  }
}

/** msg 表行 → 检索命中的公共字段（和 repo 的 MsgRow 同名，见 BUILD-PLAN §3.1） */
function mapMsgRow(r) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(r.id),
    sessionId: r.session_id,
    seq: Number(r.seq),
    at: Number(r.at),
    speaker: r.speaker,
    text: r.text,
    inSurface: Number(r.in_surface),
    compactedAt: n(r.compacted_at),
    excluded: Number(r.excluded ?? 0),
    sceneId: n(r.scene_id),
    sceneStartAt: n(r.scene_start_at),
    sceneEndAt: n(r.scene_end_at),
    sceneMsgCount: n(r.scene_msg_count),
  };
}

/** scene 表行 → 检索命中的公共字段 */
function mapSceneRow(r) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(r.id),
    sessionId: r.session_id,
    startAt: Number(r.start_at),
    endAt: Number(r.end_at),
    msgCount: Number(r.msg_count),
    gist: r.gist ?? null,
    precededBy: n(r.preceded_by),
    followedBy: n(r.followed_by),
  };
}

/**
 * 创建与 `db` 绑定的外层过滤与降级预过滤函数组。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createVectorHydrator(db) {
  /**
   * 降级模式预过滤：当存在 sessionId / 时间等缩小范围条件且全库向量数较多时，
   * 先在 SQLite 利用索引拿目标 id 集合，避免对无关会话全量计算点积与排序。
   */
  function prefilterFallbackIds(kind, filter, totalCount) {
    if (totalCount <= 200) return null;
    const hasNarrowFilter = Boolean(filter.sessionId)
      || Number.isFinite(filter.from)
      || Number.isFinite(filter.to)
      || Number.isFinite(filter.sceneId);
    if (!hasNarrowFilter) return null;
    try {
      const where = [];
      const args = [];
      let sql;
      if (kind === 'msg') {
        if (!filter.includeExcluded) where.push('excluded = 0');
        if (filter.sessionId) { where.push('session_id = ?'); args.push(filter.sessionId); }
        if (Number.isFinite(filter.from)) { where.push('at >= ?'); args.push(filter.from); }
        if (Number.isFinite(filter.to)) { where.push('at < ?'); args.push(filter.to); }
        if (Number.isFinite(filter.sceneId)) { where.push('scene_id = ?'); args.push(filter.sceneId); }
        sql = `SELECT id FROM msg${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
      } else if (kind === 'scene') {
        if (filter.sessionId) { where.push('session_id = ?'); args.push(filter.sessionId); }
        if (Number.isFinite(filter.from)) { where.push('end_at >= ?'); args.push(filter.from); }
        if (Number.isFinite(filter.to)) { where.push('start_at < ?'); args.push(filter.to); }
        sql = `SELECT id FROM scene${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
      } else if (kind === 'note') {
        where.push('deleted_at IS NULL');
        if (filter.sessionId) { where.push('session_id = ?'); args.push(filter.sessionId); }
        if (Number.isFinite(filter.from)) { where.push('at >= ?'); args.push(filter.from); }
        if (Number.isFinite(filter.to)) { where.push('at < ?'); args.push(filter.to); }
        sql = `SELECT id FROM note WHERE ${where.join(' AND ')}`;
      } else if (kind === 'chunk') {
        if (filter.sessionId) { where.push('m.session_id = ?'); args.push(filter.sessionId); }
        if (!filter.includeExcluded) where.push('m.excluded = 0');
        if (Number.isFinite(filter.from)) { where.push('m.at >= ?'); args.push(filter.from); }
        if (Number.isFinite(filter.to)) { where.push('m.at < ?'); args.push(filter.to); }
        sql = `SELECT c.id FROM chunk c JOIN msg m ON m.id = c.msg_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
      } else if (kind === 'window') {
        if (filter.sessionId) { where.push('session_id = ?'); args.push(filter.sessionId); }
        if (filter.kind) { where.push('kind = ?'); args.push(String(filter.kind)); }
        if (Number.isFinite(filter.from)) { where.push('end_at >= ?'); args.push(filter.from); }
        if (Number.isFinite(filter.to)) { where.push('start_at < ?'); args.push(filter.to); }
        sql = `SELECT id FROM window${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
      } else {
        return null;
      }
      const rows = db.prepare(sql).all(...args);
      return new Set(rows.map((r) => Number(r.id)));
    } catch {
      return null;
    }
  }

  function hydrateMsgs(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = [];
    const extraArgs = [];
    if (!filter.includeExcluded) where.push('m.excluded = 0');
    if (filter.sessionId) {
      where.push('m.session_id = ?');
      extraArgs.push(filter.sessionId);
    }
    if (Number.isFinite(filter.from)) {
      where.push('m.at >= ?');
      extraArgs.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('m.at < ?');
      extraArgs.push(filter.to);
    }
    if (Number.isFinite(filter.sceneId)) {
      where.push('m.scene_id = ?');
      extraArgs.push(filter.sceneId);
    }
    const map = new Map();
    const tail = where.length ? ` AND ${where.join(' AND ')}` : '';
    queryByIds(ids, (slice) => {
      const sql =
        `SELECT ${MSG_SELECT}
         FROM msg m LEFT JOIN scene s ON s.id = m.scene_id
         WHERE m.id IN (${placeholders(slice.length)})${tail}`;
      for (const r of db.prepare(sql).all(...slice, ...extraArgs)) map.set(Number(r.id), mapMsgRow(r));
    });
    return map;
  }

  function hydrateScenes(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = [];
    const extraArgs = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      extraArgs.push(filter.sessionId);
    }
    if (Number.isFinite(filter.from)) {
      where.push('end_at >= ?');
      extraArgs.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('start_at < ?');
      extraArgs.push(filter.to);
    }
    const map = new Map();
    const tail = where.length ? ` AND ${where.join(' AND ')}` : '';
    queryByIds(ids, (slice) => {
      const sql =
        `SELECT * FROM scene
         WHERE id IN (${placeholders(slice.length)})${tail}`;
      for (const r of db.prepare(sql).all(...slice, ...extraArgs)) map.set(Number(r.id), mapSceneRow(r));
    });
    return map;
  }

  function hydrateNotes(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = ['n.deleted_at IS NULL'];
    const extraArgs = [];
    if (filter.sessionId) {
      where.push('n.session_id = ?');
      extraArgs.push(filter.sessionId);
    }
    if (Number.isFinite(filter.from)) {
      where.push('n.at >= ?');
      extraArgs.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('n.at < ?');
      extraArgs.push(filter.to);
    }
    const map = new Map();
    const cond = where.join(' AND ');
    queryByIds(ids, (slice) => {
      const rows = db.prepare(
        `SELECT n.id, n.content, n.about, n.at, n.session_id
           FROM note n
          WHERE n.id IN (${placeholders(slice.length)})
            AND ${cond}`,
      ).all(...slice, ...extraArgs);
      for (const r of rows) {
        map.set(Number(r.id), {
          id: Number(r.id),
          content: String(r.content ?? ''),
          about: r.about ?? null,
          at: Number(r.at),
          sessionId: r.session_id ?? null,
        });
      }
    });
    return map;
  }

  function hydrateChunks(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const extraWhere = [];
    const extraArgs = [];
    if (filter.sessionId) {
      extraWhere.push('m.session_id = ?');
      extraArgs.push(filter.sessionId);
    }
    if (!filter.includeExcluded) extraWhere.push('m.excluded = 0');
    if (Number.isFinite(filter.from)) {
      extraWhere.push('m.at >= ?');
      extraArgs.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      extraWhere.push('m.at < ?');
      extraArgs.push(filter.to);
    }
    const map = new Map();
    const tail = extraWhere.length ? ` AND ${extraWhere.join(' AND ')}` : '';
    queryByIds(ids, (slice) => {
      const rows = db.prepare(
        `SELECT c.id, c.msg_id, c.idx, c.start_char, c.end_char,
                m.session_id, m.excluded, m.at
           FROM chunk c JOIN msg m ON m.id = c.msg_id
          WHERE c.id IN (${placeholders(slice.length)})${tail}`,
      ).all(...slice, ...extraArgs);
      for (const r of rows) map.set(Number(r.id), r);
    });
    return map;
  }

  function hydrateWindows(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const extraWhere = [];
    const extraArgs = [];
    if (filter.sessionId) {
      extraWhere.push('w.session_id = ?');
      extraArgs.push(filter.sessionId);
    }
    if (filter.kind) {
      extraWhere.push('w.kind = ?');
      extraArgs.push(String(filter.kind));
    }
    if (Number.isFinite(filter.from)) {
      extraWhere.push('w.end_at >= ?');
      extraArgs.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      extraWhere.push('w.start_at < ?');
      extraArgs.push(filter.to);
    }
    try {
      const map = new Map();
      const tail = extraWhere.length ? ` AND ${extraWhere.join(' AND ')}` : '';
      queryByIds(ids, (slice) => {
        const rows = db.prepare(
          `SELECT w.id, w.session_id, w.scene_id, w.idx, w.kind, w.start_msg_id, w.end_msg_id,
                  w.start_at, w.end_at, w.msg_count, w.text,
                  s.start_at AS scene_start_at, s.end_at AS scene_end_at, s.msg_count AS scene_msg_count
             FROM window w
             LEFT JOIN scene s ON s.id = w.scene_id
            WHERE w.id IN (${placeholders(slice.length)})${tail}`,
        ).all(...slice, ...extraArgs);
        for (const r of rows) map.set(Number(r.id), r);
      });
      return map;
    } catch {
      return new Map();
    }
  }

  return {
    prefilterFallbackIds,
    hydrateMsgs,
    hydrateScenes,
    hydrateNotes,
    hydrateChunks,
    hydrateWindows,
  };
}
