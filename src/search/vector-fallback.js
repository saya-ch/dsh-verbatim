// @ts-check
/**
 * 向量库降级模式（pure-SQLite + 内存暴力余弦）管理模块。
 *
 * 当 sqlite-vec 不可用时，由本模块接管 `vec_fallback_*` 持久化表与按类懒加载内存 Map 缓存，
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

const ORPHAN_PRUNE_SQL = Object.freeze({
  msg: `DELETE FROM ${FALLBACK_TABLES.msg} WHERE msg_id NOT IN (SELECT id FROM msg)`,
  scene: `DELETE FROM ${FALLBACK_TABLES.scene} WHERE scene_id NOT IN (SELECT id FROM scene)`,
  chunk: `DELETE FROM ${FALLBACK_TABLES.chunk} WHERE chunk_id NOT IN (SELECT id FROM chunk)`,
  note: `DELETE FROM ${FALLBACK_TABLES.note} WHERE note_id NOT IN (SELECT id FROM note WHERE deleted_at IS NULL)`,
  window: `DELETE FROM ${FALLBACK_TABLES.window} WHERE window_id NOT IN (SELECT id FROM window)`,
});

const DEFAULT_MAX_FALLBACK_VECTORS = 50_000;

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {(sql: string) => any} opts.stmt
 * @param {number} opts.dim
 * @param {boolean} opts.persistFallback
 * @param {boolean} opts.hasVec
 * @param {number} [opts.maxVectors]
 * @param {{ warn?: (msg: string) => void }} opts.logger
 */
