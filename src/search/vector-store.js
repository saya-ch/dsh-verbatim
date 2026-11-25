// @ts-check
/**
 * 向量索引封装 —— sqlite-vec（vec0）为主，暴力余弦为降级路径
 *
 * 规格来源：
 *   - IMPLEMENTATION.md §1「向量索引：sqlite-vec」（三个坑 + KNN 写法）
 *   - BUILD-PLAN.md §4.4（双索引 vec_msg / vec_scene + 增量 + 降级）
 *   - DECISIONS.md D-144（1024 维）/ D-145（不用 int8）/ D-148 / D-149 / D-150 / D-152
 *
 * 本模块只做一件事：把「一条消息 / 一场聊天」变成一个能在毫秒级被问出来的向量，
 * 并且**两条路径（vec0 / 暴力余弦）必须给出同一个 top-k**。
 *
 * 四个硬约束（踩过才知道）：
 *
 * ① **主键必须 BigInt**（D-149 坑②）
 *    `insVec.run(BigInt(msgId), blob)`；传 Number 报
 *    "Only integers are allows for primary key values on vec_msg"。
 *    KNN 里的 `k` 反而两种都行（实测 v0.1.9），这里统一传 Number，读起来清楚。
 *
 * ② **时间过滤必须放外层**（D-150）
 *    vec0 的 WHERE 只认 `MATCH` + `k`。所以流程固定为：
 *      第一段：vec0 只做 KNN，取回候选 id + distance
 *      第二段：外层 SQL `JOIN msg` 之后才 `WHERE m.at BETWEEN ...`
 *    再把两者用 ??? 那套"先取 k 再过滤"会导致过滤后空结果，所以按 overFetch
 *    倍数多取一点候选（默认 8 倍），这是唯一偏离文档的地方，且只多取不改变顺序。
 *
 * ③ **向量必须先 L2 归一化**（T5 在 MRL 截断后已归一化，这里再归一化一次是幂等的）
 *    因为 vec0 默认用 **L2 距离**，而 schema.sql 已经定了 `emb float[1024]`（没有
 *    distance_metric=cosine）。对单位向量有恒等式：
 *        L2² = 2 - 2·cos   ⇒   cos = 1 - distance² / 2
 *    于是 vec0 的 distance 可以无损换算成余弦，跟暴力余弦路径**同一个分数口径**。
 *    如果入库向量没归一化，这个换算就不成立、两条路径的排序也会不一致 ——
 *    所以归一化放在本模块内部，调用方不用管。
 *
 * ④ **降级必须等价，不只是"接口不变"**
 *    hasVec=false 时在内存里算点积（单位向量下点积 = 余弦），并且把
 *    distance 也换算成同样的 L2 假距离，这样分数、顺序、字段全部对齐。
 *    另外（可选，默认开）把降级向量落到普通 BLOB 表 `vec_fallback_msg/scene`：
 *    否则进程重启后 `msg.vec_model` 已经有值 ⇒ `vecMeta.pending()` 认为"都索引过了"
 *    ⇒ 内存索引永远空着，向量路静默失效。这是降级路径唯一真正危险的地方。
 *    仅在 hasVec=false 时才会创建这两张表，正常环境不碰库结构。
 */

import { DatabaseSync } from 'node:sqlite';

import { withTx } from '../store/repo.js';
import {
  DEFAULT_DIM,
  DEFAULT_OVER_FETCH,
  FALLBACK_TABLES,
  toFloat32,
  normalizeVector,
  toBlob,
  dot,
  distanceToScore,
  scoreToDistance,
} from './vector-math.js';
import { createFallbackVectorIndex } from './vector-fallback.js';
import {
  placeholders,
  queryByIds,
  createVectorHydrator,
} from './vector-hydrate.js';

export {
  DEFAULT_DIM,
  DEFAULT_OVER_FETCH,
  FALLBACK_TABLES,
  normalizeVector,
  toBlob,
  dot,
  distanceToScore,
  scoreToDistance,
};

/* ============================== 主体 ============================== */

/**
 * 创建向量索引。
 *
 * @param {DatabaseSync | { db: DatabaseSync, hasVec?: boolean }} handle openDb() 的返回值或裸 db
 * @param {{
 *   dim?: number,               // 默认 1024（D-144）
 *   hasVec?: boolean,           // 强制指定扩展可用性（测试用）；不传则自行探测
 *   overFetch?: number,         // KNN 候选放大倍数，默认 8
 *   persistFallback?: boolean,  // 降级向量是否落普通 BLOB 表，默认 true
 *   logger?: { warn(msg: string): void },
 * }} [options]
 */
