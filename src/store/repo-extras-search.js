// @ts-check
/**
 * `createExtras` 的检索、统计与片段子模块：search / stats / chunk / media / window。
 */

const zhSegmenter = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

const STOPWORDS_ZH3 = new Set([
  '为什么', '怎么样', '怎么了', '怎么说', '怎么回', '怎么用', '怎么弄', '怎么做',
  '什么时候', '是不是', '有没有', '能不能', '可不可以', '会不会', '算不算', '值不值',
  '还记得', '记不记得', '怎么回事', '什么意思', '差不多', '一下子', '说清楚', '告诉我',
  '那时候', '这一回', '那一回', '还有一', '为什么会', '到底是', '究竟是',
]);

function splitTerms(raw) {
  return String(raw)
    .trim()
    .split(/[\s,.;:!?"'“”‘’、，。；：！？「」『』（）()【】[\]…—-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

function extractTechAnchors(raw) {
  const s = String(raw ?? '');
  const out = [];
  for (const m of s.matchAll(/[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)+|[A-Za-z]{3,}/g)) {
    if (m[0]) out.push(m[0]);
  }
  if (zhSegmenter) {
    for (const seg of zhSegmenter.segment(s)) {
      if (!seg.isWordLike) continue;
      const w = seg.segment.trim();
      if (Array.from(w).length >= 3 && !STOPWORDS_ZH3.has(w)) out.push(w);
    }
  }
  return out;
}

function longTermsOf(raw) {
  const merged = [...splitTerms(raw), ...extractTechAnchors(raw)];
  const seen = new Set();
  const out = [];
  for (const t of merged) {
    if (Array.from(t).length < 3) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function ftsExpr(terms) {
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

function keywordFilter(opts) {
  const filters = [];
  const filterArgs = [];
  if (!opts.includeExcluded) filters.push('m.excluded = 0');
  if (opts.sessionId) {
    filters.push('m.session_id = ?');
    filterArgs.push(opts.sessionId);
  }
  if (Number.isFinite(opts.from)) {
    filters.push('m.at >= ?');
    filterArgs.push(opts.from);
  }
  if (Number.isFinite(opts.to)) {
    filters.push('m.at < ?');
    filterArgs.push(opts.to);
  }
  return { tail: filters.length ? ` AND ${filters.join(' AND ')}` : '', filterArgs };
}

export function createSearchExtras({ stmt, p, mapMsg }) {
  function mapMsgWithScene(r) {
    const m = mapMsg(r);
    m.sceneStartAt = r.scene_start_at ?? null;
    m.sceneEndAt = r.scene_end_at ?? null;
    m.sceneMsgCount = r.scene_msg_count ?? null;
    return m;
  }

  return {
    keyword(query, opts = {}) {
      const raw = String(query ?? '').trim();
      if (!raw) return [];

      const limit = p(opts.limit ?? 20);
      const { tail, filterArgs } = keywordFilter(opts);
      const cols = 'm.*, s.start_at AS scene_start_at, s.end_at AS scene_end_at, s.msg_count AS scene_msg_count';

      const longTerms = longTermsOf(raw);
      if (longTerms.length) {
        try {
          const rows = stmt(
            `SELECT ${cols}
             FROM msg_fts
             CROSS JOIN msg m ON m.id = msg_fts.rowid
             LEFT JOIN scene s ON s.id = m.scene_id
             WHERE msg_fts MATCH ?${tail}
             ORDER BY bm25(msg_fts) ASC
             LIMIT ?`,
          ).all(ftsExpr(longTerms), ...filterArgs, limit);
          if (rows.length) return rows.map(mapMsgWithScene);
        } catch {
          // FTS 语法错误：落到 LIKE
        }
      }

      return stmt(
        `SELECT ${cols}
         FROM msg m LEFT JOIN scene s ON s.id = m.scene_id
         WHERE m.text LIKE ? ESCAPE '\\'${tail}
         ORDER BY m.at DESC
         LIMIT ?`,
      )
        .all(`%${escapeLike(raw)}%`, ...filterArgs, limit)
        .map(mapMsgWithScene);
    },

    countKeyword(query, opts = {}) {
      const raw = String(query ?? '').trim();
      if (!raw) return 0;
      const { tail, filterArgs } = keywordFilter(opts);

      const longTerms = longTermsOf(raw);
      if (longTerms.length) {
        try {
          const hit = stmt(
            `SELECT COUNT(*) AS c
             FROM msg_fts CROSS JOIN msg m ON m.id = msg_fts.rowid
             WHERE msg_fts MATCH ?${tail}`,
          ).get(ftsExpr(longTerms), ...filterArgs);
          if (Number(hit.c) > 0) return Number(hit.c);
        } catch {
          // FTS 语法错误就落 LIKE
        }
      }

      const like = stmt(
        `SELECT COUNT(*) AS c FROM msg m WHERE m.text LIKE ? ESCAPE '\\'${tail}`,
      ).get(`%${escapeLike(raw)}%`, ...filterArgs);
      return Number(like.c ?? 0);
    },
  };
}

export function createStatsExtras({ stmt, p }) {
  return {
    get(opts = {}) {
      const sid = opts?.sessionId;
      const brief =
        `SELECT COUNT(*) AS c,
                MIN(at) AS firstAt,
                MAX(at) AS lastAt,
                SUM(LENGTH(text)) AS chars,
                SUM(CASE WHEN excluded = 1 THEN 1 ELSE 0 END) AS excludedMsgs,
                SUM(CASE WHEN excluded = 1 THEN LENGTH(text) ELSE 0 END) AS excludedChars
         FROM msg`;
      const m = sid ? stmt(`${brief} WHERE session_id = ?`).get(p(sid)) : stmt(brief).get();
      const s = sid
        ? stmt('SELECT COUNT(*) AS c FROM scene WHERE session_id = ?').get(p(sid))
        : stmt('SELECT COUNT(*) AS c FROM scene').get();
      const n = sid
        ? stmt('SELECT COUNT(*) AS c FROM note WHERE deleted_at IS NULL AND session_id = ?').get(p(sid))
        : stmt('SELECT COUNT(*) AS c FROM note WHERE deleted_at IS NULL').get();
      return {
        msgs: Number(m.c ?? 0),
        scenes: Number(s.c ?? 0),
        notes: Number(n.c ?? 0),
        chars: Number(m.chars ?? 0),
        excludedMsgs: Number(m.excludedMsgs ?? 0),
        excludedChars: Number(m.excludedChars ?? 0),
        firstAt: m.firstAt === null || m.firstAt === undefined ? null : Number(m.firstAt),
        lastAt: m.lastAt === null || m.lastAt === undefined ? null : Number(m.lastAt),
      };
    },
  };
}

export function createChunkExtras({ stmt, p }) {
  return {
    count(msgId) {
      try {
        const r = stmt('SELECT COUNT(*) AS c FROM chunk WHERE msg_id = ?').get(p(msgId));
        return Number(r?.c ?? 0);
      } catch {
        return 0;
      }
    },

    list(msgId) {
      try {
        return stmt('SELECT id, msg_id, idx, start_char, end_char FROM chunk WHERE msg_id = ? ORDER BY idx ASC')
          .all(p(msgId))
          .map((r) => ({
            chunkId: Number(r.id),
            msgId: Number(r.msg_id),
            idx: Number(r.idx),
            startChar: Number(r.start_char),
            endChar: Number(r.end_char),
          }));
      } catch {
        return [];
      }
    },
  };
}

export function createMediaExtras({ db, stmt, p, withTx }) {
  return {
    replaceForSession(sessionId, items) {
      if (!sessionId || !Array.isArray(items) || items.length === 0) return 0;
      const bySeq = new Map();
      for (const it of items) {
        if (!it || typeof it.path !== 'string' || !it.path.trim()) continue;
        const seq = Number(it.seq);
        if (!Number.isFinite(seq)) continue;
        if (!bySeq.has(seq)) bySeq.set(seq, []);
        bySeq.get(seq).push(it);
      }
      if (bySeq.size === 0) return 0;

      return withTx(db, () => {
        const findMsg = stmt('SELECT id FROM msg WHERE session_id = ? AND seq = ?');
        const oldMedia = stmt('SELECT path, sha256, caption FROM media WHERE msg_id = ?');
        const del = stmt('DELETE FROM media WHERE msg_id = ?');
        const ins = stmt(
          'INSERT INTO media (msg_id, path, sha256, width, height, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        let written = 0;
        const now = Date.now();
        for (const [seq, list] of bySeq) {
          const row = findMsg.get(p(sessionId), p(seq));
          if (!row) continue;
          const msgId = Number(row.id);
          const captionByKey = new Map();
          for (const prev of oldMedia.all(p(msgId))) {
            if (typeof prev.caption === 'string' && prev.caption.trim()) {
              if (prev.sha256) captionByKey.set(`sha:${prev.sha256}`, prev.caption);
              if (prev.path) captionByKey.set(`path:${prev.path}`, prev.caption);
            }
          }
          del.run(p(msgId));
          for (const it of list) {
            const pStr = it.path.trim();
            const restoredCaption = it.caption ?? (it.sha256 ? captionByKey.get(`sha:${it.sha256}`) : null) ?? captionByKey.get(`path:${pStr}`) ?? null;
            ins.run(
              p(msgId),
              pStr,
              it.sha256 ?? null,
              Number.isFinite(Number(it.width)) ? Math.trunc(Number(it.width)) : null,
              Number.isFinite(Number(it.height)) ? Math.trunc(Number(it.height)) : null,
              restoredCaption,
              Number.isFinite(Number(it.at)) ? Math.trunc(Number(it.at)) : now,
            );
            written += 1;
          }
        }
        return written;
      });
    },

    byMsgIds(msgIds) {
      const out = new Map();
      if (!Array.isArray(msgIds) || msgIds.length === 0) return out;
      const ids = [...new Set(msgIds.map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0))];
      if (ids.length === 0) return out;
      try {
        const ph = ids.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT id, msg_id, path, sha256, width, height, caption, created_at FROM media WHERE msg_id IN (${ph}) ORDER BY id ASC`)
          .all(...ids.map(p));
        for (const r of rows) {
          const mid = Number(r.msg_id);
          if (!out.has(mid)) out.set(mid, []);
          out.get(mid).push({
            id: Number(r.id),
            msgId: mid,
            path: String(r.path),
            sha256: r.sha256 ?? null,
            width: r.width === null || r.width === undefined ? null : Number(r.width),
            height: r.height === null || r.height === undefined ? null : Number(r.height),
            caption: r.caption ?? null,
            createdAt: Number(r.created_at),
          });
        }
      } catch { /* 老库可能无 media 表 */ }
      return out;
    },

    byId(id) {
      const mid = Number(id);
      if (!Number.isSafeInteger(mid) || mid <= 0) return null;
      try {
        const r = stmt('SELECT id, msg_id, path, sha256, width, height, caption, created_at FROM media WHERE id = ?').get(p(mid));
        if (!r) return null;
        return {
          id: Number(r.id),
          msgId: Number(r.msg_id),
          path: String(r.path),
          sha256: r.sha256 ?? null,
          width: r.width === null || r.width === undefined ? null : Number(r.width),
          height: r.height === null || r.height === undefined ? null : Number(r.height),
          caption: r.caption ?? null,
          createdAt: Number(r.created_at),
        };
      } catch {
        return null;
      }
    },

    setCaption(id, caption) {
      const mid = Number(id);
      if (!Number.isSafeInteger(mid) || mid <= 0) return 0;
      return Number(stmt('UPDATE media SET caption = ? WHERE id = ?').run(p(caption ?? null), p(mid)).changes);
    },

    count(opts = {}) {
      try {
        if (opts.sessionId) {
          return Number(
            stmt('SELECT COUNT(*) AS c FROM media md JOIN msg m ON m.id = md.msg_id WHERE m.session_id = ?')
              .get(p(opts.sessionId))?.c ?? 0,
          );
        }
        return Number(stmt('SELECT COUNT(*) AS c FROM media').get()?.c ?? 0);
      } catch { return 0; }
    },
  };
}

function mapWindowRow(r) {
  if (!r) return null;
  const out = {
    id: Number(r.id),
    sessionId: String(r.session_id),
    sceneId: Number(r.scene_id),
    idx: Number(r.idx),
    kind: String(r.kind ?? 'window'),
    startMsgId: Number(r.start_msg_id),
    endMsgId: Number(r.end_msg_id),
    startAt: Number(r.start_at),
    endAt: Number(r.end_at),
    msgCount: Number(r.msg_count),
    text: String(r.text ?? ''),
    vecModel: r.vec_model ?? null,
    vecDim: r.vec_dim === null || r.vec_dim === undefined ? null : Number(r.vec_dim),
  };
  if (r.scene_start_at !== undefined && r.scene_start_at !== null) out.sceneStartAt = Number(r.scene_start_at);
  if (r.scene_end_at !== undefined && r.scene_end_at !== null) out.sceneEndAt = Number(r.scene_end_at);
  if (r.scene_msg_count !== undefined && r.scene_msg_count !== null) out.sceneMsgCount = Number(r.scene_msg_count);
  return out;
}

export function createWindowExtras({ db, stmt, p, withTx, deleteVecRows }) {
  return {
    replaceForScene(sceneId, windows = []) {
      const sid = Number(sceneId);
      if (!Number.isSafeInteger(sid) || sid <= 0) return [];
      return withTx(db, () => {
        let oldIds = [];
        try {
          oldIds = stmt('SELECT id FROM window WHERE scene_id = ?').all(p(sid)).map((r) => Number(r.id));
        } catch {
          return [];
        }
        if (oldIds.length > 0) {
          deleteVecRows(db, 'window', oldIds);
          stmt('DELETE FROM window WHERE scene_id = ?').run(p(sid));
        }
        if (!Array.isArray(windows) || windows.length === 0) return [];
        const ins = stmt(
          `INSERT INTO window (session_id, scene_id, idx, kind, start_msg_id, end_msg_id, start_at, end_at, msg_count, text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const inserted = [];
        for (let i = 0; i < windows.length; i += 1) {
          const w = windows[i];
          const kind = String(w.kind ?? 'window');
          const res = ins.run(
            p(w.sessionId),
            p(sid),
            p(Number.isInteger(w.idx) ? w.idx : i),
            kind,
            p(Number(w.startMsgId)),
            p(Number(w.endMsgId)),
            p(Number(w.startAt)),
            p(Number(w.endAt)),
            p(Number(w.msgCount)),
            p(String(w.text ?? '')),
          );
          inserted.push({
            ...w,
            id: Number(res.lastInsertRowid),
            sceneId: sid,
            idx: Number.isInteger(w.idx) ? w.idx : i,
            kind,
          });
        }
        return inserted;
      });
    },

    clearForScenes(sceneIds = []) {
      const ids = [...new Set((sceneIds ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
      if (ids.length === 0) return 0;
      return withTx(db, () => {
        try {
          const ph = ids.map(() => '?').join(',');
          const winIds = db
            .prepare(`SELECT id FROM window WHERE scene_id IN (${ph})`)
            .all(...ids.map(p))
            .map((r) => Number(r.id));
          if (winIds.length > 0) deleteVecRows(db, 'window', winIds);
          return Number(db.prepare(`DELETE FROM window WHERE scene_id IN (${ph})`).run(...ids.map(p)).changes);
        } catch {
          return 0;
        }
      });
    },

    clearForSession(sessionId) {
      if (!sessionId) return 0;
      return withTx(db, () => {
        try {
          const winIds = stmt('SELECT id FROM window WHERE session_id = ?')
            .all(p(sessionId))
            .map((r) => Number(r.id));
          if (winIds.length > 0) deleteVecRows(db, 'window', winIds);
          return Number(stmt('DELETE FROM window WHERE session_id = ?').run(p(sessionId)).changes);
        } catch {
          return 0;
        }
      });
    },

    clearVecMeta(opts = {}) {
      try {
        if (opts.sessionId) {
          return Number(
            stmt('UPDATE window SET vec_model = NULL, vec_dim = NULL WHERE session_id = ? AND vec_model IS NOT NULL')
              .run(p(opts.sessionId)).changes,
          );
        }
        return Number(db.prepare('UPDATE window SET vec_model = NULL, vec_dim = NULL WHERE vec_model IS NOT NULL').run().changes);
      } catch {
        return 0;
      }
    },

    pending(opts = {}) {
      const limit = p(opts.limit ?? 500);
      try {
        if (opts.sessionId) {
          return stmt(
            `SELECT * FROM window
              WHERE session_id = ? AND vec_model IS NULL
              ORDER BY start_at ASC, id ASC
              LIMIT ?`,
          ).all(p(opts.sessionId), limit).map(mapWindowRow);
        }
        return stmt(
          `SELECT * FROM window
            WHERE vec_model IS NULL
            ORDER BY start_at ASC, id ASC
            LIMIT ?`,
        ).all(limit).map(mapWindowRow);
      } catch {
        return [];
      }
    },

    countPending(opts = {}) {
      try {
        if (opts.sessionId) {
          return Number(
            stmt('SELECT COUNT(*) AS c FROM window WHERE session_id = ? AND vec_model IS NULL')
              .get(p(opts.sessionId))?.c ?? 0,
          );
        }
        return Number(stmt('SELECT COUNT(*) AS c FROM window WHERE vec_model IS NULL').get()?.c ?? 0);
      } catch {
        return 0;
      }
    },

    markIndexed(ids, provider) {
      if (!Array.isArray(ids) || ids.length === 0) return 0;
      if (!provider?.id || !provider?.dim) return 0;
      return withTx(db, () => {
        const upd = stmt('UPDATE window SET vec_model = ?, vec_dim = ? WHERE id = ?');
        let n = 0;
        for (const id of ids) {
          n += Number(upd.run(p(provider.id), p(provider.dim), p(Number(id))).changes);
        }
        return n;
      });
    },

    count(opts = {}) {
      try {
        if (opts.sessionId) {
          return Number(
            stmt('SELECT COUNT(*) AS c FROM window WHERE session_id = ?').get(p(opts.sessionId))?.c ?? 0,
          );
        }
        return Number(stmt('SELECT COUNT(*) AS c FROM window').get()?.c ?? 0);
      } catch {
        return 0;
      }
    },

    byScene(sceneId) {
      const sid = Number(sceneId);
      if (!Number.isSafeInteger(sid) || sid <= 0) return [];
      try {
        return stmt('SELECT * FROM window WHERE scene_id = ? ORDER BY idx ASC').all(p(sid)).map(mapWindowRow);
      } catch {
        return [];
      }
    },
  };
}
