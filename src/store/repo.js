/**
 * 仓储层 —— 所有模块只认这里的接口，不写 SQL（BUILD-PLAN.md §3.1）
 *
 * 用法：
 *   import { openDb } from './db.js';
 *   import { createRepo } from './repo.js';
 *
 *   const { db, hasVec } = openDb();
 *   const repo = createRepo(db);          // 也可传 openDb() 返回的整个 handle
 *
 * 也提供懒加载单例 `repo`（第一次调用方法时才开默认库），方便工具层直接 import：
 *   import { repo } from '../store/repo.js';
 *   repo.msgsByScene(3);
 *
 * 行对象一律是 camelCase（与 BUILD-PLAN §3.1 的 MsgRow 对齐），
 * 入参同时接受 camelCase 和 snake_case —— 各轨道自己造对象时不必记列名。
 *
 * 写操作事务：多条语句的写（insertMsgs / deleteMsgsBySeq / upsertFact / insertBeat）
 * 全部走 withTx，要么全成要么全回滚；单条语句本身靠 SQLite 的隐式事务保证原子。
 * `deleteMsgsBySeq` 是物理删除（D-119）。
 *
 * 软排除（D-169/170）：`msg.excluded=1` 入库存着但检索不到。
 * 检索方法（msgsByTimeRange / msgsByScene / msgsAround 的邻居 / search.keyword）
 * 默认带 `WHERE excluded = 0`，要核实就传 `includeExcluded: true`；
 * `msgsByIds` 是查表不是检索，始终不过滤（带 excluded 字段供上层判断）。
 */

import { DatabaseSync } from 'node:sqlite';
import {
  createAuditExtras,
  createFlagExtras,
  createNoteExtras,
  createSceneAssignExtras,
  createVecMetaExtras,
} from './repo-extras-meta.js';
import {
  createChunkExtras,
  createMediaExtras,
  createSearchExtras,
  createStatsExtras,
  createWindowExtras,
} from './repo-extras-search.js';
import { openDb } from './db.js';

/** beat 的合法类型（BUILD-PLAN.md §4.3，12 类） */
export const BEAT_KINDS = Object.freeze([
  'vuln', 'seek', 'tease', 'conflict', 'apology', 'intimacy',
  'probe', 'avoid', 'promise', 'boundary', 'share', 'care',
]);

/* ================================ 工具函数 ================================ */

/**
 * 取第一个非 undefined 的字段值（兼容 camelCase / snake_case 两种入参）。
 * @param {object} row
 * @param {...string} names
 */
function field(row, ...names) {
  for (const n of names) {
    if (row?.[n] !== undefined) return row[n];
  }
  return undefined;
}

/**
 * SQLite 参数只接受 null / number / bigint / string / Uint8Array。
 * undefined 会报 "Provided value cannot be bound"，boolean 也不行。
 * @param {unknown} v
 */
function param(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** lead_in 允许传数组/对象，落库统一转 JSON 字符串 */
function toJsonText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** 必填字段校验，报错信息直接指出缺哪个 */
function required(row, names, method) {
  const v = field(row, ...names);
  if (v === undefined || v === null || v === '') {
    throw new TypeError(`${method}: 缺少必填字段 ${names[0]}`);
  }
  return v;
}

/* ========================= 向量表的连带清理 =========================
 * 「删原文 / 删场景」和「删它们的向量」必须一起发生（D-118）：
 * 否则被撤回的话会从向量路复活。repo（msg）和 extras（scene）都要用，
 * 所以放在模块级，按 db 参数化。
 * ================================================================== */

/**
 * 普通表是否存在（含降级模式的两张 BLOB 表）。
 *
 * **故意不缓存**：`vec_fallback_*` 是向量层按需创建的，进程里可能
 * 「先没有、后才有」，缓存一个 false 会让后面所有清理静默跳过。
 * 只有删除路径会调它，一次 sqlite_master 查询的成本可以忽略。
 *
 * @param {object} db
 * @param {string} name
 */
function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(name));
  } catch {
    return false;
  }
}

/**
 * 删掉这些 id 的向量 —— **vec0 虚表和降级 BLOB 表都要清**。
 *
 * 为什么必须两处都清（R5 实测的 P1）：`hasVec=false` 时向量全在
 * `vec_fallback_msg` / `vec_fallback_scene` 里，原实现只清 `vec_msg`，
 * 于是 rewind 之后被撤回那条的向量还躺在降级表里。
 * 之前「孤儿向量 JOIN 不上 msg、召回不了」的说法**在 id 复用时是错的**：
 * 没有 AUTOINCREMENT 时新消息会拿到同一个 id，旧向量就被认到新消息头上
 * （实测 score=1.0000）。库结构已改成 id 永不复用（v5），这里再把持久化
 * 状态清干净，两层一起堵。
 *
 * 永不抛：清理失败不该让 rewind / 场景重建本身失败。
 *
 * @param {object} db
 * @param {'msg'|'scene'} kind
 * @param {number[]} ids
 * @returns {number} 实际删掉的向量行数（两张表加起来）
 */
