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

/** 向量维度（D-144：1024，不是 2560） */
export const DEFAULT_DIM = 1024;

/** KNN 候选放大倍数：先多取，再在外层过滤（D-150 的落地方式） */
export const DEFAULT_OVER_FETCH = 8;

/** 降级模式的落盘表名（只在不加载 sqlite-vec 时才会被创建） */
export const FALLBACK_TABLES = {
  msg: 'vec_fallback_msg',
  scene: 'vec_fallback_scene',
  chunk: 'vec_fallback_chunk',
  note: 'vec_fallback_note',
  window: 'vec_fallback_window',
};

/** FTS/检索结果的公共字段（与 store 的 MsgRow 对齐，见 BUILD-PLAN §3.1） */
const MSG_SELECT = `m.id, m.session_id, m.seq, m.at, m.speaker, m.text,
  m.in_surface, m.compacted_at, m.excluded, m.scene_id,
  s.start_at AS scene_start_at, s.end_at AS scene_end_at, s.msg_count AS scene_msg_count`;

/* ============================ 向量工具函数 ============================ */

/**
 * 把各种入参统一成 Float32Array（不校验维度以外的语义）。
 * @param {Float32Array|number[]|Uint8Array|ArrayBuffer} input
 * @param {number} dim
 * @param {string} [what] 报错时用的人话名词
 * @returns {Float32Array}
 */
function toFloat32(input, dim, what = '向量') {
  if (input instanceof Float32Array) {
    if (input.length !== dim) {
      throw new TypeError(`${what}维度不对：要 ${dim} 维，收到 ${input.length} 维`);
    }
    return input;
  }
  if (input instanceof Uint8Array) {
    // 裸字节（BLOB）：长度必须是 dim × 4
    if (input.byteLength !== dim * 4) {
      throw new TypeError(`${what}的字节数不对：要 ${dim * 4} 字节（${dim} 维 float32），收到 ${input.byteLength}`);
    }
    const copy = new Uint8Array(input); // 复制，避免调用方的 buffer 被共用
    return new Float32Array(copy.buffer, copy.byteOffset, dim);
  }
  if (input instanceof ArrayBuffer) {
    return toFloat32(new Uint8Array(input), dim, what);
  }
  if (Array.isArray(input)) {
    if (input.length !== dim) {
      throw new TypeError(`${what}维度不对：要 ${dim} 维，收到 ${input.length} 维`);
    }
    return Float32Array.from(input);
  }
  throw new TypeError(`${what}必须是 Float32Array / number[] / BLOB，收到 ${typeof input}`);
}

/**
 * L2 归一化。返回**新的** Float32Array，绝不改调用方的数组。
 *
 * 为什么非归一化不可：vec0 用 L2 距离，单位向量下 L2² = 2 - 2·cos，
 * 于是 distance 能无损换算成余弦，和暴力余弦路径同一口径（见文件头 ③）。
 *
 * @param {Float32Array|number[]|Uint8Array|ArrayBuffer} input
 * @param {number} dim
 * @param {string} [what]
 * @returns {Float32Array}
 */
export function normalizeVector(input, dim, what = '向量') {
  const src = toFloat32(input, dim, what);
  const out = new Float32Array(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) {
      throw new TypeError(`${what}: 第 ${i} 维不是有限数值（${v}）`);
    }
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) out[i] = src[i] / norm;
  } else {
    // 全零向量没有方向，塞成固定单位向量（和 mock.js 的处理一致），至少不会 NaN
    out[0] = 1;
  }
  return out;
}

