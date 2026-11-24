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
 * @returns {object} 严格实现 BUILD-PLAN.md §3.1 的接口
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

    const id = field(fact, 'id');
    // SELECT + UPDATE/INSERT 是两条语句，放进同一个事务，避免并发下建出重复 fact
    return tx(() => {
      const existing = id
        ? stmt('SELECT id FROM fact WHERE id = ?').get(param(id))
        : stmt('SELECT id FROM fact WHERE subject = ? AND key = ? ORDER BY id DESC LIMIT 1').get(subject, key);

      if (existing) {
        stmt(
          `UPDATE fact SET subject = ?, key = ?, value = ?, source_kind = ?,
               source_seq = ?, origin = ?
           WHERE id = ?`,
        ).run(subject, key, value, sourceKind, sourceSeq, origin, existing.id);
        return Number(existing.id);
      }

      const got = stmt(
        `INSERT INTO fact (subject, key, value, source_kind, source_seq, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      ).get(subject, key, value, sourceKind, sourceSeq, origin, now);
      return Number(got.id);
    });
  }

  /**
   * 取某个 subject 下的事实，按创建时间倒序（新的先）。
   * @param {'me'|'her'|'us'} subject
   * @param {number} [limit] 默认 50
   * @returns {object[]}
   */
  function factsBySubject(subject, limit = 50) {
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

  /* --------------------------------- note -------------------------------- */

  const note = {
    /**
     * TA主动记下一条（memory_remember）。返回 id。
     * 只进 note 表，不进 msg —— TA的话不是"对话"，混进去会污染检索和 fact 提炼。
     *
     * `sessionId`（A1 会话隔离）：记下的是「在这个会话里记的」。绑定会话的工具
     * 只会查到同一 sessionId 的笔记，跨会话的笔记既检索不到也删不掉。
     * 不传时写 NULL（遗留/单库模式），不会被任何绑定会话的工具看见。
     *
     * @param {{content: string, about?: 'me'|'him'|'us', at?: number,
     *          sessionId?: string|null, session_id?: string|null}} row
     * @returns {number}
     */
    insert({ content, about = null, at = Date.now(), sessionId, session_id } = {}) {
      const text = required({ content }, ['content'], 'note.insert');
      const sid = param(field({ sessionId, session_id }, 'sessionId', 'session_id') ?? null);
      const got = stmt(
        'INSERT INTO note (content, about, at, deleted_at, session_id) VALUES (?, ?, ?, NULL, ?) RETURNING id',
      ).get(String(text), p(about), p(at), sid);
      return Number(got.id);
    },

    /**
     * 按 id 取一条。
     *
     * `opts.sessionId` 给定时**只在这一会话里找**：跨会话的编号一律当"没有"，
     * 否则 A 会话能凭编号读到（并进而删掉）B 会话的笔记。
     *
     * @param {number} id
     * @param {{sessionId?: string|null}} [opts]
     * @returns {object|null}
     */
    byId(id, opts = {}) {
      const sid = opts?.sessionId;
      const r = sid
        ? stmt('SELECT * FROM note WHERE id = ? AND session_id = ?').get(p(id), p(sid))
        : stmt('SELECT * FROM note WHERE id = ?').get(p(id));
      return r ? mapNote(r) : null;
    },

    /**
     * 列出笔记（默认未删除，新的在前）。
     *
     * `opts.sessionId` 给定时只列这一会话的笔记（A1：TA在 A 里看不到 B 记的）。
     * 不传 = 全库（单库/管理视角）。
     * `opts.deletedOnly === true` 时只列回收站（`deleted_at IS NOT NULL`），按删除时间倒序。
     *
     * @param {{about?: string|null, limit?: number, offset?: number,
     *          includeDeleted?: boolean, deletedOnly?: boolean, sessionId?: string|null}} [opts]
     */
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

    /**
     * 按关键词（LIKE 预过滤）检索笔记，突破旧版 500 条内存扫描上限。
     *
     * @param {{sessionId?: string|null, from?: number|null, to?: number|null,
     *          terms?: string[], query?: string, limit?: number, offset?: number}} [opts]
     */
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

    /**
     * 统计匹配的笔记条数（供面板统计回收站数量）。
     *
     * @param {{sessionId?: string|null, from?: number|null, to?: number|null,
     *          deletedOnly?: boolean, includeDeleted?: boolean}} [opts]
     * @returns {number}
     */
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

    /**
     * 软删（30 天内可恢复）。返回是否真的删了一条。
     *
     * `opts.sessionId` 给定时只删属于这一会话的笔记：B 会话不能靠编号删掉 A 的。
     *
     * @param {number} id
     * @param {number} [at]
     * @param {{sessionId?: string|null}} [opts]
     */
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

    /**
     * 恢复软删的笔记。
     * @param {number} id
     * @param {{sessionId?: string|null}} [opts]
     */
    restore(id, opts = {}) {
      const sid = opts?.sessionId;
      const sql = sid
        ? 'UPDATE note SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL AND session_id = ?'
        : 'UPDATE note SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL';
      const info = sid ? stmt(sql).run(p(id), p(sid)) : stmt(sql).run(p(id));
      return Number(info.changes) > 0;
    },

    /**
     * 物理清理超过保留期的软删笔记（默认 30 天）。
     * @param {number} [retentionMs]
     * @param {number} [now]
     * @param {{sessionId?: string|null}} [opts] 给定时只清这一会话的回收站
     * @returns {number} 清理条数
     */
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

  /* --------------------------------- audit -------------------------------- */

  const audit = {
    /**
     * 记一条审计。返回 id。
     * @param {{action: 'remember'|'forget'|'restore'|'rebuild', target: string,
     *          detail?: string|object|null, at?: number}} entry
     */
    insert({ action, target, detail = null, at = Date.now() } = {}) {
      const act = required({ action }, ['action'], 'audit.insert');
      const tgt = required({ target }, ['target'], 'audit.insert');
      const got = stmt('INSERT INTO audit (action, target, detail, at) VALUES (?, ?, ?, ?) RETURNING id')
        .get(String(act), String(tgt), p(toJsonText(detail) ?? null), p(at));
      return Number(got.id);
    },

    /** @param {number} [limit] */
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

    /** 按 target 查（如 'note:123'） */
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

  /* -------------------------------- vecMeta ------------------------------- */

  const vecMeta = {
    /**
     * 库里的向量模型指纹（D-152）。
     * `opts.sessionId` 给定时只统计该会话；不给则统计全库（向后兼容）。
     *
     * @param {{sessionId?: string|null}} [opts]
     * @returns {{model: string|null, dim: number|null, indexed: number, total: number}}
     */
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

    /**
     * 校验索引模型与当前查询模型一致，否则抛错并提示重建（D-152）。
     * 不同模型的向量空间不可比，混算不报错但结果无意义。
     * @param {{id: string, dim: number}} provider
     */
    assert(provider) {
      if (!provider?.id) throw new TypeError('vecMeta.assert: provider 缺少 id');
      const current = vecMeta.get();
      if (!current.model) return; // 还没建索引，随便
      if (current.model !== provider.id || current.dim !== provider.dim) {
        throw new Error(
          // provider.id 本身已含「@维度」（如 sf:qwen@1024），再拼一次会变成 @1024@1024
          `向量模型不一致：库里是 ${current.model}，当前是 ${provider.id}。`
            + '不同模型的向量不可比，请重建向量索引。',
        );
      }
    },

    /**
     * 记录一批消息的向量来源。
     * @param {number[]} msgIds
     * @param {{model: string, dim: number}} provider
     * @returns {number} 更新条数
     */
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

    /**
     * 拼出待索引消息的 WHERE 条件与参数（pending / countPending 共用）。
     * @param {{model?: string|null, sessionId?: string|null, includeExcluded?: boolean}} [opts]
     */
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

    /**
     * 找还没索引的消息（全量/增量索引用）。
     *
     * 默认跳过 excluded=1（D-169/170）：软排除的消息永远不会走向量检索，
     * 不值得为它们花 embedding 调用。真要索引它们传 `includeExcluded: true`。
     *
     * @param {{model?: string, sessionId?: string|null, limit?: number, includeExcluded?: boolean}} [opts]
     * @returns {object[]}
     */
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

    /**
     * 统计待索引消息条数。
     * @param {{model?: string, sessionId?: string|null, includeExcluded?: boolean}} [opts]
     * @returns {number}
     */
    countPending(opts = {}) {
      const { whereSql, args } = vecMeta._pendingWhere(opts);
      return Number(
        stmt(`SELECT COUNT(*) AS c FROM msg WHERE ${whereSql}`).get(...args)?.c ?? 0,
      );
    },
  };

  /* ------------------------------ sceneAssign ----------------------------- */

  const sceneAssign = {
    /**
     * 把一批消息挂到某场景。
     * @param {number[]} msgIds
     * @param {number} sceneId
     * @returns {number} 更新条数
     */
    assign(msgIds, sceneId) {
      if (!Array.isArray(msgIds) || msgIds.length === 0) return 0;
      return withTx(db, () => {
        const upd = stmt('UPDATE msg SET scene_id = ? WHERE id = ?');
        let n = 0;
        for (const id of msgIds) n += Number(upd.run(p(sceneId), p(id)).changes);
        return n;
      });
    },

    /**
     * 按 seq 区间把消息挂到某场景（T3 切分结果直接能用）。
     * @param {string} sessionId
     * @param {number} fromSeq 含
     * @param {number} toSeq 含
     * @param {number} sceneId
     * @returns {number}
     */
    assignSeqRange(sessionId, fromSeq, toSeq, sceneId) {
      const info = stmt('UPDATE msg SET scene_id = ? WHERE session_id = ? AND seq BETWEEN ? AND ?').run(
        p(sceneId),
        p(sessionId),
        p(fromSeq),
        p(toSeq),
      );
      return Number(info.changes);
    },

    /** 按精确 seq 列表绑定到某场景（避免时间戳乱序时 seq BETWEEN 误覆盖邻场或 pending 消息） */
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

    /** 解绑某场景的全部消息 */
    unassign(sceneId) {
      const info = stmt('UPDATE msg SET scene_id = NULL WHERE scene_id = ?').run(p(sceneId));
      return Number(info.changes);
    },

    /**
     * 清空某会话的场景（重建派生层前用，D-041 可重建原则）。
     * 先把 msg.scene_id 置空，再删 scene；保留 msg 原文。
     *
     * **同时清掉这些场景的向量**（vec_scene + vec_fallback_scene，同一个事务）。
     * 为什么必须在这里做（R5 实测 P1）：场景重建是「删旧场 → 插新场」，
     * 旧 `vec_scene` 行不清的话，新场一旦拿到同一个 id（v5 之前会复用），
     * 用旧场的 gist 向量就能命中一条完全无关的新对话。把清理放在删除场景的
     * 同一个事务里，是为了让「场景没了的场向量」不可能单独存在 ——
     * 放在调用方（pipeline）就总有人会忘记调。
     *
     * @param {string} sessionId
     * @param {{withIds?: boolean}} [opts] withIds=true 时额外返回被删的 scene id
     *        （默认返回形状不变，`{scenes, msgs}` 是既有契约）
     * @returns {{scenes: number, msgs: number, sceneIds?: number[]}}
     */
    clear(sessionId, opts = {}) {
      return withTx(db, () => {
        // 先记 id：删完就查不到了，而向量要按 id 清
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
        deleteVecRows(db, 'scene', sceneIds); // ← 同一个事务：场景和它的向量一起消失
        if (windowIds.length > 0) deleteVecRows(db, 'window', windowIds);
        return opts.withIds ? { scenes, msgs, sceneIds } : { scenes, msgs };
      });
    },

    /**
     * 按排除区间重算某会话全部 msg.excluded 及关联 scene 的 excluded_count / has_excluded。
     * 左闭右开 `[r.from, r.to)`，只对状态发生变化的 msg 行执行 UPDATE。
     *
     * @param {string} sessionId
     * @param {Array<{from: number, to: number}>} [normalizedRanges]
     * @returns {{totalMsgs: number, updatedMsgs: number, excludedMsgs: number}}
     */
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

  /* -------------------------------- search -------------------------------- */

  /** 去掉中英文标点、按空白切词（IMPLEMENTATION.md §8.1 的查询预处理） */
  function splitTerms(raw) {
    return String(raw)
      .trim()
      .split(/[\s,.;:!?"'“”‘’、，。；：！？「」『』（）()【】[\]…—-]+/u)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /** LIKE 里的 % _ \ 要转义，否则用户查个 "%" 会全表命中 */
  function escapeLike(s) {
    return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
  }

  /** 带场景时间区间的消息行（每条结果都要能说出"属于哪一场"，D-017 验收 2） */
  function mapMsgWithScene(r) {
    const m = mapMsg(r);
    m.sceneStartAt = r.scene_start_at ?? null;
    m.sceneEndAt = r.scene_end_at ?? null;
    m.sceneMsgCount = r.scene_msg_count ?? null;
    return m;
  }

  /** 关键词查询的公共过滤条件（keyword 与 countKeyword 必须完全同源，否则 M/N 对不上） */
  function keywordFilter(opts) {
    const filters = [];
    const filterArgs = [];
    // D-178：过滤写在 WHERE 里，所以 LIMIT 永远作用在过滤后的结果集上
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

  const zhSegmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null;

  const STOPWORDS_ZH3 = new Set([
    '为什么', '怎么样', '怎么了', '怎么说', '怎么回', '怎么用', '怎么弄', '怎么做',
    '什么时候', '是不是', '有没有', '能不能', '可不可以', '会不会', '算不算', '值不值',
    '还记得', '记不记得', '怎么回事', '什么意思', '差不多', '一下子', '说清楚', '告诉我',
    '那时候', '这一回', '那一回', '还有一', '为什么会', '到底是', '究竟是',
  ]);

  /** 提取复合技术标识符（如 mini-swe / 3.2.5 / worker.py）、粘连 ASCII 词与中文 ≥3 字实词 */
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

  /** 只有 ≥ 3 个字符的切词才进 FTS（trigram 的硬限制） */
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

  /** FTS5 查询表达式：每个词套双引号做短语匹配，多词 OR（宁多勿少，再按 bm25 排） */
  function ftsExpr(terms) {
    return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
  }

  const search = {
    /**
     * 关键词路（IMPLEMENTATION.md §8.1 的双路规则）。
     *
     * - 有 ≥ 3 个字符的切词 → 走 FTS5 trigram（0.2ms 级）
     * - 只有 ≤ 2 字的词（中文最常见）→ LIKE '%x%' 兜底（0.6ms 级）
     * - FTS 语法异常（引号、特殊字符）→ 自动落 LIKE，不抛
     *
     * excluded（D-169/170）：默认只返回未被排除的消息；
     * `includeExcluded: true` 时才把 excluded=1 的也找出来（工具层"核实"用）。
     * 注意被排除的消息仍然留在 msg_fts 里 —— 否则开 includeExcluded 就查不到了。
     *
     * LIMIT 语义（D-178）：过滤在 WHERE 里、LIMIT 在最后，所以是「过滤后 N 条」，
     * 被排除的消息不占名额。总数用 `countKeyword()` 拿（同源过滤，M/N 不会对不上）。
     *
     * 返回值比 MsgRow 多三个字段：sceneStartAt / sceneEndAt / sceneMsgCount，
     * 供 T4 输出「（在 11-12 23:36–00:12 那场，共 18 轮）」。
     *
     * @param {string} query
     * @param {{sessionId?: string|null, from?: number, to?: number, limit?: number,
     *          includeExcluded?: boolean}} [opts]
     * @returns {object[]}
     */
    keyword(query, opts = {}) {
      const raw = String(query ?? '').trim();
      if (!raw) return [];

      const limit = p(opts.limit ?? 20);
      const { tail, filterArgs } = keywordFilter(opts);
      const cols = 'm.*, s.start_at AS scene_start_at, s.end_at AS scene_end_at, s.msg_count AS scene_msg_count';

      const longTerms = longTermsOf(raw);
      if (longTerms.length) {
        try {
          // **必须用 CROSS JOIN，不能写 JOIN**：SQLite 优化器会对
          // `msg_fts JOIN msg` 选错驱动表 —— 先走 `idx_msg_excluded` 全表外循环，
          // 再对每一行探一次 FTS，耗时显著增加。
          // CROSS JOIN 强制按书写顺序先走 FTS（`SCAN msg_fts` +
          // `SEARCH m USING INTEGER PRIMARY KEY`），大幅降低查询延迟。
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
          // FTS 语法错误（比如 query 里有没配对的引号）：落到 LIKE
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

    /**
     * 关键词命中的**总数**（D-196），给「已显示 M / N 条」的 N 用。
     *
     * 与 keyword() 共用 keywordFilter()，所以过滤口径完全一致：
     * 同样的 query + 同样的 opts（含 includeExcluded / sessionId / from / to）→
     * N 必然 ≥ 实际返回条数，不会出现"显示了 8 条但总数写 6"。
     *
     * @param {string} query
     * @param {{sessionId?: string|null, from?: number, to?: number, includeExcluded?: boolean}} [opts]
     * @returns {number}
     */
    countKeyword(query, opts = {}) {
      const raw = String(query ?? '').trim();
      if (!raw) return 0;
      const { tail, filterArgs } = keywordFilter(opts);

      const longTerms = longTermsOf(raw);
      if (longTerms.length) {
        try {
          // 同 keyword()：CROSS JOIN 强制先走 FTS，否则优化器先全表扫 msg（见上）。
          const hit = stmt(
            `SELECT COUNT(*) AS c
             FROM msg_fts CROSS JOIN msg m ON m.id = msg_fts.rowid
             WHERE msg_fts MATCH ?${tail}`,
          ).get(ftsExpr(longTerms), ...filterArgs);
          if (Number(hit.c) > 0) return Number(hit.c);
        } catch {
          // 同 keyword()：FTS 语法错误就落 LIKE
        }
      }

      const like = stmt(
        `SELECT COUNT(*) AS c FROM msg m WHERE m.text LIKE ? ESCAPE '\\'${tail}`,
      ).get(`%${escapeLike(raw)}%`, ...filterArgs);
      return Number(like.c ?? 0);
    },
  };

  /* --------------------------------- stats -------------------------------- */

  const stats = {
    /**
     * 库的范围统计 —— 空结果时给用户"库里有 X 至 Y 的 N 条消息、M 个场景"用
     * （IMPLEMENTATION.md §6.2 第 5 条：空结果不能返回空白）。
     *
     * excludedMsgs / excludedChars 是 D-170 的"按日期排除 N 条 / M 字"：
     * 它们是 msgs / chars 的**子集**（库里有，但检索不到）。
     * 想报"能查到多少"，用 msgs - excludedMsgs。
     *
     * **会话隔离（A1）**：`opts.sessionId` 给定时只统计这一会话。
     * 空结果那行「库里有 11-08 至 … 的 N 条」必须是TA这个会话的范围，
     * 否则 A 会话会报出 B/C 会话的条数与日期跨度。不给 = 全库（单库/管理视角）。
     *
     * @param {{sessionId?: string|null}} [opts]
     * @returns {{msgs: number, scenes: number, notes: number, chars: number,
     *            excludedMsgs: number, excludedChars: number,
     *            firstAt: number|null, lastAt: number|null}}
     */
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

  /* ---------------------------------- flag --------------------------------- */

  const flag = {
    /**
     * 给某条消息记一笔"有问题"（D-167/168）。返回 flag id。
     *
     * 硬语义：**只留痕，不影响任何检索、不删任何东西**。
     * msg 是唯一事实来源，单条删除会破坏"一句不丢"；
     * 发现问题走「修 + 重建」，不是"删这一条"。
     * 同一 msg_id 允许多条标记（不同人不同时提出），不做去重。
     *
     * @param {{msgId: number, reason?: string|null, at?: number}} entry
     * @returns {number}
     */
    insert({ msgId, reason = null, at = Date.now() } = {}) {
      if (msgId === undefined || msgId === null) throw new TypeError('flag.insert: 缺少 msgId');
      const got = stmt('INSERT INTO flag (msg_id, reason, at, resolved_at) VALUES (?, ?, ?, NULL) RETURNING id')
        .get(p(msgId), p(reason), p(at));
      return Number(got.id);
    },

    /**
     * 列出标记，按 at 倒序（同一 msg 的多条也按时间排）。
     * @param {{sessionId?: string|null, openOnly?: boolean, limit?: number}} [opts]
     * @returns {object[]}
     */
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

    /**
     * 取消标记（置 resolved_at）。返回是否真的改了一条。
     * @param {number} id
     * @param {number} [at]
     * @returns {boolean}
     */
    resolve(id, at = Date.now()) {
      const info = stmt('UPDATE flag SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(p(at), p(id));
      return Number(info.changes) > 0;
    },

    /**
     * 统计标记数（核对页角标用）。
     * @param {{sessionId?: string|null, openOnly?: boolean}} [opts]
     * @returns {number}
     */
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

  /* ---------------------------------- chunk --------------------------------- */
  //
  // 长文本分片（D-247）：查某条消息被切成几片 / 取它的全部分片。
  // 放在 extras 而不是 repo —— repo 的接口有严格契约（BUILD-PLAN §3.1 一个不多一个不少），
  // 附加能力一律进 extras。

  const chunk = {
    /** 某条消息被切成几片；没切过返回 0 */
    count(msgId) {
      try {
        const r = stmt('SELECT COUNT(*) AS c FROM chunk WHERE msg_id = ?').get(param(msgId));
        return Number(r?.c ?? 0);
      } catch {
        return 0;
      }
    },

    /** 某条消息的所有分片（按 idx 升序），带原文位置 */
    list(msgId) {
      try {
        return stmt('SELECT id, msg_id, idx, start_char, end_char FROM chunk WHERE msg_id = ? ORDER BY idx ASC')
          .all(param(msgId))
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

  /* ---------------------------------- media --------------------------------- */
  //
  // 媒体附件（schema.sql ⑤）：只记路径/元信息，通过 ON DELETE CASCADE 随 msg 级联清理。
  const media = {
    /**
     * 按会话幂等写入媒体附件（按 seq 定位 msg.id，单条先清后插避免重复）。
     * @param {string} sessionId
     * @param {{seq:number, path:string, sha256?:string|null, width?:number|null, height?:number|null, at?:number}[]} items
     * @returns {number} 写入条数
     */
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
          const row = findMsg.get(param(sessionId), param(seq));
          if (!row) continue;
          const msgId = Number(row.id);
          const captionByKey = new Map();
          for (const prev of oldMedia.all(param(msgId))) {
            if (typeof prev.caption === 'string' && prev.caption.trim()) {
              if (prev.sha256) captionByKey.set(`sha:${prev.sha256}`, prev.caption);
              if (prev.path) captionByKey.set(`path:${prev.path}`, prev.caption);
            }
          }
          del.run(param(msgId));
          for (const it of list) {
            const pStr = it.path.trim();
            const restoredCaption = it.caption ?? (it.sha256 ? captionByKey.get(`sha:${it.sha256}`) : null) ?? captionByKey.get(`path:${pStr}`) ?? null;
            ins.run(
              param(msgId),
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

    /** 批量按 msg_id 查询媒体附件，返回 Map<msgId, MediaRow[]> */
    byMsgIds(msgIds) {
      const out = new Map();
      if (!Array.isArray(msgIds) || msgIds.length === 0) return out;
      const ids = [...new Set(msgIds.map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0))];
      if (ids.length === 0) return out;
      try {
        const ph = ids.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT id, msg_id, path, sha256, width, height, caption, created_at FROM media WHERE msg_id IN (${ph}) ORDER BY id ASC`)
          .all(...ids.map(param));
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
        const r = stmt('SELECT id, msg_id, path, sha256, width, height, caption, created_at FROM media WHERE id = ?').get(param(mid));
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
      return Number(stmt('UPDATE media SET caption = ? WHERE id = ?').run(param(caption ?? null), param(mid)).changes);
    },

    count(opts = {}) {
      try {
        if (opts.sessionId) {
          return Number(
            stmt('SELECT COUNT(*) AS c FROM media md JOIN msg m ON m.id = md.msg_id WHERE m.session_id = ?')
              .get(param(opts.sessionId))?.c ?? 0,
          );
        }
        return Number(stmt('SELECT COUNT(*) AS c FROM media').get()?.c ?? 0);
      } catch { return 0; }
    },
  };

  /* --------------------------------- window -------------------------------- */

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
    if (r.scene_start_at !== undefined && r.scene_start_at !== null) {
      out.sceneStartAt = Number(r.scene_start_at);
    }
    if (r.scene_end_at !== undefined && r.scene_end_at !== null) {
      out.sceneEndAt = Number(r.scene_end_at);
    }
    if (r.scene_msg_count !== undefined && r.scene_msg_count !== null) {
      out.sceneMsgCount = Number(r.scene_msg_count);
    }
    return out;
  }

  const windowOps = {
    replaceForScene(sceneId, windows = []) {
      const sid = Number(sceneId);
      if (!Number.isSafeInteger(sid) || sid <= 0) return [];
      return withTx(db, () => {
        let oldIds = [];
        try {
          oldIds = stmt('SELECT id FROM window WHERE scene_id = ?').all(param(sid)).map((r) => Number(r.id));
        } catch {
          return [];
        }
        if (oldIds.length > 0) {
          deleteVecRows(db, 'window', oldIds);
          stmt('DELETE FROM window WHERE scene_id = ?').run(param(sid));
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
            param(w.sessionId),
            param(sid),
            param(Number.isInteger(w.idx) ? w.idx : i),
            kind,
            param(Number(w.startMsgId)),
            param(Number(w.endMsgId)),
            param(Number(w.startAt)),
            param(Number(w.endAt)),
            param(Number(w.msgCount)),
            param(String(w.text ?? '')),
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
            .all(...ids.map(param))
            .map((r) => Number(r.id));
          if (winIds.length > 0) deleteVecRows(db, 'window', winIds);
          return Number(db.prepare(`DELETE FROM window WHERE scene_id IN (${ph})`).run(...ids.map(param)).changes);
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
            .all(param(sessionId))
            .map((r) => Number(r.id));
          if (winIds.length > 0) deleteVecRows(db, 'window', winIds);
          return Number(stmt('DELETE FROM window WHERE session_id = ?').run(param(sessionId)).changes);
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
              .run(param(opts.sessionId)).changes,
          );
        }
        return Number(db.prepare('UPDATE window SET vec_model = NULL, vec_dim = NULL WHERE vec_model IS NOT NULL').run().changes);
      } catch {
        return 0;
      }
    },

    pending(opts = {}) {
      const limit = param(opts.limit ?? 500);
      try {
        if (opts.sessionId) {
          return stmt(
            `SELECT * FROM window
              WHERE session_id = ? AND vec_model IS NULL
              ORDER BY start_at ASC, id ASC
              LIMIT ?`,
          ).all(param(opts.sessionId), limit).map(mapWindowRow);
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
              .get(param(opts.sessionId))?.c ?? 0,
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
          n += Number(upd.run(param(provider.id), param(provider.dim), param(Number(id))).changes);
        }
        return n;
      });
    },

    count(opts = {}) {
      try {
        if (opts.sessionId) {
          return Number(
            stmt('SELECT COUNT(*) AS c FROM window WHERE session_id = ?').get(param(opts.sessionId))?.c ?? 0,
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
        return stmt('SELECT * FROM window WHERE scene_id = ? ORDER BY idx ASC').all(param(sid)).map(mapWindowRow);
      } catch {
        return [];
      }
    },

    // 窗口级关键词检索（searchKeyword）已删除。
    //
    // 跨句多词关键词检索（searchKeyword）已移除：
    // 它召回的是「多个查询词分散在不同短消息里」的窗口，
    // 而这类窗口的语义**已经被 `vec_window` 覆盖**（后者本就负责把相邻短消息合起来）。
    // 额外保留它不会带来新候选，只会在 RRF 里多一路投票、稀释精确命中的名次。
  };

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