const VEC_TABLE_MAP = {
  msg: { vec: 'vec_msg', fk: 'msg_id', fb: 'vec_fallback_msg' },
  scene: { vec: 'vec_scene', fk: 'scene_id', fb: 'vec_fallback_scene' },
  chunk: { vec: 'vec_chunk', fk: 'chunk_id', fb: 'vec_fallback_chunk' },
  note: { vec: 'vec_note', fk: 'note_id', fb: 'vec_fallback_note' },
  window: { vec: 'vec_window', fk: 'window_id', fb: 'vec_fallback_window' },
};

export function deleteVecRows(db, kind, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const spec = VEC_TABLE_MAP[kind];
  if (!spec) return 0;
  const { vec: vecTable, fk: fkColumn, fb: fallbackTable } = spec;
  let removed = 0;

  // ① vec0 虚表：库里有这张表才删；扩展没装时删会报错，咽掉
  //    （持久化那份由下面 ② 兜住；降级模式下数据本来就在 ②）
  if (tableExists(db, vecTable)) {
    try {
      const del = db.prepare(`DELETE FROM ${vecTable} WHERE ${fkColumn} = ?`);
      for (const id of ids) removed += Number(del.run(BigInt(Number(id))).changes); // D-149 坑②
    } catch {
      // 扩展未加载：vec 表不可写。这件事不该让调用方失败。
    }
  }

  // ② 降级 BLOB 表：普通表，不需要扩展，任何时候都能清
  if (tableExists(db, fallbackTable)) {
    try {
      const del = db.prepare(`DELETE FROM ${fallbackTable} WHERE ${fkColumn} = ?`);
      for (const id of ids) removed += Number(del.run(Number(id)).changes);
    } catch {
      // 表结构异常时同样不拦调用方
    }
  }
  return removed;
}

/* ================================ 行映射 ================================ */

/** msg 表行 → MsgRow（BUILD-PLAN §3.1 的字段 + D-170 的 excluded） */
function mapMsg(r) {
  return {
    id: Number(r.id),
    sessionId: r.session_id,
    seq: Number(r.seq),
    at: Number(r.at),
    speaker: r.speaker,
    text: r.text,
    inSurface: Number(r.in_surface),
    compactedAt: r.compacted_at === null || r.compacted_at === undefined ? null : Number(r.compacted_at),
    excluded: Number(r.excluded ?? 0),
    sceneId: r.scene_id === null || r.scene_id === undefined ? null : Number(r.scene_id),
  };
}

/** scene 表行 → SceneRow（leadIn 保持原始 JSON 字符串，调用方自行 parse） */
function mapScene(r) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  const b = (v) => Number(v ?? 0); // 派生字段：0/1
  return {
    id: Number(r.id),
    sessionId: r.session_id,
    startAt: Number(r.start_at),
    endAt: Number(r.end_at),
    msgCount: Number(r.msg_count),
    // T3 的派生字段（D-195）：落库后原样返回，消费者不要再自己算
    hasExcluded: b(r.has_excluded),
    excludedCount: b(r.excluded_count),
    hasOutOfSurface: b(r.has_out_of_surface),
    outOfSurfaceCount: b(r.out_of_surface_count),
    crossesCompaction: b(r.crosses_compaction),
    compactedCount: b(r.compacted_count),
    gapBeforeMs: n(r.gap_before_ms),
    gapAfterMs: n(r.gap_after_ms),
    precededBy: n(r.preceded_by),
    followedBy: n(r.followed_by),
    leadIn: r.lead_in ?? null,
    gist: r.gist ?? null,
    gistSource: r.gist_source ?? null,
    locked: b(r.locked),
    createdAt: Number(r.created_at),
  };
}

/** fact 表行 → FactRow */
function mapFact(r) {
  return {
    id: Number(r.id),
    subject: r.subject,
    key: r.key,
    value: r.value,
    sourceKind: r.source_kind,
    sourceSeq: Number(r.source_seq),
    origin: r.origin,
    createdAt: Number(r.created_at),
    sessionId: r.session_id ?? null,
  };
}

/** beat 表行 → BeatRow（beatsByKind 会多带 msg 的 at/seq 便于按时间排） */
function mapBeat(r) {
  const row = {
    id: Number(r.id),
    msgId: Number(r.msg_id),
    kind: r.kind,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    createdAt: Number(r.created_at),
  };
  if (r.msg_at !== undefined) row.msgAt = Number(r.msg_at);
  if (r.msg_seq !== undefined) row.msgSeq = Number(r.msg_seq);
  if (r.session_id !== undefined) row.sessionId = r.session_id;
  return row;
}

/** flag 表行 → 标记行（list/count 会 JOIN msg 带出 sessionId / msgSeq / msgAt 供核对页用） */
function mapFlag(r) {
  return {
    id: Number(r.id),
    msgId: Number(r.msg_id),
    reason: r.reason ?? null,
    at: Number(r.at),
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
    sessionId: r.session_id ?? null,
    msgSeq: r.msg_seq === undefined ? null : Number(r.msg_seq),
    msgAt: r.msg_at === undefined ? null : Number(r.msg_at),
  };
}