/**
 * Float32Array → BLOB（供 node:sqlite 绑定）
 *
 * **必须返回副本，不能返回视图。**
 *
 * 踩过的坑（表现为「同一查询的向量每次都在变」）：
 *   `new Uint8Array(vector.buffer, byteOffset, byteLength)` 是与入参**共享内存**的视图。
 *   node:sqlite 在绑定 BLOB 参数时会写这块内存（内部缓冲复用），
 *   于是调用方持有的向量被**原地篡改**。
 *   实测：同一查询两次取到的向量最大差异 0.0021，且随调用次数累积漂移；
 *   配合「跨变体共享的查询向量缓存」，一次运行里向量会越用越偏，
 *   最终表现为某些变体的检索结果系统性变差（正确率从 65% 掉到 16%）。
 *
 *   这个 bug 不报错、只在长跑里显现，是最难查的一类。
 */
export function toBlob(vector) {
  // Uint8Array.from 会复制字节，切断与入参的共享内存
  return Uint8Array.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

/**
 * 点积。两个向量都已归一化时点积 = 余弦相似度（D-145：不做 int8，直接 f32）。
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** L2 距离 → 余弦。单位向量下恒等（见文件头 ③）。 */
export function distanceToScore(distance) {
  const d2 = Math.min(4, Math.max(0, distance * distance));
  return 1 - d2 / 2;
}

/** 余弦 → L2 距离。给降级路径对齐 vec0 的 distance 口径用。 */
export function scoreToDistance(score) {
  const cos = Math.min(1, Math.max(-1, score));
  return Math.sqrt(Math.max(0, 2 - 2 * cos));
}

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
      const m = /float\[(\d+)\]/i.exec(row?.sql ?? '');
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
    if (handle?.hasVec) return true;
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

  /** @type {Map<number, Float32Array>} msgId → 单位向量（只有降级模式会填） */
  const msgVectors = new Map();
  /** @type {Map<number, Float32Array>} sceneId → 单位向量 */
  const sceneVectors = new Map();

  /** 长文本分片向量（降级路径用；D-247） */
  const chunkVectors = new Map();

  /** 笔记向量（降级路径用） */
  const noteVectors = new Map();

  /** 场景内滑动对话窗向量（降级路径用） */
  const windowVectors = new Map();

  /** 降级落盘是否真的可用（只读库 / 建表失败就关掉，但内存索引照常工作） */
  let fallbackTableReady = false;
  let fallbackLoaded = false;

  function ensureFallbackTables() {
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
      logger.warn(
        `降级向量无法落盘（${error?.message ?? error}）；本次仅在内存里索引，重启后需要重建`,
      );
    }
    return fallbackTableReady;
  }

  /**
   * 首次用到降级索引时把落盘的向量读回内存，顺便清掉孤儿行
   * （msg 被 rewind 物理删掉后，降级表没有 CASCADE，靠这步收尸）。
   */
  function ensureFallbackLoaded() {
    if (fallbackLoaded || hasVec) return;
    fallbackLoaded = true;
    if (!ensureFallbackTables()) return;
    try {
      // 孤儿清理：删 msg 时 vec0 有 repo 顺手清，降级表没这个待遇
      db.exec(`DELETE FROM ${FALLBACK_TABLES.msg} WHERE msg_id NOT IN (SELECT id FROM msg)`);
      db.exec(`DELETE FROM ${FALLBACK_TABLES.scene} WHERE scene_id NOT IN (SELECT id FROM scene)`);
      // **chunk 表也要清**（2026-11-18，A2 审计问题 2）：
      // 之前这里漏了 chunk —— 降级模式重启后 `countChunkVec()` 永远是 0，
      // 于是「长消息的语义向量」在进程重启后就永久消失（消息级还在，所以没人报警）。
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES.chunk} WHERE chunk_id NOT IN (SELECT id FROM chunk)`);
      } catch { /* 老库还没有 chunk 表 */ }
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES.note} WHERE note_id NOT IN (SELECT id FROM note WHERE deleted_at IS NULL)`);
      } catch { /* 老库还没有 note 表 */ }
      try {
        db.exec(`DELETE FROM ${FALLBACK_TABLES.window} WHERE window_id NOT IN (SELECT id FROM window)`);
      } catch { /* 老库还没有 window 表 */ }
      for (const r of stmt(`SELECT msg_id, emb FROM ${FALLBACK_TABLES.msg}`).all()) {
        msgVectors.set(Number(r.msg_id), toFloat32(r.emb, dim, '降级表里的向量'));
      }
      for (const r of stmt(`SELECT scene_id, emb FROM ${FALLBACK_TABLES.scene}`).all()) {
        sceneVectors.set(Number(r.scene_id), toFloat32(r.emb, dim, '降级表里的场景向量'));
      }
      // 分片向量也要读回内存 —— 少这一步，降级模式下 knnChunk 永远召回 0 条
      try {
        for (const r of stmt(`SELECT chunk_id, emb FROM ${FALLBACK_TABLES.chunk}`).all()) {
          chunkVectors.set(Number(r.chunk_id), toFloat32(r.emb, dim, '降级表里的分片向量'));
        }
      } catch { /* 老库还没有 chunk 降级表 */ }
      try {
        for (const r of stmt(`SELECT note_id, emb FROM ${FALLBACK_TABLES.note}`).all()) {
          noteVectors.set(Number(r.note_id), toFloat32(r.emb, dim, '降级表里的笔记向量'));
        }
      } catch { /* 老库还没有 note 降级表 */ }
      try {
        for (const r of stmt(`SELECT window_id, emb FROM ${FALLBACK_TABLES.window}`).all()) {
          windowVectors.set(Number(r.window_id), toFloat32(r.emb, dim, '降级表里的对话窗向量'));
        }
      } catch { /* 老库还没有 window 降级表 */ }
    } catch (error) {
      logger.warn(`读取降级向量失败，改用本次进程内已索引的部分：${error?.message ?? error}`);
    }
  }

  if (!hasVec) ensureFallbackLoaded();

  /**
   * 降级模式：**落盘表才是权威，内存 Map 只是缓存**。
   *
   * 为什么需要这一步（R5 实测的 P1）：`repo.deleteMsgsBySeq` 清的是持久化那份
   * （它没有、也不该有本进程 store 的引用），内存里这份仍然是旧的。
   * 于是「原文删了、向量表也删了，但内存还带着那条向量」——
   * 在 id 不复用（v5）之后它召回不出去，但会让条数统计失真，
   * 也让「撤回后立刻查」这种断言变得不可靠。
   *
   * 靠大小对账来发现漂移：所有写入都经过本模块（Map 与表同步增减），
   * 只有外部删除会让「表比 Map 少」。一旦不相等就以表为准重载。
   * 代价是每次两下 COUNT(*)，7k 条量级在 0.2 ms 以内，远小于一次暴力余弦。
   */
  function syncFallbackIndexIfStale() {
    if (hasVec || !fallbackTableReady) return; // 没落盘表就没有可比对的权威
    try {
      const tableMsgs = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES.msg}`).get().c ?? 0);
      const tableScenes = Number(stmt(`SELECT COUNT(*) AS c FROM ${FALLBACK_TABLES.scene}`).get().c ?? 0);
      let tableWindows = windowVectors.size;
      let tableChunks = chunkVectors.size;
      let tableNotes = noteVectors.size;
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
        tableMsgs !== msgVectors.size
        || tableScenes !== sceneVectors.size
        || tableWindows !== windowVectors.size
        || tableChunks !== chunkVectors.size
        || tableNotes !== noteVectors.size
      ) {
        msgVectors.clear();
        sceneVectors.clear();
        windowVectors.clear();
        chunkVectors.clear();
        noteVectors.clear();
        fallbackLoaded = false;
        ensureFallbackLoaded();
      }
    } catch {
      // 表读不到就按现有内存索引继续用，别把查询搞崩
    }
  }

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
      msgVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT INTO ${FALLBACK_TABLES.msg} (msg_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
    }
  }

  function upsertMsgVecUnsafe(id, vector) {
    if (hasVec) {
      // vec0 的主键不支持 INSERT OR REPLACE（实测报 UNIQUE constraint failed），
      // 只能先删再插 —— 这两步必须同一个事务，否则中途崩了会丢一条向量。
      stmt('DELETE FROM vec_msg WHERE msg_id = ?').run(pk(id, 'upsertMsgVec'));
      stmt('INSERT INTO vec_msg (msg_id, emb) VALUES (?, ?)').run(pk(id, 'upsertMsgVec'), toBlob(vector));
    } else {
      msgVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT OR REPLACE INTO ${FALLBACK_TABLES.msg} (msg_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
    }
  }

  /* ── 长文本分片向量（D-247）：rowid = chunk.id ── */

  function insertChunkVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('INSERT INTO vec_chunk (chunk_id, emb) VALUES (?, ?)').run(pk(id, 'insertChunkVec'), toBlob(vector));
    } else {
      chunkVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT INTO ${FALLBACK_TABLES.chunk} (chunk_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
    }
  }

  function upsertChunkVecUnsafe(id, vector) {
    if (hasVec) {
      // 同 msg 的 upsert：vec0 主键不支持 INSERT OR REPLACE，先删再插
      stmt('DELETE FROM vec_chunk WHERE chunk_id = ?').run(pk(id, 'upsertChunkVec'));
      stmt('INSERT INTO vec_chunk (chunk_id, emb) VALUES (?, ?)').run(pk(id, 'upsertChunkVec'), toBlob(vector));
    } else {
      chunkVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT OR REPLACE INTO ${FALLBACK_TABLES.chunk} (chunk_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
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
    syncFallbackIndexIfStale();
    ensureFallbackLoaded();
    return chunkVectors.size;
  }

  function insertSceneVecUnsafe(id, vector) {    if (hasVec) {
      stmt('INSERT INTO vec_scene (scene_id, emb) VALUES (?, ?)').run(pk(id, 'insertSceneVec'), toBlob(vector));
    } else {
      sceneVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT INTO ${FALLBACK_TABLES.scene} (scene_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
    }
  }

  function upsertSceneVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('DELETE FROM vec_scene WHERE scene_id = ?').run(pk(id, 'upsertSceneVec'));
      stmt('INSERT INTO vec_scene (scene_id, emb) VALUES (?, ?)').run(pk(id, 'upsertSceneVec'), toBlob(vector));
    } else {
      sceneVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT OR REPLACE INTO ${FALLBACK_TABLES.scene} (scene_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
    }
  }

  function upsertNoteVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('DELETE FROM vec_note WHERE note_id = ?').run(pk(id, 'upsertNoteVec'));
      stmt('INSERT INTO vec_note (note_id, emb) VALUES (?, ?)').run(pk(id, 'upsertNoteVec'), toBlob(vector));
    } else {
      noteVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT OR REPLACE INTO ${FALLBACK_TABLES.note} (note_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
    }
  }

  function upsertWindowVecUnsafe(id, vector) {
    if (hasVec) {
      stmt('DELETE FROM vec_window WHERE window_id = ?').run(pk(id, 'upsertWindowVec'));
      stmt('INSERT INTO vec_window (window_id, emb) VALUES (?, ?)').run(pk(id, 'upsertWindowVec'), toBlob(vector));
    } else {
      windowVectors.set(Number(id), vector);
      if (ensureFallbackTables()) {
        stmt(`INSERT OR REPLACE INTO ${FALLBACK_TABLES.window} (window_id, emb) VALUES (?, ?)`)
          .run(Number(id), toBlob(vector));
      }
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
    ensureFallbackLoaded();
    syncFallbackIndexIfStale();
    return windowVectors.size;
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
    ensureFallbackLoaded();
    const source = kind === 'msg'
      ? msgVectors
      : kind === 'chunk'
        ? chunkVectors
        : kind === 'note'
          ? noteVectors
          : kind === 'window'
            ? windowVectors
            : sceneVectors;
    const out = [];
    for (const [id, vec] of source) {
      const score = dot(query, vec);
      // 换算成 L2 距离，和 vec0 的 distance 同一口径（文件头 ③）
      out.push({ id, distance: scoreToDistance(score) });
    }
    out.sort((a, b) => a.distance - b.distance || a.id - b.id);
    return out.slice(0, k);
  }

  /** 拼 `?,?,?` */
  function placeholders(n) {
    return new Array(n).fill('?').join(', ');
  }

  /** IN 列表里每个 id 都过一遍 pk 校验（vec0 的 rowid 是整数） */
  function toParams(ids) {
    return ids.map((id) => {
      const n = Number(id);
      if (!Number.isSafeInteger(n)) throw new TypeError(`候选 id 不是安全整数：${String(id)}`);
      return n;
    });
  }

  /**
   * 第二段：外层 JOIN + 过滤（D-150 的"时间过滤放外层"就落在这里）。
   * 返回 Map<id, row>，没通过过滤的 id 不会出现在里面。
   */
  function hydrateMsgs(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = [];
    const args = toParams(ids);
    if (!filter.includeExcluded) where.push('m.excluded = 0');
    if (filter.sessionId) {
      where.push('m.session_id = ?');
      args.push(filter.sessionId);
    }
    if (Number.isFinite(filter.from)) {
      where.push('m.at >= ?');
      args.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('m.at < ?'); // 左闭右开，和 msgsByTimeRange 一致
      args.push(filter.to);
    }
    if (Number.isFinite(filter.sceneId)) {
      where.push('m.scene_id = ?');
      args.push(filter.sceneId);
    }
    const sql =
      `SELECT ${MSG_SELECT}
       FROM msg m LEFT JOIN scene s ON s.id = m.scene_id
       WHERE m.id IN (${placeholders(ids.length)})${where.length ? ` AND ${where.join(' AND ')}` : ''}`;
    const map = new Map();
    for (const r of stmt(sql).all(...args)) map.set(Number(r.id), mapMsgRow(r));
    return map;
  }

  /** 场景的外层过滤：相交语义（start_at < to && end_at >= from），和场景路一致 */
  function hydrateScenes(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = [];
    const args = toParams(ids);
    if (filter.sessionId) {
      where.push('session_id = ?');
      args.push(filter.sessionId);
    }
    if (Number.isFinite(filter.from)) {
      where.push('end_at >= ?');
      args.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('start_at < ?');
      args.push(filter.to);
    }
    const sql =
      `SELECT * FROM scene
       WHERE id IN (${placeholders(ids.length)})${where.length ? ` AND ${where.join(' AND ')}` : ''}`;
    const map = new Map();
    for (const r of stmt(sql).all(...args)) map.set(Number(r.id), mapSceneRow(r));
    return map;
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

  /* ------------------------------ 计数 ------------------------------ */

  function countMsgVec() {
    if (hasVec) return Number(stmt('SELECT COUNT(*) AS c FROM vec_msg').get().c ?? 0);
    ensureFallbackLoaded();
    syncFallbackIndexIfStale(); // 外部（repo）删过向量就以落盘表为准重载
    return msgVectors.size;
  }

  function countSceneVec() {
    if (hasVec) return Number(stmt('SELECT COUNT(*) AS c FROM vec_scene').get().c ?? 0);
    ensureFallbackLoaded();
    syncFallbackIndexIfStale();
    return sceneVectors.size;
  }

  function countNoteVec() {
    if (hasVec) {
      try {
        return Number(stmt('SELECT COUNT(*) AS c FROM vec_note').get().c ?? 0);
      } catch {
        return 0;
      }
    }
    ensureFallbackLoaded();
    syncFallbackIndexIfStale();
    return noteVectors.size;
  }

  function hydrateNotes(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = ['n.deleted_at IS NULL'];
    const args = toParams(ids);
    if (filter.sessionId) {
      where.push('n.session_id = ?');
      args.push(filter.sessionId);
    }
    if (Number.isFinite(filter.from)) {
      where.push('n.at >= ?');
      args.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('n.at < ?');
      args.push(filter.to);
    }
    const rows = stmt(
      `SELECT n.id, n.content, n.about, n.at, n.session_id
         FROM note n
        WHERE n.id IN (${placeholders(ids.length)})
          AND ${where.join(' AND ')}`,
    ).all(...args);
    const map = new Map();
    for (const r of rows) {
      map.set(Number(r.id), {
        id: Number(r.id),
        content: String(r.content ?? ''),
        about: r.about ?? null,
        at: Number(r.at),
        sessionId: r.session_id ?? null,
      });
    }
    return map;
  }

  function hydrateChunks(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = [`c.id IN (${placeholders(ids.length)})`];
    const args = toParams(ids);
    if (filter.sessionId) {
      where.push('m.session_id = ?');
      args.push(filter.sessionId);
    }
    if (!filter.includeExcluded) where.push('m.excluded = 0');
    if (Number.isFinite(filter.from)) {
      where.push('m.at >= ?');
      args.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('m.at < ?');
      args.push(filter.to);
    }
    const rows = stmt(
      `SELECT c.id, c.msg_id, c.idx, c.start_char, c.end_char,
              m.session_id, m.excluded, m.at
         FROM chunk c JOIN msg m ON m.id = c.msg_id
        WHERE ${where.join(' AND ')}`,
    ).all(...args);
    const map = new Map();
    for (const r of rows) map.set(Number(r.id), r);
    return map;
  }

  function hydrateWindows(ids, filter = {}) {
    if (ids.length === 0) return new Map();
    const where = [`w.id IN (${placeholders(ids.length)})`];
    const args = toParams(ids);
    if (filter.sessionId) {
      where.push('w.session_id = ?');
      args.push(filter.sessionId);
    }
    if (filter.kind) {
      where.push('w.kind = ?');
      args.push(String(filter.kind));
    }
    if (Number.isFinite(filter.from)) {
      where.push('w.end_at >= ?');
      args.push(filter.from);
    }
    if (Number.isFinite(filter.to)) {
      where.push('w.start_at < ?');
      args.push(filter.to);
    }
    try {
      const rows = stmt(
        `SELECT w.id, w.session_id, w.scene_id, w.idx, w.kind, w.start_msg_id, w.end_msg_id,
                w.start_at, w.end_at, w.msg_count, w.text,
                s.start_at AS scene_start_at, s.end_at AS scene_end_at, s.msg_count AS scene_msg_count
           FROM window w
           LEFT JOIN scene s ON s.id = w.scene_id
          WHERE ${where.join(' AND ')}`,
      ).all(...args);
      const map = new Map();
      for (const r of rows) map.set(Number(r.id), r);
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * 统一的过滤型 KNN 召回器：
   * - vec0 模式：若外层条件（如 sessionId / 时间范围）过滤后不足 want 条，渐进扩大 overFetch 再查，
   *   避免多会话大库场景下小会话被全局 Top-8k 挤掉而漏召回。
   * - 降级模式：全库只算一次 dot 排序，分批 hydrate 直到凑齐 want 条或遍历完，不再做多余 O(n·dim) 扫描。
   */
  function runFilteredKnn({ kind, query, want, total, filter = {}, hydrate, buildHit }) {
    if (total === 0) return [];
    const q = normalizeVector(query, dim, '查询向量');
    const baseFactor = filter.overFetch ?? overFetch;
    const minScore = Number.isFinite(filter.minScore) ? filter.minScore : null;

    if (!hasVec) {
      // 降级模式下 candidates(..., total) 只算一次全量点积；按块 hydrate，凑齐即止
      const allCands = candidates(kind, q, total);
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
            // c.distance 升序 ⇒ score 降序，后面只会更低，直接结束
            return out;
          }
          out.push(buildHit(row, c, score, out.length + 1));
          if (out.length >= want) break;
        }
      }
      return out;
    }

    const maxFetch = Math.min(total, Math.max(8192, want * 128));
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
      ensureFallbackLoaded();
      let removed = 0;
      withTx(db, () => {
        const tableReady = ensureFallbackTables();
        const del = tableReady ? stmt(`DELETE FROM ${FALLBACK_TABLES.msg} WHERE msg_id = ?`) : null;
        for (const id of ids) {
          if (msgVectors.delete(id)) removed += 1;
          if (del) del.run(id);
        }
      });
      return removed;
    },

    /** 删一条消息向量（rewind 物理删消息时用；repo 那边自己也会清持久化那份） */
    deleteMsgVec(msgId) {
      if (hasVec) return Number(stmt('DELETE FROM vec_msg WHERE msg_id = ?').run(pk(msgId, 'deleteMsgVec')).changes);
      ensureFallbackLoaded();
      const existed = msgVectors.delete(Number(msgId));
      if (ensureFallbackTables()) {
        stmt(`DELETE FROM ${FALLBACK_TABLES.msg} WHERE msg_id = ?`).run(Number(msgId));
      }
      return existed ? 1 : 0;
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
      ensureFallbackLoaded();
      let removed = 0;
      withTx(db, () => {
        const tableReady = ensureFallbackTables();
        const del = tableReady ? stmt(`DELETE FROM ${FALLBACK_TABLES.scene} WHERE scene_id = ?`) : null;
        for (const id of ids) {
          if (sceneVectors.delete(id)) removed += 1;
          if (del) del.run(id);
        }
      });
      return removed;
    },

    deleteSceneVec(sceneId) {
      if (hasVec) {
        return Number(stmt('DELETE FROM vec_scene WHERE scene_id = ?').run(pk(sceneId, 'deleteSceneVec')).changes);
      }
      ensureFallbackLoaded();
      const existed = sceneVectors.delete(Number(sceneId));
      if (ensureFallbackTables()) {
        stmt(`DELETE FROM ${FALLBACK_TABLES.scene} WHERE scene_id = ?`).run(Number(sceneId));
      }
      return existed ? 1 : 0;
    },

    /** 清空消息向量（重建索引用） */
    clearMsgVec() {
      if (hasVec) {
        stmt('DELETE FROM vec_msg').run();
        return;
      }
      ensureFallbackLoaded();
      msgVectors.clear();
      if (ensureFallbackTables()) stmt(`DELETE FROM ${FALLBACK_TABLES.msg}`).run();
    },

    clearSceneVec() {
      if (hasVec) {
        stmt('DELETE FROM vec_scene').run();
        return;
      }
      ensureFallbackLoaded();
      sceneVectors.clear();
      if (ensureFallbackTables()) stmt(`DELETE FROM ${FALLBACK_TABLES.scene}`).run();
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

      ensureFallbackLoaded();
      if (!ensureFallbackTables()) {
        // 没落盘就只剩内存这份，按 msg/scene 现有 id 对一遍
        const msgIds = new Set(stmt('SELECT id FROM msg').all().map((r) => Number(r.id)));
        for (const id of [...msgVectors.keys()]) {
          if (!msgIds.has(id)) {
            msgVectors.delete(id);
            removed.msgVectors += 1;
          }
        }
        const sceneIds = new Set(stmt('SELECT id FROM scene').all().map((r) => Number(r.id)));
        for (const id of [...sceneVectors.keys()]) {
          if (!sceneIds.has(id)) {
            sceneVectors.delete(id);
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
        // 降级分支同样要清分片孤儿（2026-11-18，A2 问题 5）
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
      // 内存那份跟着落盘表重建
      msgVectors.clear();
      sceneVectors.clear();
      windowVectors.clear();
      chunkVectors.clear();
      noteVectors.clear();
      fallbackLoaded = false;
      ensureFallbackLoaded();
      return removed;
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
      let n = 0;
      withTx(db, () => {
        for (const id of list) {
          try {
            if (hasVec) stmt('DELETE FROM vec_chunk WHERE chunk_id = ?').run(pk(id, 'deleteChunkVec'));
            else chunkVectors.delete(id);
            if (!hasVec && ensureFallbackTables()) {
              stmt(`DELETE FROM ${FALLBACK_TABLES.chunk} WHERE chunk_id = ?`).run(id);
            }
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
        chunkVectors.clear();
        if (ensureFallbackTables()) {
          try { db.exec(`DELETE FROM ${FALLBACK_TABLES.chunk}`); } catch { /* ignore */ }
        }
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
     * @param {{from?: number, to?: number, sessionId?: string, overFetch?: number}} [filter]
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
          const rows = stmt(`SELECT note_id AS id FROM vec_note WHERE note_id IN (${placeholders(list.length)})`).all(...list);
          const have = new Set(rows.map((r) => Number(r.id)));
          return list.filter((id) => !have.has(id));
        } catch {
          return list;
        }
      }
      ensureFallbackLoaded();
      syncFallbackIndexIfStale();
      return list.filter((id) => !noteVectors.has(id));
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
      let n = 0;
      withTx(db, () => {
        for (const id of list) {
          try {
            if (hasVec) stmt('DELETE FROM vec_note WHERE note_id = ?').run(pk(id, 'deleteNoteVec'));
            else noteVectors.delete(id);
            if (!hasVec && ensureFallbackTables()) {
              stmt(`DELETE FROM ${FALLBACK_TABLES.note} WHERE note_id = ?`).run(id);
            }
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
      let n = 0;
      withTx(db, () => {
        for (const id of list) {
          try {
            if (hasVec) stmt('DELETE FROM vec_window WHERE window_id = ?').run(pk(id, 'deleteWindowVec'));
            else windowVectors.delete(id);
            if (!hasVec && ensureFallbackTables()) {
              stmt(`DELETE FROM ${FALLBACK_TABLES.window} WHERE window_id = ?`).run(id);
            }
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
        windowVectors.clear();
        if (ensureFallbackTables()) {
          try { db.exec(`DELETE FROM ${FALLBACK_TABLES.window}`); } catch { /* ignore */ }
        }
      }
    },

    /**
     * 批量读取窗口向量（供跨日时间线聚类折叠使用）。
     * @param {Iterable<number>} ids
     * @returns {Map<number, Float32Array>}
     */
    getWindowVecs(ids) {
      const list = [...new Set(Array.from(ids ?? [], (x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0))];
      const out = new Map();
      if (list.length === 0) return out;
      if (hasVec) {
        try {
          const ph = list.map(() => '?').join(',');
          const rows = db.prepare(`SELECT window_id, emb FROM vec_window WHERE window_id IN (${ph})`).all(...list.map((id) => BigInt(id)));
          for (const r of rows) {
            if (r?.emb) out.set(Number(r.window_id), toFloat32(r.emb, dim, `window ${r.window_id} 的向量`));
          }
        } catch { /* ignore */ }
      } else {
        ensureFallbackLoaded();
        for (const id of list) {
          const v = windowVectors.get(id);
          if (v) out.set(id, v);
        }
      }
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
      ensureFallbackLoaded();
      withTx(db, () => {
        for (const [id, v] of entries) upsertMsgVecUnsafe(id, normalizeVector(v, dim, `msg ${id} 的向量`));
      });
    },

    hydrateSceneVectors(entries) {
      if (hasVec) throw new Error('hydrateSceneVectors 只在降级模式（hasVec=false）下有意义');
      ensureFallbackLoaded();
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
        fallbackPersisted: Boolean(hasVec ? false : fallbackTableReady),
      };
    },
  };

  return store;
}

export default createVectorStore;
