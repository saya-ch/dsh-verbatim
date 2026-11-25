/**
 * 向量库降级模式（pure-SQLite + 内存暴力余弦）管理模块。
 *
 * 当 sqlite-vec 不可用时，由本模块接管 `vec_fallback_*` 持久化表与内存 Map 缓存，
 * 并保持与 vec0 一致的 L2 distance 口径。
 */

import { withTx } from '../store/repo.js';
import {
  FALLBACK_TABLES,
  toFloat32,
  toBlob,
  dot,
  scoreToDistance,
} from './vector-math.js';

const KINDS = /** @type {const} */ (['msg', 'scene', 'chunk', 'note', 'window']);

const PK_COLS = Object.freeze({
  msg: 'msg_id',
  scene: 'scene_id',
  chunk: 'chunk_id',
  note: 'note_id',
  window: 'window_id',
});

const LOAD_LABELS = Object.freeze({
  msg: '降级表里的向量',
  scene: '降级表里的场景向量',
  chunk: '降级表里的分片向量',
  note: '降级表里的笔记向量',
  window: '降级表里的对话窗向量',
});

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {(sql: string) => any} opts.stmt
 * @param {number} opts.dim
 * @param {boolean} opts.persistFallback
 * @param {boolean} opts.hasVec
 * @param {{ warn?: (msg: string) => void }} opts.logger
 */
