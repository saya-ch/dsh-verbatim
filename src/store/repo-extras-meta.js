/**
 * `createExtras` 的元数据与管理子模块：note / audit / vecMeta / sceneAssign / flag。
 */

export function createNoteExtras({ stmt, p, required, field, mapNote }) {
  return {
    insert({ content, about = null, at = Date.now(), sessionId, session_id } = {}) {
      const text = required({ content }, ['content'], 'note.insert');
      const sid = p(field({ sessionId, session_id }, 'sessionId', 'session_id') ?? null);
      const got = stmt(
        'INSERT INTO note (content, about, at, deleted_at, session_id) VALUES (?, ?, ?, NULL, ?) RETURNING id',
      ).get(String(text), p(about), p(at), sid);
      return Number(got.id);
    },

    byId(id, opts = {}) {
      const sid = opts?.sessionId;
      const r = sid
        ? stmt('SELECT * FROM note WHERE id = ? AND session_id = ?').get(p(id), p(sid))
        : stmt('SELECT * FROM note WHERE id = ?').get(p(id));
      return r ? mapNote(r) : null;
    },

    list(opts = {}) {
      const limit = p(opts.limit ?? 100);
      const offset = p(opts.offset ?? 0);
      const includeDeleted = Boolean(opts.includeDeleted);
      const deletedOnly = opts.deletedOnly === true;
      const where = [];
      const args = [];
      if (opts.sessionId) {
        where.push('session_id = ?');
        args.push(opts.sessionId);
      }
      if (opts.about) {
        where.push('about = ?');
        args.push(opts.about);
      }
      if (Number.isFinite(opts.from)) {
        where.push('at >= ?');
        args.push(Number(opts.from));
      }
      if (Number.isFinite(opts.to)) {
        where.push('at < ?');
        args.push(Number(opts.to));
      }
      if (deletedOnly) where.push('deleted_at IS NOT NULL');
      else if (!includeDeleted) where.push('deleted_at IS NULL');
      const orderBy = deletedOnly ? ' ORDER BY deleted_at DESC, id DESC' : ' ORDER BY at DESC, id DESC';
      const sql =
        'SELECT * FROM note' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        `${orderBy} LIMIT ? OFFSET ?`;
      return stmt(sql)
        .all(...args, limit, offset)
        .map(mapNote);
    },

    searchKeyword(opts = {}) {
      const limit = p(opts.limit ?? 1000);
      const offset = p(opts.offset ?? 0);
      const where = ['deleted_at IS NULL'];
      const args = [];
      if (opts.sessionId) {
        where.push('session_id = ?');
        args.push(opts.sessionId);
      }
      if (Number.isFinite(opts.from)) {
        where.push('at >= ?');
        args.push(Number(opts.from));
      }
      if (Number.isFinite(opts.to)) {
        where.push('at < ?');
        args.push(Number(opts.to));
      }
      const rawTerms = Array.isArray(opts.terms) ? opts.terms : [];
      const cleanTerms = [...new Set(rawTerms.map((t) => String(t ?? '').trim()).filter(Boolean))];
      if (opts.query && String(opts.query).trim()) {
        const q = String(opts.query).trim();
        if (!cleanTerms.includes(q)) cleanTerms.unshift(q);
      }
      if (cleanTerms.length > 0) {
        const orParts = [];
        for (const term of cleanTerms) {
          orParts.push("LOWER(content) LIKE '%' || LOWER(?) || '%'");
          args.push(term);
        }
        where.push(`(${orParts.join(' OR ')})`);
      }
      const sql =
        `SELECT * FROM note WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`;
      return stmt(sql)
        .all(...args, limit, offset)
        .map(mapNote);
    },

    count(opts = {}) {
      const includeDeleted = Boolean(opts.includeDeleted);
      const deletedOnly = opts.deletedOnly === true;
      const where = [];
      const args = [];
      if (opts.sessionId) {
        where.push('session_id = ?');
        args.push(opts.sessionId);
      }
      if (Number.isFinite(opts.from)) {
        where.push('at >= ?');
        args.push(Number(opts.from));
      }
      if (Number.isFinite(opts.to)) {
        where.push('at < ?');
        args.push(Number(opts.to));
      }
      if (deletedOnly) where.push('deleted_at IS NOT NULL');
      else if (!includeDeleted) where.push('deleted_at IS NULL');
      const sql =
        'SELECT COUNT(*) AS c FROM note' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '');
      return Number(stmt(sql).get(...args)?.c ?? 0);
    },

    softDelete(id, at = Date.now(), opts = {}) {
      const sid = opts?.sessionId;
      const sql = sid
        ? 'UPDATE note SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND session_id = ?'
        : 'UPDATE note SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL';
      const info = sid
        ? stmt(sql).run(p(at), p(id), p(sid))
        : stmt(sql).run(p(at), p(id));
      return Number(info.changes) > 0;
    },

    restore(id, opts = {}) {
      const sid = opts?.sessionId;
      const sql = sid
        ? 'UPDATE note SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL AND session_id = ?'
        : 'UPDATE note SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL';
      const info = sid ? stmt(sql).run(p(id), p(sid)) : stmt(sql).run(p(id));
      return Number(info.changes) > 0;
    },

    purgeExpired(retentionMs = 30 * 24 * 60 * 60 * 1000, now = Date.now(), opts = {}) {
      const sid = opts?.sessionId;
      const sql = sid
        ? 'DELETE FROM note WHERE deleted_at IS NOT NULL AND deleted_at < ? AND session_id = ?'
        : 'DELETE FROM note WHERE deleted_at IS NOT NULL AND deleted_at < ?';
      const info = sid
        ? stmt(sql).run(p(now - retentionMs), p(sid))
        : stmt(sql).run(p(now - retentionMs));
      return Number(info.changes);
    },
  };
}