/**
 * note 表行 → 笔记（**含 sessionId**：A1 会话隔离要按它过滤）。
 *
 * `sessionId: null` 表示 v5 及更早的遗留笔记（那时没有归属概念），
 * 迁移 v5→v6 会在能确定归属时回填，多会话时保持 null（见 db.js）。
 */
function mapNote(r) {
  return {
    id: Number(r.id),
    content: r.content,
    about: r.about ?? null,
    at: Number(r.at),
    deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
    sessionId: r.session_id ?? null,
  };
}

/* ================================ 仓储实现 ================================ */

/**
 * 创建一套仓储方法。
 * @param {DatabaseSync | { db: DatabaseSync }} handle openDb() 的返回值，或裸 DatabaseSync
 * @returns {Record<string, any>} 严格实现 BUILD-PLAN.md §3.1 的接口
 */
export function createRepo(handle) {
  const db = handle instanceof DatabaseSync ? handle : handle?.db;
  if (!db) throw new TypeError('createRepo: 需要 DatabaseSync 实例或 openDb() 返回的 handle');

  /** 预编译语句缓存：按 SQL 文本复用，避免每次调用都重新 prepare */
  const stmtCache = new Map();

  /** @param {string} sql */
  function stmt(sql) {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmtCache.set(sql, s);
    }
    return s;
  }

  /** 事务包装。嵌套调用自动用 SAVEPOINT（实现见模块级 withTx） */
  const tx = (fn) => withTx(db, fn);

  /* ------------------------------- 写入 ------------------------------- */

  /**
   * 插入一条消息，返回自增 id。
   *
   * 幂等：同一 (session_id, seq) 重复插入时按 upsert 处理（更新原文与标记，
   * 保留原 id）—— 全量重导一遍不会炸 UNIQUE，也不会把 scene_id 弄丢。
   * 这条对 T8 的"重跑导入"很关键。
   *
   * excluded（D-169/170）：1 = 软排除，入库存着但检索默认跳过。
   * 不传时插入用 0；重复导入时保留库里的旧值（重导日志不会把已排除的又放出来）。
   *
   * @param {object} row
   * @returns {number}
   */
  function insertMsg(row) {
    const sessionId = required(row, ['sessionId', 'session_id'], 'insertMsg');
    const seq = param(required(row, ['seq'], 'insertMsg'));
    const at = param(required(row, ['at'], 'insertMsg'));
    const speaker = required(row, ['speaker'], 'insertMsg');
    const text = required(row, ['text'], 'insertMsg');
    if (speaker !== 'user' && speaker !== 'assistant') {
      throw new TypeError(`insertMsg: speaker 只能是 'user' 或 'assistant'，收到 ${String(speaker)}`);
    }
    const inSurface = param(field(row, 'inSurface', 'in_surface') ?? 1);
    const compactedAt = param(field(row, 'compactedAt', 'compacted_at') ?? null);
    const sceneId = param(field(row, 'sceneId', 'scene_id') ?? null);
    const excludedRaw = field(row, 'excluded');
    const excluded = excludedRaw === undefined ? null : Number(excludedRaw) ? 1 : 0;

    const got = stmt(
      `INSERT INTO msg (session_id, seq, at, speaker, text, in_surface, compacted_at, excluded, scene_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET
         at = excluded.at,
         speaker = excluded.speaker,
         text = excluded.text,
         in_surface = excluded.in_surface,
         compacted_at = excluded.compacted_at,
         excluded = COALESCE(?, msg.excluded),
         scene_id = COALESCE(excluded.scene_id, msg.scene_id)
       RETURNING id`,
    ).get(sessionId, seq, at, speaker, text, inSurface, compactedAt, excluded ?? 0, sceneId, excluded);
    return Number(got.id);
  }

  /**
   * 批量插入，返回与入参同序的 id 数组。整批一个事务，失败全部回滚。
   * @param {object[]} rows
   * @returns {number[]}
   */
  function insertMsgs(rows) {
    if (!Array.isArray(rows)) throw new TypeError('insertMsgs: 需要数组');
    if (rows.length === 0) return [];
    return tx(() => rows.map((r) => insertMsg(r)));
  }

  /**
   * 物理删除某会话 seq >= fromSeq 的全部消息（rewind 用，D-119）。
   *
   * 为什么必须物理删而不是打标记：被撤回的内容"记了就等于撤回失效"（D-118）。
   * **同时清向量**（vec_msg 虚表 + vec_fallback_* 降级表，见 deleteVecRows）——
   * 只删原文不清向量的话，向量路会把已撤回的话召回给一条新消息（R5 实测 P1）。
   * beat / media 靠 ON DELETE CASCADE 跟着走。
   *
   * @param {string} sessionId
   * @param {number} fromSeq 包含该 seq
   * @returns {number} 实际删除的消息条数
   */
  function runWithFtsHeal(fn) {
    try {
      return fn();
    } catch (err) {
      if (!/malformed|corrupt/i.test(String(err?.message ?? err))) throw err;
      db.exec("INSERT INTO msg_fts(msg_fts) VALUES('rebuild')");
      return fn();
    }
  }

  function deleteMsgsBySeq(sessionId, fromSeq) {
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      throw new TypeError('deleteMsgsBySeq: 缺少 sessionId');
    }
    if (fromSeq === undefined || fromSeq === null) {
      throw new TypeError('deleteMsgsBySeq: 缺少 fromSeq');
    }
    const sid = sessionId;
    const from = param(fromSeq);
    return runWithFtsHeal(() => tx(() => {
      const ids = stmt('SELECT id FROM msg WHERE session_id = ? AND seq >= ?').all(sid, from).map((r) => Number(r.id));
      if (ids.length === 0) return 0;
      const chunkIds = [];
      const CHUNK = 400;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        for (const r of stmt(`SELECT id FROM chunk WHERE msg_id IN (${slice.map(() => '?').join(', ')})`).all(...slice)) {
          chunkIds.push(Number(r.id));
        }
      }
      if (chunkIds.length > 0) deleteVecRows(db, 'chunk', chunkIds);
      deleteVecRows(db, 'msg', ids);
      const info = stmt('DELETE FROM msg WHERE session_id = ? AND seq >= ?').run(sid, from);
      return Number(info.changes);
    }));
  }

  /**
   * 物理删除某会话里 seq ∈ seqs 的消息（rewind 的精确差集，D-119/D-118）。
   *
   * 为什么不直接用 `seq >= X`：rewind 之后新到的消息 seq 也 >= X，它们是存活的。
   * 编排层必须先算差集（库里已有、但本轮存活集合里没有的 seq），再调这里 ——
   * 这样「删」的那几条和它们的向量是同一步、同一事务处理的，
   * 不会出现"原文删了、向量还躺着"的中间状态。
   *
   * @param {string} sessionId
   * @param {number[]} seqs
   * @returns {number} 实际删除的消息条数
   */
  function deleteMsgsBySeqs(sessionId, seqs) {
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      throw new TypeError('deleteMsgsBySeqs: 缺少 sessionId');
    }
    const list = [...new Set((Array.isArray(seqs) ? seqs : []).map(Number).filter((n) => Number.isFinite(n)))];
    if (list.length === 0) return 0;
    const sid = sessionId;
    return runWithFtsHeal(() => tx(() => {
      let deleted = 0;
      const CHUNK = 400; // 别撞 SQLite 的变量上限
      const pickIds = [];
      for (let i = 0; i < list.length; i += CHUNK) {
        const slice = list.slice(i, i + CHUNK);
        const sql = `SELECT id FROM msg WHERE session_id = ? AND seq IN (${slice.map(() => '?').join(', ')})`;
        for (const r of stmt(sql).all(sid, ...slice)) pickIds.push(Number(r.id));
      }
      if (pickIds.length === 0) return 0;
      const chunkIds = [];
      for (let i = 0; i < pickIds.length; i += CHUNK) {
        const slice = pickIds.slice(i, i + CHUNK);
        for (const r of stmt(`SELECT id FROM chunk WHERE msg_id IN (${slice.map(() => '?').join(', ')})`).all(...slice)) {
          chunkIds.push(Number(r.id));
        }
      }
      if (chunkIds.length > 0) deleteVecRows(db, 'chunk', chunkIds);
      deleteVecRows(db, 'msg', pickIds); // ← 向量和原文一起删（D-118）
      const del = stmt('DELETE FROM msg WHERE id = ?');
      for (const id of pickIds) deleted += Number(del.run(id).changes);
      return deleted;
    }));
  }

  /* ------------------------------- 消息查询 ------------------------------ */

  /**
   * 按 id 批量取消息，返回顺序与入参一致（去重，不存在的 id 跳过）。
   *
   * **这里不过滤 excluded**：它是"按 id 取行"的查表工具，不是检索路径。
   * 检索结果都是从 msgsByTimeRange / msgsByScene / search 出来的，那里已经过滤过；
   * 而 T7 判断"这个 id 是不是一条 msg"必须能看见被排除的行，否则会把已有的 id 报成不存在。
   * 需要"这条能不能展示"的判断，看返回行的 excluded 字段。
   *
   * @param {number[]} ids
   * @returns {object[]}
   */
  function msgsByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const uniq = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))];
    if (uniq.length === 0) return [];
    const out = new Map();
    // 分块，避免 1 万个 ? 占位符撞上 SQLite 变量上限
    const CHUNK = 500;
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const chunk = uniq.slice(i, i + CHUNK);
      const marks = chunk.map(() => '?').join(',');
      const rows = stmt(`SELECT * FROM msg WHERE id IN (${marks})`).all(...chunk);
      for (const r of rows) out.set(Number(r.id), mapMsg(r));
    }
    return uniq.map((id) => out.get(id)).filter(Boolean);
  }

  /**
   * 取时间区间 [from, to) 内的消息，按时间升序。
   *
   * 默认跳过软排除的消息（D-169/170）；`includeExcluded` 只给"核实用"开。
   *
   * @param {string|null} sessionId 传 null 表示不限会话
   * @param {number} from 含
   * @param {number} to 不含
   * @param {number} [limit] 默认 500
   * @param {boolean} [includeExcluded=false] true 时把 excluded=1 的也取出来
   * @returns {object[]}
   */
  function msgsByTimeRange(sessionId, from, to, limit = 500, includeExcluded = false) {
    const lim = param(limit ?? 500);
    const notExcluded = includeExcluded ? '' : ' AND excluded = 0';
    const rows = sessionId
      ? stmt(
          `SELECT * FROM msg WHERE session_id = ? AND at >= ? AND at < ?${notExcluded}
           ORDER BY at ASC, seq ASC LIMIT ?`,
        ).all(sessionId, param(from), param(to), lim)
      : stmt(
          `SELECT * FROM msg WHERE at >= ? AND at < ?${notExcluded}
           ORDER BY at ASC, seq ASC LIMIT ?`,
        ).all(param(from), param(to), lim);
    return rows.map(mapMsg);
  }

  /**
   * 取某场景下的全部消息，按 seq 升序。默认跳过软排除（D-169/170）。
   * @param {number} sceneId
   * @param {boolean} [includeExcluded=false]
   * @returns {object[]}
   */
  function msgsByScene(sceneId, includeExcluded = false) {
    const sql = includeExcluded
      ? 'SELECT * FROM msg WHERE scene_id = ? ORDER BY seq ASC'
      : 'SELECT * FROM msg WHERE scene_id = ? AND excluded = 0 ORDER BY seq ASC';
    return stmt(sql).all(param(sceneId)).map(mapMsg);
  }

  /**
   * 取某条消息的前后邻居（含该条本身），按 seq 升序 —— 邻接/前情用。
   *
   * excluded 语义（D-170 定稿）：「周围」= 时间上相邻，**先按 seq 取 N 条，再过滤**。
   *   - 先取 anchor 前 before 条 + anchor + 后 after 条（不预过滤），保证时间连续；
   *   - 再滤掉 excluded 的邻居：宁可返回 3 条而不是 5 条，也不跨段拼接；
   *     中间夹着整段被排除的内容时，不会跨过去抓更早的消息当"前文"。
   *   - 锚点**无条件返回**（哪怕它自己被排除）：TA明确要看这条，不能表现成"不存在"；
   *     所以最坏情况是只剩锚点一条，不会是空数组。
   *   - `includeExcluded=true` 时邻居也带上（核实用，看被排除那段的完整上下文）。
   *
   * @param {number} msgId
   * @param {number} [before] 前几条，默认 2
   * @param {number} [after] 后几条，默认 2
   * @param {boolean} [includeExcluded=false] 邻居是否带上被排除的消息
   * @returns {object[]}
   */
  function msgsAround(msgId, before = 2, after = 2, includeExcluded = false) {
    // 锚点查询不过滤 excluded：见上面的语义说明
    const anchor = stmt('SELECT * FROM msg WHERE id = ?').get(param(msgId));
    if (!anchor) return [];
    const takeBefore = Math.max(0, Number(before) || 0);
    const takeAfter = Math.max(0, Number(after) || 0);

    // ① 先按 seq 取连续窗口（不过滤）
    const prev = stmt(
      `SELECT * FROM msg WHERE session_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
    )
      .all(anchor.session_id, anchor.seq, param(takeBefore))
      .reverse();
    const next = stmt(
      `SELECT * FROM msg WHERE session_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
    ).all(anchor.session_id, anchor.seq, param(takeAfter));

    // ② 再过滤 excluded 邻居（锚点永远保留）
    const window = [...prev, anchor, ...next];
    const kept = includeExcluded
      ? window
      : window.filter((r) => Number(r.id) === Number(anchor.id) || Number(r.excluded ?? 0) === 0);
    return kept.map(mapMsg);
  }

  /* -------------------------------- 场景 -------------------------------- */

  /**
   * 插入一场对话，返回 id。
   *
   * D-195：T3 算出来的 6 个派生字段（hasExcluded / excludedCount / hasOutOfSurface /
   * outOfSurfaceCount / crossesCompaction / compactedCount）一起写进库，
   * 不传就默认 0。消费者（T4/T8/面板）直接读，不要自己再算一遍。
   *
   * @param {object} scene
   * @returns {number}
   */
  function insertScene(scene) {
    const sessionId = required(scene, ['sessionId', 'session_id'], 'insertScene');
    const startAt = param(required(scene, ['startAt', 'start_at'], 'insertScene'));
    const endAt = param(required(scene, ['endAt', 'end_at'], 'insertScene'));
    const msgCount = param(required(scene, ['msgCount', 'msg_count'], 'insertScene'));
    const flag = (camel, snake) => (Number(field(scene, camel, snake) ? 1 : 0) ? 1 : 0);
    const count = (camel, snake) => param(Number(field(scene, camel, snake) ?? 0) || 0);
    const got = stmt(
      `INSERT INTO scene
         (session_id, start_at, end_at, msg_count,
          has_excluded, excluded_count, has_out_of_surface, out_of_surface_count,
          crosses_compaction, compacted_count,
          gap_before_ms, gap_after_ms, preceded_by, followed_by, lead_in, gist, gist_source, locked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    ).get(
      sessionId,
      startAt,
      endAt,
      msgCount,
      flag('hasExcluded', 'has_excluded'),
      count('excludedCount', 'excluded_count'),
      flag('hasOutOfSurface', 'has_out_of_surface'),
      count('outOfSurfaceCount', 'out_of_surface_count'),
      flag('crossesCompaction', 'crosses_compaction'),
      count('compactedCount', 'compacted_count'),
      param(field(scene, 'gapBeforeMs', 'gap_before_ms') ?? null),
      param(field(scene, 'gapAfterMs', 'gap_after_ms') ?? null),
      param(field(scene, 'precededBy', 'preceded_by') ?? null),
      param(field(scene, 'followedBy', 'followed_by') ?? null),
      param(toJsonText(field(scene, 'leadIn', 'lead_in')) ?? null),
      param(field(scene, 'gist') ?? null),
      param(field(scene, 'gistSource', 'gist_source') ?? null),
      flag('locked', 'locked'),
      param(field(scene, 'createdAt', 'created_at') ?? Date.now()),
    );
    return Number(got.id);
  }

  /**
   * 取一场，没有返回 null。
   * @param {number} id
   * @returns {object|null}
   */
  function sceneById(id) {
    const r = stmt('SELECT * FROM scene WHERE id = ?').get(param(id));
    return r ? mapScene(r) : null;
  }

  /**
   * 取与 [from, to) 有交集的场景（时间路，IMPLEMENTATION.md §7.2），按开始时间升序。
   * @param {string|null} sessionId null 表示不限会话
   * @param {number} from
   * @param {number} to
   * @param {number} [limit] 默认 20
   * @returns {object[]}
   */
  function scenesByTimeRange(sessionId, from, to, limit = 20) {
    const lim = param(limit ?? 20);
    const rows = sessionId
      ? stmt(
          `SELECT * FROM scene WHERE session_id = ? AND start_at < ? AND end_at >= ?
           ORDER BY start_at ASC LIMIT ?`,
        ).all(sessionId, param(to), param(from), lim)
      : stmt(
          `SELECT * FROM scene WHERE start_at < ? AND end_at >= ?
           ORDER BY start_at ASC LIMIT ?`,
        ).all(param(to), param(from), lim);
    return rows.map(mapScene);
  }

  /**
   * 回填邻接信息。只更新传入的字段，undefined 的字段保持原值（T3 分两次回填不会互相覆盖）。
   * @param {number} id
   * @param {{precededBy?: number|null, followedBy?: number|null,
   *          gapBeforeMs?: number|null, gapAfterMs?: number|null, leadIn?: any}} links
   * @returns {void}
   */
  function updateSceneLinks(id, links = {}) {
    const sets = [];
    const vals = [];
    const add = (col, value) => {
      sets.push(`${col} = ?`);
      vals.push(param(value));
    };
    const precededBy = field(links, 'precededBy', 'preceded_by');
    if (precededBy !== undefined) add('preceded_by', precededBy);
    const followedBy = field(links, 'followedBy', 'followed_by');
    if (followedBy !== undefined) add('followed_by', followedBy);
    const gapBeforeMs = field(links, 'gapBeforeMs', 'gap_before_ms');
    if (gapBeforeMs !== undefined) add('gap_before_ms', gapBeforeMs);
    const gapAfterMs = field(links, 'gapAfterMs', 'gap_after_ms');
    if (gapAfterMs !== undefined) add('gap_after_ms', gapAfterMs);
    const leadIn = field(links, 'leadIn', 'lead_in');
    if (leadIn !== undefined) add('lead_in', toJsonText(leadIn));
    if (sets.length === 0) return;
    vals.push(param(id));
    stmt(`UPDATE scene SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** 写场景 gist（只做检索锚点，永不注入，D-035） */
  function setSceneGist(sceneId, gist, opts = {}) {
    const source = opts && Object.prototype.hasOwnProperty.call(opts, 'source')
      ? opts.source
      : (gist ? 'llm' : null);
    stmt('UPDATE scene SET gist = ?, gist_source = ? WHERE id = ?').run(
      param(gist ?? null),
      param(source ?? null),
      param(sceneId),
    );
  }

  /* ------------------------------- 派生层 ------------------------------- */

  /**
   * 写入/更新一条事实，返回 id。
   *
   * upsert 语义：带了 id 按 id 更新；否则按 (subject, key) 找已有行更新。
   * 更新时不改 created_at（保留首次提炼时间），只刷新 value / 来源。
   * 结构化校验（speaker='user'、inSurface=1、长度上限）属于 T5 的职责，
   * 这里只兜住 schema 级别的 CHECK（subject 三值）。
   *
   * @param {object} fact
   * @returns {number}
   */
  function upsertFact(fact) {
    const subject = required(fact, ['subject'], 'upsertFact');
    const key = required(fact, ['key'], 'upsertFact');
    const value = required(fact, ['value'], 'upsertFact');
    const sourceSeq = param(required(fact, ['sourceSeq', 'source_seq'], 'upsertFact'));
    const origin = required(fact, ['origin'], 'upsertFact');
    const sourceKind = param(field(fact, 'sourceKind', 'source_kind') ?? 'msg');
    const now = param(field(fact, 'createdAt', 'created_at') ?? Date.now());
    const sessionId = param(field(fact, 'sessionId', 'session_id') ?? null);

    const id = field(fact, 'id');
    // SELECT + UPDATE/INSERT 是两条语句，放进同一个事务，避免并发下建出重复 fact
    return tx(() => {
      let existing = null;
      if (id) {
        existing = stmt('SELECT id FROM fact WHERE id = ?').get(param(id));
      } else if (sessionId !== null) {
        existing = stmt('SELECT id FROM fact WHERE session_id = ? AND subject = ? AND key = ? ORDER BY id DESC LIMIT 1')
          .get(sessionId, subject, key);
      } else {
        existing = stmt('SELECT id FROM fact WHERE session_id IS NULL AND subject = ? AND key = ? ORDER BY id DESC LIMIT 1')
          .get(subject, key);
      }

      if (existing) {
        stmt(
          `UPDATE fact SET subject = ?, key = ?, value = ?, source_kind = ?,
               source_seq = ?, origin = ?, session_id = COALESCE(?, session_id)
           WHERE id = ?`,
        ).run(subject, key, value, sourceKind, sourceSeq, origin, sessionId, existing.id);
        return Number(existing.id);
      }

      const got = stmt(
        `INSERT INTO fact (subject, key, value, source_kind, source_seq, origin, created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      ).get(subject, key, value, sourceKind, sourceSeq, origin, now, sessionId);
      return Number(got.id);
    });
  }

  /**
   * 取某个 subject 下的事实，按创建时间倒序（新的先）。
   * @param {'me'|'her'|'us'} subject
   * @param {number} [limit] 默认 50
   * @param {string|null} [sessionId] 可选会话过滤
   * @returns {object[]}
   */
  function factsBySubject(subject, limit = 50, sessionId = null) {
    if (typeof sessionId === 'string' && sessionId.trim()) {
      return stmt('SELECT * FROM fact WHERE session_id = ? AND subject = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(param(sessionId.trim()), param(subject), param(limit ?? 50))
        .map(mapFact);
    }
    return stmt('SELECT * FROM fact WHERE subject = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(param(subject), param(limit ?? 50))
      .map(mapFact);
  }

  /**
   * 写一条互动类型标记（一条消息可属多类，分开存，D-104）。
   *
   * 同一条消息的同一 kind 重复写入时更新 confidence（不是新增一行），
   * 这样 T5 重跑分类不会把 beat 表刷出一堆重复行。
   *
   * @param {number} msgId
   * @param {string} kind 12 类之一
   * @param {number|null} [confidence] 拿不准就 < 0.6，不硬分
   * @returns {void}
   */
  function insertBeat(msgId, kind, confidence = null) {
    if (!BEAT_KINDS.includes(kind)) {
      throw new TypeError(`insertBeat: 非法 kind ${String(kind)}，合法值见 BEAT_KINDS`);
    }
    if (msgId === undefined || msgId === null) throw new TypeError('insertBeat: 缺少 msgId');
    tx(() => {
      const existing = stmt('SELECT id FROM beat WHERE msg_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(
        param(msgId),
        kind,
      );
      if (existing) {
        stmt('UPDATE beat SET confidence = ? WHERE id = ?').run(param(confidence), existing.id);
        return;
      }
      stmt('INSERT INTO beat (msg_id, kind, confidence, created_at) VALUES (?, ?, ?, ?)').run(
        param(msgId),
        kind,
        param(confidence),
        Date.now(),
      );
    });
  }

  /**
   * 取某类互动的全部实例，按消息时间升序（发展通道看的就是时间序列，D-104）。
   * @param {string} kind
   * @param {number} [limit] 默认 200
   * @returns {object[]}
   */
  function beatsByKind(kind, limit = 200) {
    return stmt(
      `SELECT b.*, m.at AS msg_at, m.seq AS msg_seq, m.session_id
       FROM beat b JOIN msg m ON m.id = b.msg_id
       WHERE b.kind = ? AND m.excluded = 0
       ORDER BY m.at ASC, m.seq ASC
       LIMIT ?`,
    )
      .all(param(kind), param(limit ?? 200))
      .map(mapBeat);
  }

  return {
    // 写入
    insertMsg,
    insertMsgs,
    deleteMsgsBySeq,
    deleteMsgsBySeqs, // v5 新增：rewind 的精确差集删除（向量同事务一起清）
    // 查询
    msgsByIds,
    msgsByTimeRange,
    msgsByScene,

    msgsAround,
    // 场景
    insertScene,
    sceneById,
    scenesByTimeRange,
    updateSceneLinks,
    // 派生层
    upsertFact,
    factsBySubject,
    insertBeat,
    beatsByKind,
    setSceneGist,
  };
}

/* ============================== 附加命名空间 ==============================
 * 下面这些不在 BUILD-PLAN §3.1 的 repo 契约里（那边明确"一个不多一个不少"），
 * 但其他轨道确实需要、且不该自己写 SQL，所以单列命名空间，不污染 repo：
 *
 *   extras.note.*       —— T7 remember / forget 用（note 表）
 *   extras.audit.*      —— T7 审计用（audit 表）
 *   extras.vecMeta.*    —— T6 向量索引用（msg.vec_model / vec_dim，D-152）
 *   extras.sceneAssign.*—— T3 / T8 把 msg 挂到 scene 上、重建场景用
 *   extras.search.*     —— T4 关键词路的 SQL 原语（§8.1 双路：FTS trigram + LIKE 兜底）
 *   extras.stats.*      —— T4 空结果时报告库范围用
 *   extras.flag.*       —— 核对页"这条有问题"留痕（D-167/168：只记一笔，不影响检索）
 * ======================================================================== */

/**
 * 创建附加命名空间（与 repo 共用一个 db，事务也共用）。
 * @param {DatabaseSync | { db: DatabaseSync }} handle
 */
export function createExtras(handle) {
  const db = handle instanceof DatabaseSync ? handle : handle?.db;
  if (!db) throw new TypeError('createExtras: 需要 DatabaseSync 实例或 openDb() 返回的 handle');

  const cache = new Map();
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  }
  const p = param;

  const note = createNoteExtras({ stmt, p, required, field, mapNote });
  const audit = createAuditExtras({ stmt, p, required, toJsonText });
  const vecMeta = createVecMetaExtras({ db, stmt, p, withTx, mapMsg });
  const sceneAssign = createSceneAssignExtras({ db, stmt, p, withTx, deleteVecRows });
  const search = createSearchExtras({ stmt, p, mapMsg });
  const stats = createStatsExtras({ stmt, p });
  const flag = createFlagExtras({ stmt, p, mapFlag });
  const chunk = createChunkExtras({ stmt, p });
  const media = createMediaExtras({ db, stmt, p, withTx });
  const windowOps = createWindowExtras({ db, stmt, p, withTx, deleteVecRows });

  return { note, audit, vecMeta, sceneAssign, search, stats, flag, chunk, media, window: windowOps };
}

/**
 * 每个 db 连接上的事务嵌套层级（repo 与 extras 共用，跨命名空间也不会撞车）。
 * @type {WeakMap<DatabaseSync, number>}
 */
const txDepthOf = new WeakMap();

/**
 * 事务包装：最外层 BEGIN IMMEDIATE，嵌套层用 SAVEPOINT。
 * 所有写操作都走这里 —— 多条语句要么全成，要么全回滚。
 *
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTx(db, fn) {
  const depth = txDepthOf.get(db) ?? 0;
  if (depth > 0) {
    const sp = `sp_${depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    txDepthOf.set(db, depth + 1);
    try {
      const out = fn();
      db.exec(`RELEASE ${sp}`);
      return out;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch {
        // 回滚都失败就只能把原始错误抛出去
      }
      throw error;
    } finally {
      txDepthOf.set(db, depth);
    }
  }

  db.exec('BEGIN IMMEDIATE');
  txDepthOf.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 忽略：连接已坏时 ROLLBACK 也会失败
    }
    throw error;
  } finally {
    txDepthOf.set(db, 0);
  }
}

/* ============================== 默认单例 ==============================
 * 懒加载：import 不打开库，第一次真调用方法时才开默认库。
 * 好处是测试里 import 本文件不会在 ~/.dsh 下建库。
 * ==================================================================== */

let defaultHandle = null;
let defaultRepo = null;
let defaultExtras = null;

/** 取默认库的 handle（$DSH_HOME/verbatim/memory.db） */
export function getDefaultHandle() {
  if (!defaultHandle) defaultHandle = openDb();
  return defaultHandle;
}

/** 取默认 repo 实例 */
export function getDefaultRepo() {
  if (!defaultRepo) defaultRepo = createRepo(getDefaultHandle().db);
  return defaultRepo;
}

/** 取默认 extras 实例 */
export function getDefaultExtras() {
  if (!defaultExtras) defaultExtras = createExtras(getDefaultHandle().db);
  return defaultExtras;
}

/** 关闭默认库（测试/退出时用） */
export function closeDefault() {
  defaultHandle?.close();
  defaultHandle = null;
  defaultRepo = null;
  defaultExtras = null;
}

/**
 * `repo` 单例：按 BUILD-PLAN §3.1 直接以对象形态使用（`repo.insertMsg(...)`）。
 *
 * 为什么用 Proxy：import 本模块时不该真去开库（测试里会污染 ~/.dsh），
 * 第一次读属性时才创建默认实例。所有方法是闭包、不依赖 this，所以直接转发即可。
 */
export const repo = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return getDefaultRepo()[prop];
    },
    has(_target, prop) {
      return typeof prop === 'string' && prop in getDefaultRepo();
    },
    ownKeys() {
      return Reflect.ownKeys(getDefaultRepo());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const instance = getDefaultRepo();
      if (typeof prop !== 'string' || !(prop in instance)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: instance[prop],
      };
    },
  },
);