export function createFallbackVectorIndex({ db, stmt, dim, persistFallback, hasVec, logger }) {
  /** @type {Record<'msg'|'scene'|'chunk'|'note'|'window', Map<number, Float32Array>>} */
  const maps = {
    msg: new Map(),
    scene: new Map(),
    chunk: new Map(),
    note: new Map(),
    window: new Map(),
  };

  /** 降级落盘是否真的可用（只读库 / 建表失败就关掉，但内存索引照常工作） */
  let fallbackTableReady = false;
  let fallbackLoaded = false;

  function ensureTables() {
    if (hasVec || !persistFallback || fallbackTableReady) return fallbackTableReady;
    try {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${FALLBACK_TABLES.msg} (
           msg_id INTEGER PRIMARY KEY,
           emb    BLOB NOT NULL
         );
         CREATE TABLE IF NOT EXISTS ${FALLBACK_TABLES.scene} (
           scene_id INTEGER PRIMARY KEY,
           emb      BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${FALLBACK_TABLES.chunk} (
          chunk_id INTEGER PRIMARY KEY,
          emb      BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${FALLBACK_TABLES.note} (
          note_id INTEGER PRIMARY KEY,
          emb     BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${FALLBACK_TABLES.window} (
          window_id INTEGER PRIMARY KEY,
          emb       BLOB NOT NULL
        );`,
      );
      fallbackTableReady = true;
    } catch (error) {
      fallbackTableReady = false;
      logger.warn?.(
        `降级向量无法落盘（${error?.message ?? error}）；本次仅在内存里索引，重启后需要重建`,
      );
    }
    return fallbackTableReady;
  }

  /**
   * 首次用到降级索引时把落盘的向量读回内存，顺便清掉孤儿行
   * （msg 被 rewind 物理删掉后，降级表没有 CASCADE，靠这步收尸）。
   */
  function ensureLoaded() {
    if (fallbackLoaded || hasVec) return;
    fallbackLoaded = true;
    if (!ensureTables()) return;
    try {
      db.exec(`DELETE FROM ${FALLBACK_TABLES.msg} WHERE msg_id NOT IN (SELECT id FROM msg)`);
      db.exec(`DELETE FROM ${FALLBACK_TABLES.scene} WHERE scene_id NOT IN (SELECT id FROM scene)`);
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES.chunk} WHERE chunk_id NOT IN (SELECT id FROM chunk)`);
      } catch { /* 老库还没有 chunk 表 */ }
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES.note} WHERE note_id NOT IN (SELECT id FROM note WHERE deleted_at IS NULL)`);
      } catch { /* 老库还没有 note 表 */ }
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES.window} WHERE window_id NOT IN (SELECT id FROM window)`);
      } catch { /* 老库还没有 window 表 */ }

      for (const kind of ['msg', 'scene']) {
        const col = PK_COLS[kind];
        for (const r of stmt(`SELECT ${col}, emb FROM ${FALLBACK_TABLES[kind]}`).all()) {
          maps[kind].set(Number(r[col]), toFloat32(r.emb, dim, LOAD_LABELS[kind]));
        }
      }
      for (const kind of ['chunk', 'note', 'window']) {
        const col = PK_COLS[kind];
        try {
          for (const r of stmt(`SELECT ${col}, emb FROM ${FALLBACK_TABLES[kind]}`).all()) {
            maps[kind].set(Number(r[col]), toFloat32(r.emb, dim, LOAD_LABELS[kind]));
          }
        } catch { /* 老库还没有对应降级表 */ }
      }
    } catch (error) {
      logger.warn?.(`读取降级向量失败，改用本次进程内已索引的部分：${error?.message ?? error}`);
    }
  }

  function reloadAll() {
    for (const kind of KINDS) maps[kind].clear();
    fallbackLoaded = false;
    ensureLoaded();
  }

  /**
   * 降级模式：**落盘表才是权威，内存 Map 只是缓存**。
   * 靠大小对账来发现漂移（如 repo.deleteMsgsBySeq 直接删了持久表），一旦不等就以表为准重载。
   */
  function syncIfStale() {
    if (hasVec || !fallbackTableReady) return;
    try {
      const tableMsgs = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES.msg}`).get().c ?? 0);
      const tableScenes = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES.scene}`).get().c ?? 0);
      let tableWindows = maps.window.size;
      let tableChunks = maps.chunk.size;
      let tableNotes = maps.note.size;
      try {
        tableWindows = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES.window}`).get().c ?? 0);
      } catch { /* ignore */ }
      try {
        tableChunks = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES.chunk}`).get().c ?? 0);
      } catch { /* ignore */ }
      try {
        tableNotes = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES.note}`).get().c ?? 0);
      } catch { /* ignore */ }
      if (
        tableMsgs !== maps.msg.size
        || tableScenes !== maps.scene.size
        || tableWindows !== maps.window.size
        || tableChunks !== maps.chunk.size
        || tableNotes !== maps.note.size
      ) {
        reloadAll();
      }
    } catch {
      // 表读不到就按现有内存索引继续用，别把查询搞崩
    }
  }

  function mapOf(kind) {
    return maps[kind];
  }

  function count(kind) {
    ensureLoaded();
    syncIfStale();
    return maps[kind].size;
  }

  function insertUnsafe(kind, id, vector) {
    maps[kind].set(Number(id), vector);
    if (ensureTables()) {
      stmt(`INSERT INTO ${FALLBACK_TABLES[kind]} (${PK_COLS[kind]}, emb) VALUES (?, ?)`)
        .run(Number(id), toBlob(vector));
    }
  }

  function upsertUnsafe(kind, id, vector) {
    maps[kind].set(Number(id), vector);
    if (ensureTables()) {
      stmt(`INSERT OR REPLACE INTO ${FALLBACK_TABLES[kind]} (${PK_COLS[kind]}, emb) VALUES (?, ?)`)
        .run(Number(id), toBlob(vector));
    }
  }

  function deleteOne(kind, id) {
    ensureLoaded();
    const existed = maps[kind].delete(Number(id));
    if (ensureTables()) {
      stmt(`DELETE FROM ${FALLBACK_TABLES[kind]} WHERE ${PK_COLS[kind]} = ?`).run(Number(id));
    }
    return existed ? 1 : 0;
  }

  function deleteIds(kind, ids, { countRemovedByExistence = false, ignoreErrors = false } = {}) {
    ensureLoaded();
    let removed = 0;
    withTx(db, () => {
      const tableReady = ensureTables();
      const del = tableReady ? stmt(`DELETE FROM ${FALLBACK_TABLES[kind]} WHERE ${PK_COLS[kind]} = ?`) : null;
      for (const id of ids) {
        try {
          const existed = maps[kind].delete(id);
          if (del) del.run(id);
          if (!countRemovedByExistence || existed) removed += 1;
        } catch (err) {
          if (!ignoreErrors) throw err;
        }
      }
    });
    return removed;
  }

  function clear(kind, { ensureFirst = false, ignoreErrors = false } = {}) {
    if (ensureFirst) ensureLoaded();
    maps[kind].clear();
    if (ensureTables()) {
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES[kind]}`);
      } catch (err) {
        if (!ignoreErrors) throw err;
      }
    }
  }

  function knn(kind, query, k) {
    ensureLoaded();
    const source = maps[kind];
    const out = [];
    for (const [id, vec] of source) {
      const score = dot(query, vec);
      out.push({ id, distance: scoreToDistance(score) });
    }
    out.sort((a, b) => a.distance - b.distance || a.id - b.id);
    return out.slice(0, k);
  }

  function getVecs(kind, ids) {
    ensureLoaded();
    const out = new Map();
    for (const id of ids) {
      const v = maps[kind].get(id);
      if (v) out.set(id, v);
    }
    return out;
  }

  function missingIds(kind, ids) {
    ensureLoaded();
    syncIfStale();
    return ids.filter((id) => !maps[kind].has(id));
  }

  function pruneOrphans() {
    const removed = { msgVectors: 0, sceneVectors: 0, chunkVectors: 0, windowVectors: 0 };
    ensureLoaded();
    if (!ensureTables()) {
      const msgIds = new Set(stmt('SELECT id FROM msg').all().map((r) => Number(r.id)));
      for (const id of [...maps.msg.keys()]) {
        if (!msgIds.has(id)) {
          maps.msg.delete(id);
          removed.msgVectors += 1;
        }
      }
      const sceneIds = new Set(stmt('SELECT id FROM scene').all().map((r) => Number(r.id)));
      for (const id of [...maps.scene.keys()]) {
        if (!sceneIds.has(id)) {
          maps.scene.delete(id);
          removed.sceneVectors += 1;
        }
      }
      return removed;
    }
    withTx(db, () => {
      removed.msgVectors = Number(
        stmt(`DELETE FROM ${FALLBACK_TABLES.msg} WHERE msg_id NOT IN (SELECT id FROM msg)`).run().changes,
      );
      removed.sceneVectors = Number(
        stmt(`DELETE FROM ${FALLBACK_TABLES.scene} WHERE scene_id NOT IN (SELECT id FROM scene)`).run().changes,
      );
      try {
        removed.chunkVectors = Number(
          stmt(`DELETE FROM ${FALLBACK_TABLES.chunk} WHERE chunk_id NOT IN (SELECT id FROM chunk)`).run().changes,
        );
      } catch { /* 没有 chunk 降级表 */ }
      try {
        removed.windowVectors = Number(
          stmt(`DELETE FROM ${FALLBACK_TABLES.window} WHERE window_id NOT IN (SELECT id FROM window)`).run().changes,
        );
      } catch { /* 没有 window 降级表 */ }
    });
    reloadAll();
    return removed;
  }

  return {
    ensureTables,
    ensureLoaded,
    syncIfStale,
    isTableReady: () => fallbackTableReady,
    mapOf,
    count,
    insertUnsafe,
    upsertUnsafe,
    deleteOne,
    deleteIds,
    clear,
    knn,
    getVecs,
    missingIds,
    pruneOrphans,
  };
}