export function createAuditExtras({ stmt, p, required, toJsonText }) {
  return {
    insert({ action, target, detail = null, at = Date.now() } = {}) {
      const act = required({ action }, ['action'], 'audit.insert');
      const tgt = required({ target }, ['target'], 'audit.insert');
      const got = stmt('INSERT INTO audit (action, target, detail, at) VALUES (?, ?, ?, ?) RETURNING id')
        .get(String(act), String(tgt), p(toJsonText(detail) ?? null), p(at));
      return Number(got.id);
    },

    list(limit = 100) {
      return stmt('SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ?')
        .all(p(limit))
        .map((r) => ({
          id: Number(r.id),
          action: r.action,
          target: r.target,
          detail: r.detail ?? null,
          at: Number(r.at),
        }));
    },

    byTarget(target, limit = 50) {
      return stmt('SELECT * FROM audit WHERE target = ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(p(target), p(limit))
        .map((r) => ({
          id: Number(r.id),
          action: r.action,
          target: r.target,
          detail: r.detail ?? null,
          at: Number(r.at),
        }));
    },
  };
}

export function createVecMetaExtras({ db, stmt, p, withTx, mapMsg }) {
  const vecMeta = {
    get(opts = {}) {
      const sid = opts?.sessionId;
      const row = sid
        ? stmt(
          `SELECT vec_model AS model, vec_dim AS dim, COUNT(*) AS indexed
           FROM msg WHERE session_id = ? AND vec_model IS NOT NULL
           GROUP BY vec_model, vec_dim ORDER BY indexed DESC LIMIT 1`,
        ).get(p(sid))
        : stmt(
          `SELECT vec_model AS model, vec_dim AS dim, COUNT(*) AS indexed
           FROM msg WHERE vec_model IS NOT NULL
           GROUP BY vec_model, vec_dim ORDER BY indexed DESC LIMIT 1`,
        ).get();
      const total = sid
        ? Number(stmt('SELECT COUNT(*) AS c FROM msg WHERE session_id = ?').get(p(sid)).c)
        : Number(stmt('SELECT COUNT(*) AS c FROM msg').get().c);
      return {
        model: row?.model ?? null,
        dim: row?.dim ?? null,
        indexed: Number(row?.indexed ?? 0),
        total,
      };
    },

    assert(provider) {
      if (!provider?.id) throw new TypeError('vecMeta.assert: provider 缺少 id');
      const current = vecMeta.get();
      if (!current.model) return;
      if (current.model !== provider.id || current.dim !== provider.dim) {
        throw new Error(
          `向量模型不一致：库里是 ${current.model}，当前是 ${provider.id}。`
            + '不同模型的向量不可比，请重建向量索引。',
        );
      }
    },

    set(msgIds, provider) {
      if (!Array.isArray(msgIds) || msgIds.length === 0) return 0;
      if (!provider?.id || !provider?.dim) throw new TypeError('vecMeta.set: provider 需要 id 和 dim');
      return withTx(db, () => {
        const upd = stmt('UPDATE msg SET vec_model = ?, vec_dim = ? WHERE id = ?');
        let n = 0;
        for (const id of msgIds) n += Number(upd.run(provider.id, provider.dim, p(id)).changes);
        return n;
      });
    },

    _pendingWhere(opts = {}) {
      const model = opts.model ?? null;
      const sid = typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
      const clauses = [];
      const args = [];
      if (!opts.includeExcluded) clauses.push('excluded = 0');
      if (sid) {
        clauses.push('session_id = ?');
        args.push(p(sid));
      }
      if (model) {
        clauses.push('(vec_model IS NULL OR vec_model <> ?)');
        args.push(model);
      } else {
        clauses.push('vec_model IS NULL');
      }
      return { whereSql: clauses.join(' AND '), args };
    },

    pending(opts = {}) {
      const { whereSql, args } = vecMeta._pendingWhere(opts);
      const limit = p(opts.limit ?? 500);
      return stmt(
        `SELECT * FROM msg
         WHERE ${whereSql}
         ORDER BY at ASC, seq ASC LIMIT ?`,
      )
        .all(...args, limit)
        .map(mapMsg);
    },

    countPending(opts = {}) {
      const { whereSql, args } = vecMeta._pendingWhere(opts);
      return Number(
        stmt(`SELECT COUNT(*) AS c FROM msg WHERE ${whereSql}`).get(...args)?.c ?? 0,
      );
    },
  };
  return vecMeta;
}

export function createSceneAssignExtras({ db, stmt, p, withTx, deleteVecRows }) {
  return {
    assign(msgIds, sceneId) {
      if (!Array.isArray(msgIds) || msgIds.length === 0) return 0;
      return withTx(db, () => {
        const upd = stmt('UPDATE msg SET scene_id = ? WHERE id = ?');
        let n = 0;
        for (const id of msgIds) n += Number(upd.run(p(sceneId), p(id)).changes);
        return n;
      });
    },

    assignSeqRange(sessionId, fromSeq, toSeq, sceneId) {
      const info = stmt('UPDATE msg SET scene_id = ? WHERE session_id = ? AND seq BETWEEN ? AND ?').run(
        p(sceneId),
        p(sessionId),
        p(fromSeq),
        p(toSeq),
      );
      return Number(info.changes);
    },

    assignSeqs(sessionId, seqs, sceneId) {
      const list = [...new Set((Array.isArray(seqs) ? seqs : []).map(Number).filter((n) => Number.isFinite(n)))];
      if (list.length === 0) return 0;
      let changed = 0;
      const CHUNK = 400;
      for (let i = 0; i < list.length; i += CHUNK) {
        const slice = list.slice(i, i + CHUNK);
        const info = stmt(
          `UPDATE msg SET scene_id = ? WHERE session_id = ? AND seq IN (${slice.map(() => '?').join(', ')})`,
        ).run(p(sceneId), p(sessionId), ...slice.map(p));
        changed += Number(info.changes);
      }
      return changed;
    },

    unassign(sceneId) {
      const info = stmt('UPDATE msg SET scene_id = NULL WHERE scene_id = ?').run(p(sceneId));
      return Number(info.changes);
    },

    clear(sessionId, opts = {}) {
      return withTx(db, () => {
        const sceneIds = stmt('SELECT id FROM scene WHERE session_id = ?')
          .all(p(sessionId))
          .map((r) => Number(r.id));
        let windowIds = [];
        try {
          windowIds = stmt('SELECT id FROM window WHERE session_id = ?')
            .all(p(sessionId))
            .map((r) => Number(r.id));
        } catch { /* 老库可能还没有 window 表 */ }
        const msgs = Number(stmt('UPDATE msg SET scene_id = NULL WHERE session_id = ?').run(p(sessionId)).changes);
        const scenes = Number(stmt('DELETE FROM scene WHERE session_id = ?').run(p(sessionId)).changes);
        deleteVecRows(db, 'scene', sceneIds);
        if (windowIds.length > 0) deleteVecRows(db, 'window', windowIds);
        return opts.withIds ? { scenes, msgs, sceneIds } : { scenes, msgs };
      });
    },

    syncExcludedForSession(sessionId, normalizedRanges = []) {
      const ranges = Array.isArray(normalizedRanges) ? normalizedRanges : [];
      const hit = (at) => ranges.some((r) => at >= r.from && at < r.to);
      return withTx(db, () => {
        const sid = p(sessionId);
        const rows = stmt('SELECT id, at, excluded FROM msg WHERE session_id = ?').all(sid);
        const updMsg = stmt('UPDATE msg SET excluded = ? WHERE id = ?');
        let updatedMsgs = 0;
        let excludedMsgs = 0;
        for (const r of rows) {
          const next = hit(Number(r.at)) ? 1 : 0;
          if (next === 1) excludedMsgs += 1;
          const cur = Number(r.excluded ?? 0) ? 1 : 0;
          if (next !== cur) {
            updMsg.run(next, p(r.id));
            updatedMsgs += 1;
          }
        }

        const byScene = new Map(
          stmt(
            'SELECT scene_id, SUM(CASE WHEN excluded = 1 THEN 1 ELSE 0 END) AS ec FROM msg WHERE session_id = ? AND scene_id IS NOT NULL GROUP BY scene_id',
          )
            .all(sid)
            .map((r) => [Number(r.scene_id), Number(r.ec ?? 0)]),
        );
        const scenes = stmt('SELECT id, excluded_count, has_excluded FROM scene WHERE session_id = ?').all(sid);
        const updScene = stmt('UPDATE scene SET excluded_count = ?, has_excluded = ? WHERE id = ?');
        for (const sc of scenes) {
          const ec = byScene.get(Number(sc.id)) ?? 0;
          const has = ec > 0 ? 1 : 0;
          if (Number(sc.excluded_count ?? 0) !== ec || Number(sc.has_excluded ?? 0) !== has) {
            updScene.run(ec, has, p(sc.id));
          }
        }

        return { totalMsgs: rows.length, updatedMsgs, excludedMsgs };
      });
    },
  };
}

export function createFlagExtras({ stmt, p, mapFlag }) {
  return {
    insert({ msgId, reason = null, at = Date.now() } = {}) {
      if (msgId === undefined || msgId === null) throw new TypeError('flag.insert: 缺少 msgId');
      const got = stmt('INSERT INTO flag (msg_id, reason, at, resolved_at) VALUES (?, ?, ?, NULL) RETURNING id')
        .get(p(msgId), p(reason), p(at));
      return Number(got.id);
    },

    list(opts = {}) {
      const where = [];
      const args = [];
      if (opts.openOnly) where.push('f.resolved_at IS NULL');
      if (opts.sessionId) {
        where.push('m.session_id = ?');
        args.push(opts.sessionId);
      }
      const sql = `SELECT f.*, m.session_id AS session_id, m.seq AS msg_seq, m.at AS msg_at
                   FROM flag f JOIN msg m ON m.id = f.msg_id
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY f.at DESC, f.id DESC LIMIT ?`;
      return stmt(sql).all(...args, p(opts.limit ?? 100)).map(mapFlag);
    },

    resolve(id, at = Date.now()) {
      const info = stmt('UPDATE flag SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(p(at), p(id));
      return Number(info.changes) > 0;
    },

    count(opts = {}) {
      const where = [];
      const args = [];
      if (opts.openOnly) where.push('f.resolved_at IS NULL');
      if (opts.sessionId) {
        where.push('m.session_id = ?');
        args.push(opts.sessionId);
      }
      const sql = `SELECT COUNT(*) AS c FROM flag f JOIN msg m ON m.id = f.msg_id
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
      return Number(stmt(sql).get(...args).c ?? 0);
    },
  };
}