export function createFallbackVectorIndex({
  db,
  stmt,
  dim,
  persistFallback,
  hasVec,
  maxVectors = DEFAULT_MAX_FALLBACK_VECTORS,
  logger,
}) {
  const cap = Number.isFinite(maxVectors) && maxVectors > 0 ? Math.trunc(maxVectors) : DEFAULT_MAX_FALLBACK_VECTORS;
  /** @type {Record<'msg'|'scene'|'chunk'|'note'|'window', Map<number, Float32Array>>} */
  const maps = {
    msg: new Map(),
    scene: new Map(),
    chunk: new Map(),
    note: new Map(),
    window: new Map(),
  };

  /** 按 kind 懒加载标记：只加载实际被用到的表，避免全库 5 表冷启动 */
  /** @type {Record<'msg'|'scene'|'chunk'|'note'|'window', boolean>} */
  const loadedKinds = {
    msg: false,
    scene: false,
    chunk: false,
    note: false,
    window: false,
  };

  /** 若表内向量数超过 cap，则只保留 LRU 热缓存并按需从 SQLite 流式读取 */
  /** @type {Record<'msg'|'scene'|'chunk'|'note'|'window', boolean>} */
  const cappedKinds = {
    msg: false,
    scene: false,
    chunk: false,
    note: false,
    window: false,
  };

  /** @param {'msg'|'scene'|'chunk'|'note'|'window'} kind @param {number} id @param {Float32Array} vec */
  function lruSet(kind, id, vec) {
    const m = maps[kind];
    if (m.has(id)) m.delete(id);
    m.set(id, vec);
    while (fallbackTableReady && m.size > cap) {
      cappedKinds[kind] = true;
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  /** 降级落盘是否真的可用（只读库 / 建表失败就关掉，但内存索引照常工作） */
  let fallbackTableReady = false;

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
   * 按 kind 懒加载落盘的降级向量，顺便清理该表的孤儿行。
   * 未传 kind 时加载全部 5 类。
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} [kind]
   */
  function ensureLoaded(kind) {
    if (hasVec) return;
    if (!kind) {
      for (const k of KINDS) ensureLoaded(k);
      return;
    }
    if (loadedKinds[kind]) return;
    loadedKinds[kind] = true;
    if (!ensureTables()) return;
    const optional = kind === 'chunk' || kind === 'note' || kind === 'window';
    try {
      try {
        db.exec(ORPHAN_PRUNE_SQL[kind]);
      } catch (err) {
        if (!optional) throw err;
      }
      const col = PK_COLS[kind];
      try {
        const total = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES[kind]}`).get()?.c ?? 0);
        if (total > cap) {
          cappedKinds[kind] = true;
          for (const r of stmt(`SELECT ${col}, emb FROM ${FALLBACK_TABLES[kind]} ORDER BY ${col} DESC LIMIT ?`).all(cap)) {
            lruSet(kind, Number(r[col]), toFloat32(r.emb, dim, LOAD_LABELS[kind]));
          }
        } else {
          cappedKinds[kind] = false;
          for (const r of stmt(`SELECT ${col}, emb FROM ${FALLBACK_TABLES[kind]}`).all()) {
            maps[kind].set(Number(r[col]), toFloat32(r.emb, dim, LOAD_LABELS[kind]));
          }
        }
      } catch (err) {
        if (!optional) throw err;
      }
    } catch (error) {
      logger.warn?.(`读取降级向量失败，改用本次进程内已索引的部分：${error?.message ?? error}`);
    }
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} [kind]
   */
  function reloadKind(kind) {
    if (!kind) {
      for (const k of KINDS) reloadKind(k);
      return;
    }
    maps[kind].clear();
    loadedKinds[kind] = false;
    ensureLoaded(kind);
  }

  /**
   * 降级模式：**落盘表才是权威，内存 Map 只是缓存**。
   * 按 kind 对账单表 COUNT(*)，避免每次检查都扫 5 张表。
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} [kind]
   */
  function syncIfStale(kind) {
    if (hasVec || !fallbackTableReady) return;
    if (!kind) {
      for (const k of KINDS) {
        if (loadedKinds[k]) syncIfStale(k);
      }
      return;
    }
    try {
      const tableCount = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES[kind]}`).get().c ?? 0);
      if (cappedKinds[kind]) return;
      if (tableCount !== maps[kind].size) {
        reloadKind(kind);
      }
    } catch {
      // 表读不到就按现有内存索引继续用，别把查询搞崩
    }
  }

  /** @param {'msg'|'scene'|'chunk'|'note'|'window'} kind */
  function mapOf(kind) {
    ensureLoaded(kind);
    return maps[kind];
  }

  /** @param {'msg'|'scene'|'chunk'|'note'|'window'} kind */
  function count(kind) {
    ensureLoaded(kind);
    if (cappedKinds[kind] && fallbackTableReady) {
      try {
        return Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES[kind]}`).get()?.c ?? maps[kind].size);
      } catch {
        return maps[kind].size;
      }
    }
    syncIfStale(kind);
    return maps[kind].size;
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {number|bigint} id
   * @param {Float32Array} vector
   */
  function insertUnsafe(kind, id, vector) {
    lruSet(kind, Number(id), vector);
    if (ensureTables()) {
      stmt(`INSERT INTO ${FALLBACK_TABLES[kind]} (${PK_COLS[kind]}, emb) VALUES (?, ?)`)
        .run(Number(id), toBlob(vector));
    }
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {number|bigint} id
   * @param {Float32Array} vector
   */
  function upsertUnsafe(kind, id, vector) {
    lruSet(kind, Number(id), vector);
    if (ensureTables()) {
      stmt(`INSERT OR REPLACE INTO ${FALLBACK_TABLES[kind]} (${PK_COLS[kind]}, emb) VALUES (?, ?)`)
        .run(Number(id), toBlob(vector));
    }
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {number|bigint} id
   */
  function deleteOne(kind, id) {
    ensureLoaded(kind);
    const existed = maps[kind].delete(Number(id));
    if (ensureTables()) {
      const changes = Number(stmt(`DELETE FROM ${FALLBACK_TABLES[kind]} WHERE ${PK_COLS[kind]} = ?`).run(Number(id)).changes ?? 0);
      return existed || changes > 0 ? 1 : 0;
    }
    return existed ? 1 : 0;
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {number[]} ids
   * @param {{ countRemovedByExistence?: boolean, ignoreErrors?: boolean }} [opts]
   */
  function deleteIds(kind, ids, { countRemovedByExistence = false, ignoreErrors = false } = {}) {
    ensureLoaded(kind);
    let removed = 0;
    withTx(db, () => {
      const tableReady = ensureTables();
      const del = tableReady ? stmt(`DELETE FROM ${FALLBACK_TABLES[kind]} WHERE ${PK_COLS[kind]} = ?`) : null;
      for (const id of ids) {
        try {
          const existed = maps[kind].delete(id);
          const changes = del ? Number(del.run(id).changes ?? 0) : 0;
          if (!countRemovedByExistence || existed || changes > 0) removed += 1;
        } catch (err) {
          if (!ignoreErrors) throw err;
        }
      }
    });
    return removed;
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {{ ensureFirst?: boolean, ignoreErrors?: boolean }} [opts]
   */
  function clear(kind, { ensureFirst = false, ignoreErrors = false } = {}) {
    if (ensureFirst) ensureLoaded(kind);
    maps[kind].clear();
    cappedKinds[kind] = false;
    if (ensureTables()) {
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES[kind]}`);
      } catch (err) {
        if (!ignoreErrors) throw err;
      }
    }
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {Float32Array} query
   * @param {number} k
   */
  function knn(kind, query, k) {
    ensureLoaded(kind);
    const out = [];
    if (cappedKinds[kind] && fallbackTableReady) {
      const col = PK_COLS[kind];
      for (const r of stmt(`SELECT ${col} AS id, emb FROM ${FALLBACK_TABLES[kind]}`).iterate()) {
        const id = Number(r.id);
        const vec = toFloat32(/** @type {Uint8Array} */ (r.emb), dim, LOAD_LABELS[kind]);
        const score = dot(query, vec);
        out.push({ id, distance: scoreToDistance(score) });
      }
    } else {
      const source = maps[kind];
      for (const [id, vec] of source) {
        const score = dot(query, vec);
        out.push({ id, distance: scoreToDistance(score) });
      }
    }
    out.sort((a, b) => a.distance - b.distance || a.id - b.id);
    return out.slice(0, k);
  }

  /**
   * 仅对预过滤后的 id 集合计算余弦相似度；若缓存已达上限，则分片从 SQLite 补齐缺失向量并写入 LRU。
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {Float32Array} query
   * @param {Iterable<number>} ids
   * @param {number|null} [minScore]
   */
  function knnForIds(kind, query, ids, minScore = null) {
    ensureLoaded(kind);
    const m = maps[kind];
    const out = [];
    const missing = [];
    for (const id of ids) {
      const vec = m.get(id);
      if (vec) {
        const score = dot(query, vec);
        if (minScore === null || score >= minScore) {
          out.push({ id, distance: scoreToDistance(score) });
        }
      } else if (cappedKinds[kind] && fallbackTableReady) {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      const col = PK_COLS[kind];
      for (let i = 0; i < missing.length; i += 400) {
        const slice = missing.slice(i, i + 400);
        const ph = new Array(slice.length).fill('?').join(', ');
        const rows = db.prepare(`SELECT ${col} AS id, emb FROM ${FALLBACK_TABLES[kind]} WHERE ${col} IN (${ph})`).all(...slice);
        for (const r of rows) {
          const id = Number(r.id);
          const vec = toFloat32(/** @type {Uint8Array} */ (r.emb), dim, LOAD_LABELS[kind]);
          lruSet(kind, id, vec);
          const score = dot(query, vec);
          if (minScore === null || score >= minScore) {
            out.push({ id, distance: scoreToDistance(score) });
          }
        }
      }
    }
    out.sort((a, b) => a.distance - b.distance || a.id - b.id);
    return out;
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {number[]} ids
   */
  function getVecs(kind, ids) {
    ensureLoaded(kind);
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      const v = maps[kind].get(id);
      if (v) out.set(id, v);
      else if (cappedKinds[kind] && fallbackTableReady) missing.push(id);
    }
    if (missing.length > 0) {
      const col = PK_COLS[kind];
      for (let i = 0; i < missing.length; i += 400) {
        const slice = missing.slice(i, i + 400);
        const ph = new Array(slice.length).fill('?').join(', ');
        const rows = db.prepare(`SELECT ${col} AS id, emb FROM ${FALLBACK_TABLES[kind]} WHERE ${col} IN (${ph})`).all(...slice);
        for (const r of rows) {
          const id = Number(r.id);
          const vec = toFloat32(/** @type {Uint8Array} */ (r.emb), dim, LOAD_LABELS[kind]);
          lruSet(kind, id, vec);
          out.set(id, vec);
        }
      }
    }
    return out;
  }

  /**
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {number[]} ids
   */
  function missingIds(kind, ids) {
    ensureLoaded(kind);
    if (cappedKinds[kind] && fallbackTableReady) {
      const present = new Set();
      const col = PK_COLS[kind];
      for (let i = 0; i < ids.length; i += 400) {
        const slice = ids.slice(i, i + 400);
        const ph = new Array(slice.length).fill('?').join(', ');
        const rows = db.prepare(`SELECT ${col} AS id FROM ${FALLBACK_TABLES[kind]} WHERE ${col} IN (${ph})`).all(...slice);
        for (const r of rows) present.add(Number(r.id));
      }
      return ids.filter((id) => !present.has(id));
    }
    syncIfStale(kind);
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
    reloadKind();
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
    knnForIds,
    getVecs,
    missingIds,
    pruneOrphans,
  };
}