export function createVectorStore(handle, options = {}) {
  const db = handle instanceof DatabaseSync ? handle : handle?.db;
  if (!db) throw new TypeError('createVectorStore: 需要 DatabaseSync 实例或 openDb() 返回的 handle');

  const dim = options.dim ?? DEFAULT_DIM;
  if (!Number.isInteger(dim) || dim <= 0) throw new TypeError(`dim 必须是正整数，收到 ${dim}`);

  const overFetch = Math.max(1, Math.floor(options.overFetch ?? DEFAULT_OVER_FETCH));
  const logger = options.logger ?? { warn: () => {} };
  const persistFallback = options.persistFallback !== false;

  /** 预编译语句缓存（按 SQL 文本复用，和 store 层同一套做法） */
  const stmtCache = new Map();
  function stmt(sql) {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmtCache.set(sql, s);
    }
    return s;
  }

  /** 表是否存在 */
  function tableExists(name) {
    try {
      return Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name),
      );
    } catch {
      return false;
    }
  }

  /** vec 表声明的维度（从 sqlite_master 的 DDL 里抠 `float[N]`） */
  function declaredDim(table) {
    try {
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table);
      const m = /float\[(\d+)\]/i.exec(String(row?.sql ?? ''));
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  /* --------------------------- 可用性探测 --------------------------- */

  /**
   * 判断本进程能不能用 vec0：表存在 + 扩展已加载（空 KNN 能跑通）。
   * 永不抛异常 —— 探测失败就是"降级"，不是错误（IMPLEMENTATION.md §1 降级路径）。
   */
  function probeHasVec() {
    if (options.hasVec === false) return false;
    if (!tableExists('vec_msg')) return false;
    if (options.hasVec === true) return true;
    if (typeof handle === 'object' && handle !== null && 'hasVec' in handle && handle.hasVec) return true;
    try {
      const empty = new Uint8Array(dim * 4);
      stmt('SELECT msg_id, distance FROM vec_msg WHERE emb MATCH ? AND k = ?').all(empty, 1);
      return true;
    } catch {
      return false;
    }
  }

  const hasVec = probeHasVec();
  const mode = hasVec ? 'vec0' : 'bruteforce';

  // 维度对不上比"查不到"更危险（D-152）：宁可开库就报清楚
  if (hasVec) {
    const dd = declaredDim('vec_msg');
    if (dd && dd !== dim) {
      throw new Error(
        `向量维度不一致：库里 vec_msg 是 float[${dd}]，当前向量是 ${dim} 维。` +
          '不同维度的向量不可比，请重建向量索引或改回对应维度（D-144 定的是 1024）。',
      );
    }
  } else {
    logger.warn(
      `sqlite-vec 不可用，向量路降级为暴力余弦（接口不变，结果与 vec0 一致）：维度 ${dim}`,
    );
  }

  /* ---------------- 降级模式的内存索引 + 可选落盘 ---------------- */

  const fallback = createFallbackVectorIndex({
    db,
    stmt,
    dim,
    persistFallback,
    hasVec,
    logger,
  });

  if (!hasVec) fallback.ensureLoaded();

  /* ---------------------------- 写入 ---------------------------- */

  /** 主键校验：vec0 只吃整数，且必须转 BigInt（D-149 坑②） */
  function pk(id, what) {
    const n = Number(id); // BigInt 也能走 sum：Number(7n) === 7
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new TypeError(`${what}: 主键必须是安全整数，收到 ${String(id)}`);
    }
    return BigInt(n); // ← 这一步不做就报 "Only integers are allows for primary key values"
  }

  function insertMsgVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('INSERT INTO vec_msg (msg_id, emb) VALUES (?, ?)').run(pk(id, 'insertMsgVec'), toBlob(vector));
    } else {
      fallback.insertUnsafe('msg', id, vector);
    }
  }

  function upsertMsgVecUnsafe(id, vector) {
    if (hasVec) {
      // vec0 的主键不支持 INSERT OR REPLACE（实测报 UNIQUE constraint failed），
      // 只能先删再插 —— 这两步必须同一个事务，否则中途崩了会丢一条向量。
      stmt('DELETE FROM vec_msg WHERE msg_id = ?').run(pk(id, 'upsertMsgVec'));
      stmt('INSERT INTO vec_msg (msg_id, emb) VALUES (?, ?)').run(pk(id, 'upsertMsgVec'), toBlob(vector));
    } else {
      fallback.upsertUnsafe('msg', id, vector);
    }
  }

  /* ── 长文本分片向量（D-247）：rowid = chunk.id ── */

  function insertChunkVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('INSERT INTO vec_chunk (chunk_id, emb) VALUES (?, ?)').run(pk(id, 'insertChunkVec'), toBlob(vector));
    } else {
      fallback.insertUnsafe('chunk', id, vector);
    }
  }

  function upsertChunkVecUnsafe(id, vector) {
    if (hasVec) {
      // 同 msg 的 upsert：vec0 主键不支持 INSERT OR REPLACE，先删再插
      stmt('DELETE FROM vec_chunk WHERE chunk_id = ?').run(pk(id, 'upsertChunkVec'));
      stmt('INSERT INTO vec_chunk (chunk_id, emb) VALUES (?, ?)').run(pk(id, 'upsertChunkVec'), toBlob(vector));
    } else {
      fallback.upsertUnsafe('chunk', id, vector);
    }
  }

  function countChunkVec() {
    if (hasVec) {
      try {
        return Number(stmt('SELECT COUNT(*) AS c FROM vec_chunk').get()?.c ?? 0);
      } catch {
        return 0;
      }
    }
    return fallback.count('chunk');
  }

  function insertSceneVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('INSERT INTO vec_scene (scene_id, emb) VALUES (?, ?)').run(pk(id, 'insertSceneVec'), toBlob(vector));
    } else {
      fallback.insertUnsafe('scene', id, vector);
    }
  }

  function upsertSceneVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('DELETE FROM vec_scene WHERE scene_id = ?').run(pk(id, 'upsertSceneVec'));
      stmt('INSERT INTO vec_scene (scene_id, emb) VALUES (?, ?)').run(pk(id, 'upsertSceneVec'), toBlob(vector));
    } else {
      fallback.upsertUnsafe('scene', id, vector);
    }
  }

  function upsertNoteVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('DELETE FROM vec_note WHERE note_id = ?').run(pk(id, 'upsertNoteVec'));
      stmt('INSERT INTO vec_note (note_id, emb) VALUES (?, ?)').run(pk(id, 'upsertNoteVec'), toBlob(vector));
    } else {
      fallback.upsertUnsafe('note', id, vector);
    }
  }

  function upsertWindowVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('DELETE FROM vec_window WHERE window_id = ?').run(pk(id, 'upsertWindowVec'));
      stmt('INSERT INTO vec_window (window_id, emb) VALUES (?, ?)').run(pk(id, 'upsertWindowVec'), toBlob(vector));
    } else {
      fallback.upsertUnsafe('window', id, vector);
    }
  }

  function countWindowVec() {
    if (hasVec) {
      try {
        return Number(stmt('SELECT COUNT(*) AS c FROM vec_window').get()?.c ?? 0);
      } catch {
        return 0;
      }
    }
    return fallback.count('window');
  }

  /* ---------------------------- 候选召回 ---------------------------- */

  /**
   * 第一段：只做 KNN，拿 { id, distance } —— **不带任何业务过滤**（D-150）。
   *
   * @param {'msg'|'scene'|'chunk'|'note'|'window'} kind
   * @param {Float32Array} query 已归一化
   * @param {number} fetch 要多取几条
   * @returns {{id: number, distance: number}[]} distance 升序
   */
  function candidates(kind, query, fetch) {
    const total = kind === 'msg'
      ? countMsgVec()
      : kind === 'chunk'
        ? countChunkVec()
        : kind === 'note'
          ? countNoteVec()
          : kind === 'window'
            ? countWindowVec()
            : countSceneVec();
    if (total === 0 || fetch <= 0) return [];
    const k = Math.min(total, Math.max(1, Math.floor(fetch)));
    const blob = toBlob(query);

    if (hasVec) {
      const table = kind === 'msg'
        ? 'vec_msg'
        : kind === 'chunk'
          ? 'vec_chunk'
          : kind === 'note'
            ? 'vec_note'
            : kind === 'window'
              ? 'vec_window'
              : 'vec_scene';
      const col = kind === 'msg'
        ? 'msg_id'
        : kind === 'chunk'
          ? 'chunk_id'
          : kind === 'note'
            ? 'note_id'
            : kind === 'window'
              ? 'window_id'
              : 'scene_id';
      const rows = stmt(`SELECT ${col} AS id, distance FROM ${table} WHERE emb MATCH ? AND k = ?`).all(blob, k);
      return rows
        .map((r) => ({ id: Number(r.id), distance: Number(r.distance) }))
        .sort((a, b) => a.distance - b.distance || a.id - b.id);
    }

    // 降级：内存暴力余弦（单位向量下点积就是余弦）
    return fallback.knn(kind, query, k);
  }

  const {
    prefilterFallbackIds,
    hydrateMsgs,
    hydrateScenes,
    hydrateNotes,
    hydrateChunks,
    hydrateWindows,
  } = createVectorHydrator(db);

  /* ------------------------------ 计数 ------------------------------ */

  function countMsgVec() {
    if (hasVec) return Number(stmt('SELECT COUNT(*) AS c FROM vec_msg').get().c ?? 0);
    return fallback.count('msg');
  }

  function countSceneVec() {
    if (hasVec) return Number(stmt('SELECT COUNT(*) AS c FROM vec_scene').get().c ?? 0);
    return fallback.count('scene');
  }

  function countNoteVec() {
    if (hasVec) {
      try {
        return Number(stmt('SELECT COUNT(*) AS c FROM vec_note').get().c ?? 0);
      } catch {
        return 0;
      }
    }
    return fallback.count('note');
  }

  /**
   * 统一的过滤型 KNN 召回器：
   * - vec0 模式：若外层条件（如 sessionId / 时间范围）过滤后不足 want 条，渐进扩大 overFetch 再查，
   *   避免多会话大库场景下小会话被全局 Top-8k 挤掉而漏召回。
   * - 降级模式：先按 sessionId/时间在 SQLite 预过滤候选 ID，再对命中范围算 dot 排序，
   *   避免多会话大库下对无关会话全量计算点积。
   */
  /**
   * @param {{
   *   kind: 'msg'|'scene'|'chunk'|'note'|'window',
   *   query: any,
   *   want: number,
   *   total: number,
   *   filter?: { overFetch?: number, minScore?: number, [key: string]: any },
   *   hydrate: (ids: number[], filter: any) => Map<number, any>,
   *   buildHit: (row: any, c: { id: number, distance: number }, score: number, rank: number) => any,
   * }} args
   */
  function runFilteredKnn({ kind, query, want, total, filter = {}, hydrate, buildHit }) {
    if (total === 0) return [];
    const q = normalizeVector(query, dim, '查询向量');
    const baseFactor = filter.overFetch ?? overFetch;
    const minScore = Number.isFinite(filter.minScore) ? filter.minScore : null;

    if (!hasVec) {
      fallback.ensureLoaded();
      const source = fallback.mapOf(kind);
      const allowed = prefilterFallbackIds(kind, filter, source.size);
      if (allowed && allowed.size === 0) return [];

      let allCands;
      if (allowed) {
        allCands = [];
        for (const id of allowed) {
          const vec = source.get(id);
          if (!vec) continue;
          const score = dot(q, vec);
          if (minScore !== null && score < minScore) continue;
          allCands.push({ id, distance: scoreToDistance(score) });
        }
        allCands.sort((a, b) => a.distance - b.distance || a.id - b.id);
      } else {
        allCands = candidates(kind, q, total);
      }

      const batchSize = Math.max(want * 4, 64);
      const out = [];
      for (let offset = 0; offset < allCands.length && out.length < want; offset += batchSize) {
        const slice = allCands.slice(offset, offset + batchSize);
        const rows = hydrate(slice.map((c) => c.id), filter);
        for (const c of slice) {
          const row = rows.get(c.id);
          if (!row) continue;
          const score = distanceToScore(c.distance);
          if (minScore !== null && score < minScore) {
            return out;
          }
          out.push(buildHit(row, c, score, out.length + 1));
          if (out.length >= want) break;
        }
      }
      return out;
    }

    const maxFetch = Math.min(total, Math.max(16384, want * 256));
    let fetch = Math.min(total, Math.max(1, Math.ceil(want * baseFactor)));
    const seenIds = new Set();
    const out = [];

    while (true) {
      const cands = candidates(kind, q, fetch);
      const fresh = cands.filter((c) => !seenIds.has(c.id));
      for (const c of fresh) seenIds.add(c.id);

      if (fresh.length > 0) {
        const rows = hydrate(fresh.map((c) => c.id), filter);
        for (const c of fresh) {
          const row = rows.get(c.id);
          if (!row) continue;
          const score = distanceToScore(c.distance);
          if (minScore !== null && score < minScore) {
            return out;
          }
          out.push(buildHit(row, c, score, out.length + 1));
          if (out.length >= want) return out;
        }
      }

      if (cands.length < fetch || fetch >= maxFetch) break;
      const nextFetch = Math.min(maxFetch, fetch * 4);
      if (nextFetch <= fetch) break;
      fetch = nextFetch;
    }

    return out;
  }

  /* ------------------------------ 对外 ------------------------------ */

  const store = {
    /** sqlite-vec 是否可用（false 表示走暴力余弦降级） */
    hasVec,
    /** 'vec0' | 'bruteforce' */
    mode,
    /** 维度 */
    dim,

    /* —— 写入 —— */

    /**
     * 写入一条消息向量（已存在会报 UNIQUE，重复写请用 upsertMsgVec）。
     * @param {number} msgId
     * @param {Float32Array|number[]|Uint8Array} vector
     */
    insertMsgVec(msgId, vector) {
      insertMsgVecUnsafe(msgId, normalizeVector(vector, dim, `msg ${msgId} 的向量`));
    },

    /** 幂等写：有就覆盖（vec0 不支持 INSERT OR REPLACE，内部是事务里的删+插） */
    upsertMsgVec(msgId, vector) {
      withTx(db, () => upsertMsgVecUnsafe(msgId, normalizeVector(vector, dim, `msg ${msgId} 的向量`)));
    },

    /**
     * 批量写入（索引构建走这条：一个事务，快一个数量级）。
     * @param {Iterable<[number, Float32Array|number[]|Uint8Array]>} entries
     * @returns {number} 写入条数
     */
    insertMsgVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `msg ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) insertMsgVecUnsafe(id, v);
      });
      return list.length;
    },

    /** 批量幂等写（重建/补索引走这条） */
    upsertMsgVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `msg ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) upsertMsgVecUnsafe(id, v);
      });
      return list.length;
    },

    /**
     * 删一批消息向量（rewind 用）。
     *
     * **持 store 的调用方在 repo 删完消息之后要再调一次这个**：
     * repo 清的是持久化那份（vec0 虚表 + 降级表），而这个函数额外把
     * **本进程内存里的降级索引**一起清掉 —— 降级模式下 `msgVectors` 是
     * 独立的一份拷贝，不删就会留着一堆指向已删消息的向量
     * （数量统计会偏大，而且 v5 之前 id 复用时会被认到新消息上）。
     * 两个都调是幂等的，多调一次不会错。
     *
     * @param {number[]} msgIds
     * @returns {number} 删掉的条数（内存/虚表口径）
     */
    deleteMsgVecs(msgIds) {
      const ids = (Array.isArray(msgIds) ? msgIds : []).map(Number).filter((n) => Number.isSafeInteger(n));
      if (ids.length === 0) return 0;
      if (hasVec) {
        let removed = 0;
        withTx(db, () => {
          const del = stmt('DELETE FROM vec_msg WHERE msg_id = ?');
          for (const id of ids) removed += Number(del.run(BigInt(id)).changes); // D-149 坑②
        });
        return removed;
      }
      return fallback.deleteIds('msg', ids, { countRemovedByExistence: true });
    },

    /** 删一条消息向量（rewind 物理删消息时用；repo 那边自己也会清持久化那份） */
    deleteMsgVec(msgId) {
      if (hasVec) return Number(stmt('DELETE FROM vec_msg WHERE msg_id = ?').run(pk(msgId, 'deleteMsgVec')).changes);
      return fallback.deleteOne('msg', msgId);
    },

    insertSceneVec(sceneId, vector) {
      insertSceneVecUnsafe(sceneId, normalizeVector(vector, dim, `scene ${sceneId} 的向量`));
    },

    upsertSceneVec(sceneId, vector) {
      withTx(db, () => upsertSceneVecUnsafe(sceneId, normalizeVector(vector, dim, `scene ${sceneId} 的向量`)));
    },

    insertSceneVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `scene ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) insertSceneVecUnsafe(id, v);
      });
      return list.length;
    },

    upsertSceneVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `scene ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) upsertSceneVecUnsafe(id, v);
      });
      return list.length;
    },

    /**
     * 删一批场景向量（场景重建用 —— T8 的 P1 就是这里没人调）。
     *
     * 场景重建是「删旧场 → 插新场」。旧场向量不清的话，
     * 新场一旦拿到同一个 id，旧场的 gist 向量就会命中一条无关的新对话。
     * 持久化那份已由 `extras.sceneAssign.clear()` 在同事务里清掉，
     * 这里负责本进程内存里那份（降级模式）。
     *
     * @param {number[]} sceneIds
     * @returns {number} 删掉的条数
     */
    deleteSceneVecs(sceneIds) {
      const ids = (Array.isArray(sceneIds) ? sceneIds : []).map(Number).filter((n) => Number.isSafeInteger(n));
      if (ids.length === 0) return 0;
      if (hasVec) {
        let removed = 0;
        withTx(db, () => {
          const del = stmt('DELETE FROM vec_scene WHERE scene_id = ?');
          for (const id of ids) removed += Number(del.run(BigInt(id)).changes);
        });
        return removed;
      }
      return fallback.deleteIds('scene', ids, { countRemovedByExistence: true });
    },

    deleteSceneVec(sceneId) {
      if (hasVec) {
        return Number(stmt('DELETE FROM vec_scene WHERE scene_id = ?').run(pk(sceneId, 'deleteSceneVec')).changes);
      }
      return fallback.deleteOne('scene', sceneId);
    },

    /** 清空消息向量（重建索引用） */
    clearMsgVec() {
      if (hasVec) {
        stmt('DELETE FROM vec_msg').run();
        return;
      }
      fallback.clear('msg', { ensureFirst: true });
    },

    clearSceneVec() {
      if (hasVec) {
        stmt('DELETE FROM vec_scene').run();
        return;
      }
      fallback.clear('scene', { ensureFirst: true });
    },

    /**
     * 清掉「原文已经不在了」的向量（孤儿）。
     *
     * 正常读写路径不会产生孤儿（repo 删 msg / 清场景时同事务清向量，见 deleteVecRows），
     * 但下面这些情况会：v5 之前写过的老库、进程在删除与清理之间崩掉、
     * 或者有人在降级模式下手动改过 `vec_fallback_*`。
     * 孤儿在检索时会被外层 JOIN 过滤掉（召回不出去），所以这只是卫生问题 ——
     * 但它会让 `countMsgVec()` 偏大、让重建报告的数字对不上，也占着内存。
     *
     * 相比逐条 DELETE，这里对降级表用一条 `NOT IN (SELECT …)` 更省；
     * vec0 虚表不支持那种写法，所以先查 id 再差集删。
     *
     * @returns {{msgVectors: number, sceneVectors: number}} 清掉的条数
     */
    pruneOrphans() {
      const removed = { msgVectors: 0, sceneVectors: 0, chunkVectors: 0, windowVectors: 0 };
      if (hasVec) {
        const msgIds = new Set(stmt('SELECT id FROM msg').all().map((r) => Number(r.id)));
        for (const r of stmt('SELECT msg_id AS id FROM vec_msg').all()) {
          const id = Number(r.id);
          if (!msgIds.has(id)) {
            removed.msgVectors += Number(stmt('DELETE FROM vec_msg WHERE msg_id = ?').run(BigInt(id)).changes);
          }
        }
        const sceneIds = new Set(stmt('SELECT id FROM scene').all().map((r) => Number(r.id)));
        for (const r of stmt('SELECT scene_id AS id FROM vec_scene').all()) {
          const id = Number(r.id);
          if (!sceneIds.has(id)) {
            removed.sceneVectors += Number(stmt('DELETE FROM vec_scene WHERE scene_id = ?').run(BigInt(id)).changes);
          }
        }
        // **分片向量也要清**（2026-11-18，A2 审计问题 5）：
        // chunk 行被级联删掉后，vec_chunk 里的向量成了孤儿 —— 它永远不会报错，
        // 只会占着 KNN 的候选名额，把本该召回的片段挤掉（实测能挤到 0 条）。
        try {
          const chunkIds = new Set(stmt('SELECT id FROM chunk').all().map((r) => Number(r.id)));
          for (const r of stmt('SELECT chunk_id AS id FROM vec_chunk').all()) {
            const id = Number(r.id);
            if (!chunkIds.has(id)) {
              removed.chunkVectors += Number(stmt('DELETE FROM vec_chunk WHERE chunk_id = ?').run(BigInt(id)).changes);
            }
          }
        } catch { /* 还没有 vec_chunk 表 */ }
        try {
          const winIds = new Set(stmt('SELECT id FROM window').all().map((r) => Number(r.id)));
          for (const r of stmt('SELECT window_id AS id FROM vec_window').all()) {
            const id = Number(r.id);
            if (!winIds.has(id)) {
              removed.windowVectors += Number(stmt('DELETE FROM vec_window WHERE window_id = ?').run(BigInt(id)).changes);
            }
          }
        } catch { /* 还没有 vec_window 表 */ }
        return removed;
      }

      return fallback.pruneOrphans();
    },

    clearAll() {
      store.clearMsgVec();
      store.clearSceneVec();
    },

    /** 已索引多少条消息向量（进度条 / 自检用） */
    countMsgVec() {
      return countMsgVec();
    },

    countSceneVec() {
      return countSceneVec();
    },

    /* ── 长文本分片（D-247） ── */

    /**
     * 分片向量检索。返回的是**分片命中**，带 msgId 和它在原文里的位置，
     * 外层要按 msgId 去重（同一条消息的多片命中只算一条，取最高分）。
     *
     * @param {Float32Array|number[]} query
     * @param {number} [k=10]
     * @param {{sessionId?: string, includeExcluded?: boolean, limit?: number,
     *          minScore?: number, overFetch?: number}} [filter]
     * @returns {{chunkId:number, msgId:number, idx:number, startChar:number,
     *            endChar:number, distance:number, score:number}[]}
     */
    knnChunk(query, k = 10, filter = {}) {
      const want = Math.max(1, Math.floor(filter.limit ?? k));
      return runFilteredKnn({
        kind: 'chunk',
        query,
        want,
        total: countChunkVec(),
        filter,
        hydrate: hydrateChunks,
        buildHit: (m, c, score) => ({
          chunkId: c.id,
          msgId: Number(m.msg_id),
          idx: Number(m.idx),
          startChar: Number(m.start_char),
          endChar: Number(m.end_char),
          distance: c.distance,
          score,
        }),
      });
    },

    /** 分片向量总数 */
    countChunkVec() {
      return countChunkVec();
    },

    /** 批量写分片向量（索引构建走这条） */
    insertChunkVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `chunk ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) insertChunkVecUnsafe(id, v);
      });
      return list.length;
    },

    /** 批量幂等写分片向量（重建走这条） */
    upsertChunkVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `chunk ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) upsertChunkVecUnsafe(id, v);
      });
      return list.length;
    },

    /** 删掉这些分片向量 */
    deleteChunkVecs(ids) {
      const list = Array.from(ids, (x) => Number(x)).filter((x) => Number.isFinite(x));
      if (list.length === 0) return 0;
      if (!hasVec) return fallback.deleteIds('chunk', list, { ignoreErrors: true });
      let n = 0;
      withTx(db, () => {
        for (const id of list) {
          try {
            stmt('DELETE FROM vec_chunk WHERE chunk_id = ?').run(pk(id, 'deleteChunkVec'));
            n += 1;
          } catch { /* 不存在就当删过 */ }
        }
      });
      return n;
    },

    /** 清空全部分片向量 */
    clearChunkVec() {
      if (hasVec) {
        try { db.exec('DELETE FROM vec_chunk'); } catch { /* 表不存在 */ }
      } else {
        fallback.clear('chunk', { ignoreErrors: true });
      }
    },

    /* —— 查询 —— */

    /**
     * 消息向量检索。
     *
     * 两段式（D-150）：vec0/暴力余弦只负责"按向量取回候选"，
     * 时间/会话/排除这些业务条件全部在外层 JOIN 之后过滤。
     *
     * @param {Float32Array|number[]|Uint8Array} query
     * @param {number} [k=10] 要几条
     * @param {{from?: number, to?: number, sessionId?: string, sceneId?: number,
     *          includeExcluded?: boolean, limit?: number, minScore?: number,
     *          overFetch?: number}} [filter]
     * @returns {object[]} 命中（带 distance / score / vecRank），按相似度降序
     */
    knnMsg(query, k = 10, filter = {}) {
      const want = Math.max(1, Math.floor(filter.limit ?? k));
      return runFilteredKnn({
        kind: 'msg',
        query,
        want,
        total: countMsgVec(),
        filter,
        hydrate: hydrateMsgs,
        buildHit: (row, c, score, vecRank) => ({
          ...row,
          distance: c.distance,
          score,
          vecRank,
        }),
      });
    },

    /**
     * 场景（gist）向量检索。过滤语义与时间路一致：时间区间取**相交**。
     * @param {Float32Array|number[]|Uint8Array} query
     * @param {number} [k=5]
     * @param {{from?: number, to?: number, sessionId?: string, overFetch?: number, limit?: number}} [filter]
     */
    knnScene(query, k = 5, filter = {}) {
      const want = Math.max(1, Math.floor(filter.limit ?? k));
      return runFilteredKnn({
        kind: 'scene',
        query,
        want,
        total: countSceneVec(),
        filter,
        hydrate: hydrateScenes,
        buildHit: (row, c, score, vecRank) => ({
          ...row,
          distance: c.distance,
          score,
          vecRank,
        }),
      });
    },

    /** 笔记向量总数 */
    countNoteVec() {
      return countNoteVec();
    },

    /** 找出尚未写入笔记向量表的 note id（最多检查入参这批，用于即时懒补） */
    missingNoteIds(ids) {
      const list = Array.from(ids ?? [], (x) => Number(x)).filter((x) => Number.isSafeInteger(x));
      if (list.length === 0) return [];
      if (hasVec) {
        try {
          const have = new Set();
          queryByIds(list, (slice) => {
            const rows = db.prepare(`SELECT note_id AS id FROM vec_note WHERE note_id IN (${placeholders(slice.length)})`).all(...slice);
            for (const r of rows) have.add(Number(r.id));
          });
          return list.filter((id) => !have.has(id));
        } catch {
          return list;
        }
      }
      return fallback.missingIds('note', list);
    },

    /** 批量幂等写入笔记向量 */
    upsertNoteVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `note ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) upsertNoteVecUnsafe(id, v);
      });
      return list.length;
    },

    /** 删除指定笔记向量 */
    deleteNoteVecs(ids) {
      const list = Array.from(ids, (x) => Number(x)).filter((x) => Number.isFinite(x));
      if (list.length === 0) return 0;
      if (!hasVec) return fallback.deleteIds('note', list, { ignoreErrors: true });
      let n = 0;
      withTx(db, () => {
        for (const id of list) {
          try {
            stmt('DELETE FROM vec_note WHERE note_id = ?').run(pk(id, 'deleteNoteVec'));
            n += 1;
          } catch { /* ignore */ }
        }
      });
      return n;
    },

    /**
     * 笔记向量检索（按会话 + 未软删 + 时间范围 + minScore 过滤）。
     * @param {Float32Array|number[]|Uint8Array} query
     * @param {number} [k=5]
     * @param {{sessionId?: string, from?: number, to?: number, minScore?: number, limit?: number, overFetch?: number}} [filter]
     */
    knnNote(query, k = 5, filter = {}) {
      const want = Math.max(1, Math.floor(filter.limit ?? k));
      return runFilteredKnn({
        kind: 'note',
        query,
        want,
        total: countNoteVec(),
        filter,
        hydrate: hydrateNotes,
        buildHit: (row, c, score, vecRank) => ({
          ...row,
          distance: c.distance,
          score,
          vecRank,
        }),
      });
    },

    /* ── 场景内滑动对话窗（Window） ── */

    countWindowVec() {
      return countWindowVec();
    },

    upsertWindowVecs(entries) {
      const list = Array.from(entries, ([id, v]) => [id, normalizeVector(v, dim, `window ${id} 的向量`)]);
      if (list.length === 0) return 0;
      withTx(db, () => {
        for (const [id, v] of list) upsertWindowVecUnsafe(id, v);
      });
      return list.length;
    },

    deleteWindowVecs(ids) {
      const list = Array.from(ids ?? [], (x) => Number(x)).filter((x) => Number.isSafeInteger(x));
      if (list.length === 0) return 0;
      if (!hasVec) return fallback.deleteIds('window', list, { ignoreErrors: true });
      let n = 0;
      withTx(db, () => {
        for (const id of list) {
          try {
            stmt('DELETE FROM vec_window WHERE window_id = ?').run(pk(id, 'deleteWindowVec'));
            n += 1;
          } catch { /* ignore */ }
        }
      });
      return n;
    },

    clearWindowVec() {
      if (hasVec) {
        try { db.exec('DELETE FROM vec_window'); } catch { /* 表不存在 */ }
      } else {
        fallback.clear('window', { ignoreErrors: true });
      }
    },

    /**
     * 批量读取窗口向量（供跨日时间线聚类折叠使用）。
     * @param {Iterable<number>} ids
     * @returns {Map<number, Float32Array>}
     */
    getWindowVecs(ids) {
      const list = [...new Set(Array.from(ids ?? [], (x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0))];
      if (list.length === 0) return new Map();
      if (!hasVec) return fallback.getVecs('window', list);
      const out = new Map();
      try {
        queryByIds(list, (slice) => {
          const rows = db.prepare(`SELECT window_id, emb FROM vec_window WHERE window_id IN (${placeholders(slice.length)})`).all(...slice.map((id) => BigInt(id)));
          for (const r of rows) {
            if (r?.emb) out.set(Number(r.window_id), toFloat32(/** @type {Uint8Array} */ (r.emb), dim, `window ${r.window_id} 的向量`));
          }
        });
      } catch { /* ignore */ }
      return out;
    },

    /**
     * 场景内滑动对话窗向量检索（按 sessionId + 时间区间相交 + minScore 过滤）。
     * @param {Float32Array|number[]|Uint8Array} query
     * @param {number} [k=10]
     * @param {{sessionId?: string, from?: number, to?: number, minScore?: number, limit?: number, overFetch?: number}} [filter]
     */
    knnWindow(query, k = 10, filter = {}) {
      const want = Math.max(1, Math.floor(filter.limit ?? k));
      return runFilteredKnn({
        kind: 'window',
        query,
        want,
        total: countWindowVec(),
        filter,
        hydrate: hydrateWindows,
        buildHit: (r, c, score, vecRank) => ({
          id: Number(r.id),
          windowId: Number(r.id),
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
          sceneStartAt: r.scene_start_at === null || r.scene_start_at === undefined ? Number(r.start_at) : Number(r.scene_start_at),
          sceneEndAt: r.scene_end_at === null || r.scene_end_at === undefined ? Number(r.end_at) : Number(r.scene_end_at),
          sceneMsgCount: r.scene_msg_count === null || r.scene_msg_count === undefined ? Number(r.msg_count) : Number(r.scene_msg_count),
          distance: c.distance,
          score,
          vecRank,
        }),
      });
    },

    /**
     * 纯向量层候选（不带业务过滤）—— 调试与"降级是否等价"的对比测试用。
     * @param {'msg'|'scene'} kind
     * @param {Float32Array|number[]|Uint8Array} query
     * @param {number} fetch
     */
    candidates(kind, query, fetch) {
      if (kind !== 'msg' && kind !== 'scene') {
        throw new TypeError(`candidates: kind 只能是 'msg' 或 'scene'，收到 ${String(kind)}`);
      }
      return candidates(kind, normalizeVector(query, dim, '查询向量'), fetch);
    },

    /* —— 降级模式的显式灌入（进程内重建却不重新 embedding 时用） —— */

    /**
     * @param {Iterable<[number, Float32Array]>} entries
     */
    hydrateMsgVectors(entries) {
      if (hasVec) throw new Error('hydrateMsgVectors 只在降级模式（hasVec=false）下有意义');
      fallback.ensureLoaded();
      withTx(db, () => {
        for (const [id, v] of entries) upsertMsgVecUnsafe(id, normalizeVector(v, dim, `msg ${id} 的向量`));
      });
    },

    hydrateSceneVectors(entries) {
      if (hasVec) throw new Error('hydrateSceneVectors 只在降级模式（hasVec=false）下有意义');
      fallback.ensureLoaded();
      withTx(db, () => {
        for (const [id, v] of entries) upsertSceneVecUnsafe(id, normalizeVector(v, dim, `scene ${id} 的向量`));
      });
    },

    /** 自检信息（给 T8 的进度打印用） */
    stats() {
      return {
        mode,
        hasVec,
        dim,
        overFetch,
        msgVectors: countMsgVec(),
        chunkVectors: countChunkVec(),
        windowVectors: countWindowVec(),
        sceneVectors: countSceneVec(),
        noteVectors: countNoteVec(),
        fallbackPersisted: Boolean(hasVec ? false : fallback.isTableReady()),
      };
    },
  };

  return store;
}

export default createVectorStore;
