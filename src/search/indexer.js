/**
 * 向量索引构建 —— 全量 / 增量 / 长文本分片
 *
 * 规格来源：BUILD-PLAN.md §4.4（增量更新 + 降级）+ D-152（索引与查询必须同一个模型）
 *           + D-247（长文本分片）
 *
 * 分工：
 *   - 本模块只管「哪些 msg 还没向量 → 算出来 → 写进 vec_msg / vec_chunk → 记账」
 *   - 向量怎么存、KNN 怎么查，全在 vector-store.js
 *   - 哪些 msg 还没索引，问 store 层的 extras.vecMeta.pending()（不自己写 SQL 挑数据）
 *
 * 三条硬规则：
 * ① **写之前必须 assert**（D-152）：库里已有 A 模型的向量时，不许用 B 模型再写进去 ——
 *    不同模型的向量空间不可比，混写**不会报错**，但检索结果从此无意义。
 *    要换模型只有一条路：rebuild({ force: true })。
 * ② **按 provider.maxBatch 分批**：一次塞 7000 条会直接被拒。
 * ③ **先写向量再记账**：反过来的话，中途崩了会留下一批 `vec_model` 有值却没有向量的行，
 *    下次 pending() 认不出它们，这些消息永远进不了索引。
 *
 * 两条调用时序（T8 集成时踩到的，写在这里免得下一个人再踩）：
 *
 * **A. 清向量表必须同时清指纹。**
 *    `pending()` 是靠 `msg.vec_model` 判断「谁还没索引」的。如果只清 `vec_msg`
 *    不清指纹，就会停在「指纹在、表是空的」这个状态 —— pending() 一条也捞不到，
 *    索引永远建不起来。所以 rebuild() 走 `resetMsgIndex()`（一个事务里两件事一起做），
 *    并且在 indexPending() 开头留了 `repair()` 自愈这一步兜底。
 *    推论：**rebuild 是幂等的**，连跑两次第二遍和第一遍索引同样多的行。
 *
 * **B. 场景向量必须先有 gist。**
 *    `indexScenes` 嵌的是 `scene.gist`，而 gist 由 T5 的派生逻辑写回。
 *    先调 rebuild({scenes}) 再生成 gist = 嵌一堆空串（表现是 `skippedScenes` 几乎全满）。
 *    正确顺序：切场 → 生成 gist 并 setSceneGist → indexScenes/rebuild({scenes})。
 *    跳过时 `skippedReasons` 会分开报「gist 为空」和「embedding 失败」，
 *    gist 覆盖率低于一半还会在 `warnings` 里提示顺序可能反了。
 *
 * **C. 长文本分片（D-247）。**
 *    超过 CHUNK_MIN_CHARS（800 字）的消息切成按句子对齐的片，每片单独嵌入，
 *    存 `vec_chunk` + `chunk` 表（msg_id / idx / start_char / end_char）。
 *    短消息仍是一条一个向量 —— 实测真实对话场景里绝大多数是短消息，
 *    分片只影响 1% 左右，但少这 1% 就是「后半段永远搜不到」的静默丢失。
 */

import { createExtras, createRepo, withTx } from '../store/repo.js';

import { createVectorStore, normalizeVector } from './vector-store.js';
import { splitIntoChunks, shouldChunk, formatChunkWithContext } from './chunk.js';
import { buildShortContext, WINDOW_SKIP_MSG_CHARS } from './window.js';
import { segmentThreadsByValley } from './thread.js';

/** pending() 单次最多捞多少条（store 层的默认值，见 extras.vecMeta.pending） */
const PENDING_PAGE = 500;

/** embedding 失败重试次数（网络抖动） */
const EMBED_RETRIES = 2;

/** 重试退避基准（毫秒） */
const EMBED_RETRY_BASE_MS = 300;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 校验库里的 vec0 表维度是否与 provider 一致（不一致就抛，绝不混写）。
 *
 * 为什么不写死 1024：部分向量模型使用更高原生维度（如 2560 维），
 * 强行截断为 `dimensions: 1024` 可能破坏语义表达。
 *
 * 但**已有表的维度是建表时定死的**，改维度必须重建库 —— 这里的失配必须明确报错，
 * 不能静默写入错位向量。
 *
 * @param {any} db
 * @param {number} dim
 */
function verifyStoredDim(db, dim) {
  let declared = null;
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_msg'").get();
    const m = /float\[(\d+)\]/i.exec(row?.sql ?? '');
    declared = m ? Number(m[1]) : null;
  } catch {
    declared = null;   // 表还不存在（新库），无需校验
  }
  if (declared !== null && declared !== dim) {
    throw new Error(
      `向量维度不一致：库里的 vec 表是 float[${declared}]，当前 provider 是 ${dim} 维。`
      + '已有表的维度不可变，换维度必须重建库（或用一致维度的模型）。',
    );
  }
}

/**
 * 创建索引器。
 *
 * @param {{
 *   handle: any,   // openDb() 的返回值（必需）
 *   provider: { id: string, dim: number, maxBatch: number, embed(texts: any, signal?: any): Promise<Float32Array[]> },
 *   extras?: any,                            // 不传就自己 createExtras(handle)
 *   store?: any,                             // 不传就自己 createVectorStore(handle, { dim })
 *   logger?: { warn(msg: string): void, info?(msg: string): void },
 *   onProgress?: (info: {phase: string, done: number, total: number}) => void,
 * }} [opts]
 */
export function createIndexer(opts = /** @type {any} */ ({})) {
  const { handle } = opts;
  const db = handle?.db ?? handle;
  if (!db) throw new TypeError('createIndexer: 需要 openDb() 返回的 handle');

  const provider = opts.provider;
  if (!provider?.id) throw new TypeError('createIndexer: provider 缺少 id');
  if (!Number.isInteger(provider.dim) || provider.dim <= 0) {
    throw new TypeError(`createIndexer: provider.dim 必须是正整数，收到 ${provider.dim}`);
  }
  if (typeof provider.embed !== 'function') throw new TypeError('createIndexer: provider 缺少 embed()');

  const dim = provider.dim;
  // 维度由库结构决定（schema.sql 的 vec0 表声明维度），不硬编码 1024。
  // 但**已有表的维度不可变**：如果库里的表已经是 1024，传 2560 会被 vector-store 拦下
  // （见 createVectorStore 里的 declaredDim 校验），这是正确的保护。
  verifyStoredDim(db, dim);

  const logger = opts.logger ?? { warn: () => {}, info: () => {} };
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  const extras = opts.extras ?? createExtras(handle);
  const store = opts.store ?? createVectorStore(handle, { dim, logger });
  const maxBatch = Math.max(1, Number(provider.maxBatch) || 16);

  /* --------------------------- 内部工具 --------------------------- */

  /** 分批嵌入 + 指数退避重试 */
  async function embedWithRetry(texts, o = {}) {
    const retries = Number.isFinite(o.retries) ? o.retries : EMBED_RETRIES;
    const base = Number.isFinite(o.baseDelayMs) ? o.baseDelayMs : EMBED_RETRY_BASE_MS;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(base * 2 ** (attempt - 1));
      try {
        return await provider.embed(texts, o.signal);
      } catch (e) {
        lastErr = e;
        // 永久错误（没 key / 模型不匹配）重试没意义
        if (e?.permanent === true || /缺少.*API Key|模型不一致/.test(String(e?.message))) throw e;
      }
    }
    const cause = lastErr?.cause ? (lastErr.cause.code || lastErr.cause.message || '') : '';
    const detail = `${lastErr?.message ?? lastErr}${cause ? ` (${cause})` : ''}`;
    throw new Error(
      `embedding 调用失败（重试 ${retries} 次后）：${detail}`,
    );
  }

  /**
   * 嵌入一批 {id, text} 并写进 store。
   * @param {{id:number, text:string}[]} entries
   * @param {(pairs: [number, Float32Array][]) => void} writeFn
   */
  async function embedAndWrite(entries, writeFn, o = {}) {
    let written = 0;
    for (let i = 0; i < entries.length; i += maxBatch) {
      const slice = entries.slice(i, i + maxBatch);
      const vecs = await embedWithRetry(slice.map((e) => e.text), o);
      // **不许静默跳项**（2026-11-18，A2 审计问题 1）：
      // 之前是 `if (vecs[j]) pairs.push(...)` —— 上游少返回一条就少写一个向量，
      // 但记账按「消息条数」累加，照样算成功 → 那一片**永久搜不到**，谁也不报错。
      // 现在条数不符直接抛：宁可这一批失败、下次重试，也不要静默丢向量。
      if (vecs.length !== slice.length) {
        throw new Error(
          `embedding 返回条数不符：期望 ${slice.length} 条，实际 ${vecs.length} 条。`
          + '为避免写入残缺的向量索引，这一批已放弃（下次会重试）。',
        );
      }
      const pairs = slice.map((e, j) => /** @type {[number, Float32Array]} */ ([Number(e.id), vecs[j]]));
      writeFn(pairs);
      written += pairs.length;
      o.onBatch?.(pairs.length, written, entries.length);
    }
    return { written };
  }

  /**
   * 清空消息向量 + 清指纹，**同一个事务**。
   *
   * 为什么必须绑在一起（T8 实测踩到的 bug）：只清表不清指纹会留下
   * 「`msg.vec_model` 有值、`vec_msg` 是空的」这种中间状态，
   * 而 `extras.vecMeta.pending()` 是看指纹判断缺不缺的 —— 于是它一条也捞不到，
   * 索引从此永远建不起来（表现为「同一库连跑两次 rebuild，第二次 0 条」）。
   *
   * 语义上「表空了」和「没索引过」本来就该是同一个状态，所以这里不让它们分开。
   * 只动 vec_model / vec_dim 两列，不碰原文（msg 是唯一事实来源）。
   */
  function resetMsgIndex() {
    withTx(db, () => {
      store.clearMsgVec();
      // 长文本分片一起清（D-247）：只清 vec_msg 不清 chunk 会留下孤儿向量
      store.clearChunkVec();
      try { store.clearWindowVec?.(); } catch { /* 老 store 桩无此方法 */ }
      try { db.exec('DELETE FROM chunk'); } catch { /* 老库没有这张表 */ }
      try { extras.window?.clearVecMeta?.(); } catch { /* 老库没有 window 表 */ }
      // extras.vecMeta 有 get/assert/set/pending，没有 clear —— 这两列只能自己写
      db.exec('UPDATE msg SET vec_model = NULL, vec_dim = NULL WHERE vec_model IS NOT NULL');
    });
  }

  /**
   * 自愈：指纹说「索引过了」，但向量表其实是空的 → 把指纹一起清掉。
   *
   * 覆盖的是「有人/某个流程单独清了向量表」的所有情况（rebuild 中途崩、
   * 降级模式下改了 persistFallback、外部工具清表……）。
   * 不清的话 pending() 返回空，索引静默失效 —— 这类 bug 不报错、只是查不到。
   *
   * @returns {{repaired: boolean, metaIndexed: number, vectors: number}}
   */
  function repairVectorMeta() {
    let metaIndexed = 0;
    try {
      metaIndexed = extras.vecMeta.get().indexed;
    } catch {
      return { repaired: false, metaIndexed: 0, vectors: 0 };
    }
    const vectors = store.countMsgVec() + store.countChunkVec();
    if (metaIndexed > 0 && vectors === 0) {
      logger.warn(
        `发现索引不一致：${metaIndexed} 条消息记着"已索引"，但向量表里 0 条。已清掉指纹，接下来会重新索引。`,
      );
      resetMsgIndex();
      return { repaired: true, metaIndexed, vectors };
    }
    return { repaired: false, metaIndexed, vectors };
  }

  /**
   * 给一批消息建索引 —— **长消息走分片**（D-247）。
   *
   * 为什么分开：一条 7301 字的消息直接嵌入会超过模型窗口（我们也截断到 2000 字），
   * 后 5300 字永远搜不到 —— 静默的信息丢失。所以超过 CHUNK_MIN_CHARS 的消息
   * 切成按句子对齐的片，每片单独嵌入，存 vec_chunk。
   *
   * 记账口径不变：**所有行**（不管长短）最后都 vecMeta.set(ids)。
   * 否则长消息会被 pending() 反复捞出来，永远建不完。
   *
   * @param {any[]} rows MsgRow[]
   * @param {{signal?: AbortSignal, onStep?: Function}} [o]
   */
  async function indexRows(rows, o = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return { indexed: 0, batches: 0, chunks: 0 };

    /** 走消息级（短消息 + 切不出片的） */
    const toMsg = [];
    /** 走分片级的：{ msg, parts } */
    const plan = [];
    // (b1) 落单短句的场景消息缓存（一场只查一次；查不到就嵌原文，绝不丢向量）
    const sceneCache = new Map();
    let repoLazy = null;
    const sceneMsgsOf = (sceneId) => {
      if (sceneId === null || sceneId === undefined) return null;
      const key = Number(sceneId);
      if (sceneCache.has(key)) return sceneCache.get(key);
      let list = null;
      try {
        if (!repoLazy) repoLazy = createRepo(handle);
        list = repoLazy.msgsByScene(key, false);
      } catch { list = null; }
      sceneCache.set(key, list);
      return list;
    };

    for (const m of rows) {
      if (!shouldChunk(m.text)) {
        // (b1) 落单短句补上下文：<400 字且无窗口覆盖的，嵌「前2+自己+后2」
        //（深处短串已有窗口向量覆盖，嵌原文避免重复；长消息自足，不管）。
        // 只换嵌入文本，不改库（展示仍用原文），FTS 不受影响。
        let text = m.text;
        if (String(m.text ?? '').length < WINDOW_SKIP_MSG_CHARS && m.sceneId !== null && m.sceneId !== undefined) {
          try {
            const ctx = buildShortContext(m, sceneMsgsOf(m.sceneId));
            if (ctx) text = ctx;
          } catch { /* 补上下文失败就嵌原文 */ }
        }
        toMsg.push(text === m.text ? m : { ...m, text });
        continue;
      }
      const parts = splitIntoChunks(m.text);
      if (!parts) { toMsg.push(m); continue; }   // 切不出（比如只有一片）→ 退回消息级
      plan.push({ msg: m, parts });
    }

    let indexed = 0;
    let batches = 0;
    let chunksWritten = 0;

    // ① 写分片表，拿到 chunk.id
    /** @type {{chunkId: number, text: string}[]} */
    const pieces = [];
    if (plan.length > 0) {
      withTx(db, () => {
        for (const { msg, parts } of plan) {
          // 重建时先清旧分片，避免 idx 残留
          db.prepare('DELETE FROM chunk WHERE msg_id = ?').run(Number(msg.id));
          for (const p of parts) {
            const r = db
              .prepare('INSERT INTO chunk (msg_id, idx, start_char, end_char) VALUES (?, ?, ?, ?)')
              .run(Number(msg.id), p.index, p.start, p.end);
            pieces.push({
              chunkId: Number(r.lastInsertRowid),
              text: formatChunkWithContext(msg.text, p.text, p.index, p.start),
            });
          }
        }
      });
    }

    // ② 分片向量
    if (pieces.length > 0) {
      const { written } = await embedAndWrite(
        pieces.map((p) => ({ id: p.chunkId, text: p.text })),
        (pairs) => store.upsertChunkVecs(pairs),
        {
          signal: o.signal,
          onBatch: (delta, chunksDone) => o.onStep?.({
            phase: 'chunk',
            msgsDoneInPage: 0,
            chunksDone,
            chunksTotal: pieces.length,
            chunksDelta: delta,
          }),
        },
      );
      chunksWritten = written;
      indexed += plan.length;      // 记账按**消息条数**算，不是分片数
      batches += Math.ceil(pieces.length / maxBatch);
      o.onStep?.({
        phase: 'msg',
        msgsDoneInPage: indexed,
        chunksDone: chunksWritten,
        chunksTotal: pieces.length,
        chunksDelta: 0,
      });
    }

    // ③ 消息级向量（短消息 + 切不出片的）
    if (toMsg.length > 0) {
      const { written } = await embedAndWrite(
        toMsg.map((m) => ({ id: m.id, text: m.text })),
        (pairs) => store.upsertMsgVecs(pairs),
        {
          signal: o.signal,
          onBatch: (_delta, msgWritten) => o.onStep?.({
            phase: 'msg',
            msgsDoneInPage: indexed + msgWritten,
            chunksDone: chunksWritten,
            chunksTotal: pieces.length,
            chunksDelta: 0,
          }),
        },
      );
      indexed += written;
      batches += Math.ceil(toMsg.length / maxBatch);
    }

    // ④ 记账：**所有行**都标，否则 pending 会反复捞长消息
    if (rows.length > 0) extras.vecMeta.set(rows.map((m) => m.id), provider);

    return { indexed, batches, chunks: chunksWritten };
  }

  /* ------------------------------ 对外方法 ------------------------------ */

  const indexer = {
    provider,
    store,
    dim,

    /**
     * 模型一致性检查（不抛）。
     * @returns {Record<string, any>}
     */
    check() {
      let meta;
      try {
        meta = extras.vecMeta.get();
      } catch (e) {
        return { ok: false, model: null, dim: null, reason: `读不到索引记账：${e?.message ?? e}` };
      }
      // current = **库里现在用的**模型（不是传入的）；provider 是本次要用的
      const current = { model: meta?.model ?? null, dim: meta?.dim ?? null };
      if (!meta?.model) return { ok: true, model: null, dim: null, current };
      if (meta.model !== provider.id || Number(meta.dim) !== Number(dim)) {
        const error =
          // provider.id 本身已含「@维度」，别再拼一次（A1 审计抓到过 @1024@1024）
          `向量模型不一致：库里是 ${meta.model}，当前是 ${provider.id}。`
          + '不同模型的向量空间不可比，混用会让检索结果无意义。换模型请用 rebuild({ force: true })。';
        return { ok: false, model: meta.model, dim: meta.dim, error, reason: error, current };
      }
      return { ok: true, model: meta.model, dim: meta.dim, current };
    },

    /** 模型不一致就抛（写之前的闸门，D-152） */
    assertModel() {
      const c = indexer.check();
      if (!c.ok) throw new Error(c.reason ?? '向量模型不一致');
    },

    /** 自愈：指纹与向量表不一致时清指纹 */
    repair() {
      return repairVectorMeta();
    },

    /** 清空消息向量 + 指纹（rebuild 的内部步骤，也可以单独调） */
    reset() {
      resetMsgIndex();
    },

    /**
     * 索引现状。
     * @returns {Record<string, any>}
     */
    status() {
      let meta = { indexed: 0, model: null, dim: null };
      try { meta = extras.vecMeta.get(); } catch { /* 老库 */ }

      let total = 0;
      try {
        total = Number(db.prepare('SELECT COUNT(*) AS c FROM msg').get()?.c ?? 0);
      } catch { total = 0; }

      const vectors = store.countMsgVec();
      const chunks = store.countChunkVec();

      // 分片的消息在 vec_chunk 里，不在 vec_msg —— 一致性要两边一起算
      let chunkedMsgs = 0;
      try {
        chunkedMsgs = Number(
          db.prepare('SELECT COUNT(DISTINCT msg_id) AS c FROM chunk').get()?.c ?? 0,
        );
      } catch { chunkedMsgs = 0; }

      let hasPending = false;
      try {
        hasPending = extras.vecMeta.pending({ limit: 1 }).length > 0;
      } catch { hasPending = false; }

      return {
        total,
        indexed: Number(meta.indexed ?? 0),
        hasPending,
        // 一致 = 指纹数 == 消息级向量数 + 有分片的消息数
        consistent: Number(meta.indexed ?? 0) === vectors + chunkedMsgs,
        model: meta.model ?? null,
        dim: meta.dim === null || meta.dim === undefined ? null : Number(meta.dim),
        vectors,
        chunks,
        // 测试和面板都会读这两个（对外契约的一部分）
        store: {
          msgVectors: vectors,
          chunkVectors: chunks,
          windowVectors: typeof store.countWindowVec === 'function' ? store.countWindowVec() : 0,
          sceneVectors: store.countSceneVec(),
        },
        provider: { id: provider.id, dim },
      };
    },

    /**
     * 增量索引：把 pending() 捞到的都嵌掉，直到捞不到或到达 limit。
     * @param {{limit?: number, sessionId?: string|null, includeExcluded?: boolean, signal?: AbortSignal, onProgress?: Function, onStep?: Function}} [o]
     * @returns {Promise<{indexed:number, chunks:number, batches:number, totalPending:number, hasMore:boolean, elapsedMs:number}>}
     */
    async indexPending(o = {}) {
      indexer.assertModel(); // ← D-152：不一致就抛，绝不混写
      indexer.repair();

      const report = typeof o.onProgress === 'function' ? o.onProgress : onProgress;
      const startedAt = Date.now();
      const budget = Number.isFinite(o.limit) ? Math.max(0, Math.floor(o.limit)) : Infinity;
      const totalPending = typeof extras.vecMeta.countPending === 'function'
        ? extras.vecMeta.countPending({
          includeExcluded: o.includeExcluded,
          sessionId: o.sessionId,
        })
        : null;
      const targetTotal = totalPending === null
        ? null
        : (Number.isFinite(budget) ? Math.min(totalPending, budget) : totalPending);

      let indexed = 0;
      let chunks = 0;
      let batches = 0;

      report({ phase: 'msg', done: 0, total: targetTotal, chunks: 0 });

      while (indexed < budget) {
        const pageSize = Math.min(PENDING_PAGE, budget - indexed);
        const page = extras.vecMeta.pending({
          limit: pageSize,
          includeExcluded: o.includeExcluded,
          sessionId: o.sessionId,
        });
        if (page.length === 0) break;

        const baseIndexed = indexed;
        const baseChunks = chunks;
        const r = await indexRows(page, {
          signal: o.signal,
          onStep: ({ phase, msgsDoneInPage, chunksDone }) => {
            report({
              phase: phase === 'chunk' ? 'chunk' : 'msg',
              done: Math.min(baseIndexed + msgsDoneInPage, targetTotal ?? Infinity),
              total: targetTotal,
              chunks: baseChunks + chunksDone,
            });
          },
        });
        indexed += r.indexed;
        // **分片数也要累加**（2026-11-18，A2 审计问题 6）：
        // 之前只累加 indexed/batches，导致 rebuild 返回的 chunks 永远是 0，
        // 用户看到「重建完成（0 片）」会以为根本没切分片。
        chunks += r.chunks ?? 0;
        batches += r.batches;
        report({ phase: 'msg', done: indexed, total: targetTotal, chunks });
        if (page.length < pageSize) break; // 这一页没满 = 捞到底了
      }

      return {
        indexed,
        chunks,
        batches,
        totalPending: totalPending ?? indexed,
        hasMore: extras.vecMeta.pending({ limit: 1, sessionId: o.sessionId, includeExcluded: o.includeExcluded }).length > 0,
        elapsedMs: Date.now() - startedAt,
      };
    },

    /**
     * 立刻给指定消息建索引（「新 msg 立刻入索引」的增量路径）。
     * 不查 pending，直接在给定行上算 —— 上层刚 insertMsg 完就可以调它。
     *
     * @param {any[]} msgs MsgRow[]
     * @param {{signal?: AbortSignal}} [o]
     * @returns {Promise<number>} 索引条数
     */
    async indexMsgs(msgs, o = {}) {
      const rows = (msgs ?? []).filter(
        (m) => m && Number.isSafeInteger(Number(m.id)) && typeof m.text === 'string',
      );
      if (rows.length === 0) return 0;
      indexer.assertModel();
      const r = await indexRows(rows.map((m) => ({ ...m, id: Number(m.id) })), o);
      return r.indexed;
    },

    /**
     * 给一场（或一批）场景建 gist 向量。
     *
     * 只嵌 gist：gist 是「可检索锚点 + 原话」，本身就是为检索压缩出来的；
     * 嵌整段对话既超长又会被闲聊稀释（BUILD-PLAN §4.2）。
     *
     * **时序契约（T8 踩过）**：`scene.gist` 由 T5 的 gist 派生写回，
     * 所以**必须先有 gist，再来嵌场景向量**。顺序反了不会报错，只会得到
     * 一堆「跳过了但不知道为什么」—— 所以这里把跳过原因逐类报出来：
     *   `skippedReasons.emptyGist`   —— gist 还没生成（多半是时序反了）
     *   `skippedReasons.embedFailed` —— embedding 调用真的失败（网络/额度）
     *
     * @param {any[]} scenes SceneRow[]（需要 id + gist）
     * @returns {Promise<{indexed:number, skipped:number,
     *            skippedReasons:{emptyGist:number, embedFailed:number},
     *            reason:string|null, failed:boolean, warnings:string[]}>}
     */
    async indexScenes(scenes, o = {}) {
      const report = typeof o.onProgress === 'function' ? o.onProgress : onProgress;
      const list = (scenes ?? []).filter((s) => s && Number.isSafeInteger(Number(s.id)));
      const result = {
        indexed: 0,
        skipped: 0,
        skippedReasons: { emptyGist: 0, embedFailed: 0 },
        reason: null,
        failed: false,
        warnings: [],
      };
      if (list.length === 0) return result;

      const withGist = [];
      for (const s of list) {
        const gist = typeof s.gist === 'string' ? s.gist.trim() : '';
        if (!gist) {
          result.skipped += 1;
          result.skippedReasons.emptyGist += 1;
        } else {
          withGist.push({ id: Number(s.id), gist });
        }
      }

      if (withGist.length === 0) {
        result.reason = '全部跳过：这些场景的 gist 为空 —— 先跑派生（切场 → 生成 gist）再建场景向量。';
        result.failed = true;
        return result;
      }

      // **逐批容错**：某批 embedding 失败只跳过那批，不炸整轮。
      // （T8 的现场：一批失败把前面成功的也算成 skipped，报告就会失真。）
      report({ phase: 'scene', done: 0, total: withGist.length });
      let lastError = null;
      for (let i = 0; i < withGist.length; i += maxBatch) {
        const slice = withGist.slice(i, i + maxBatch);
        try {
          const { written } = await embedAndWrite(
            slice.map((s) => ({ id: s.id, text: s.gist })),
            (pairs) => store.upsertSceneVecs(pairs),
            { signal: o.signal },
          );
          result.indexed += written;
        } catch (e) {
          lastError = e;
          result.skipped += slice.length;
          result.skippedReasons.embedFailed += slice.length;
        }
        report({ phase: 'scene', done: Math.min(i + slice.length, withGist.length), total: withGist.length });
      }
      if (result.skippedReasons.embedFailed > 0) {
        result.reason = `embedding 调用失败：${lastError?.message ?? lastError}`;
      }
      result.failed = result.indexed === 0;

      if (result.skippedReasons.emptyGist > 0) {
        result.reason = `${result.skippedReasons.emptyGist} 个场景因为 gist 为空被跳过 —— 多半是「先嵌场景、后生成 gist」的顺序反了。`;
      }
      // gist 覆盖率低于一半 → 提示顺序可能反了
      if (result.skipped > 0 && result.skipped > result.indexed) {
        const pct = ((result.indexed / list.length) * 100).toFixed(1);
        result.warnings.push(
          `scene.gist 覆盖率只有 ${result.indexed}/${list.length}（${pct}%）：`
          + '超过一半场景没有 gist，检查切场→gist 的时序是否反了。',
        );
      }
      return result;
    },

    /**
     * 批量为笔记生成并写入向量索引（vec_note）。
     *
     * @param {{id:number, content:string}[]} notes
     * @returns {Promise<{indexed:number, skipped:number, reason:string|null}>}
     */
    async indexNotes(notes, o = {}) {
      const list = (notes ?? []).filter((n) => n && Number.isSafeInteger(Number(n.id)));
      const result = { indexed: 0, skipped: 0, reason: null };
      if (list.length === 0 || typeof store.upsertNoteVecs !== 'function') return result;

      const valid = [];
      for (const n of list) {
        const text = typeof n.content === 'string' ? n.content.trim() : '';
        if (!text) result.skipped += 1;
        else valid.push({ id: Number(n.id), text });
      }
      if (valid.length === 0) return result;

      let lastError = null;
      for (let i = 0; i < valid.length; i += maxBatch) {
        const slice = valid.slice(i, i + maxBatch);
        try {
          const { written } = await embedAndWrite(slice, (pairs) => store.upsertNoteVecs(pairs), { signal: o.signal });
          result.indexed += written;
        } catch (e) {
          lastError = e;
          result.skipped += slice.length;
        }
      }
      if (lastError) result.reason = `note embedding 调用失败：${lastError?.message ?? lastError}`;
      return result;
    },

    /**
     * 增量嵌入尚未建向量的场景内滑动对话窗（vec_window）。
     *
     * @param {{sessionId?: string|null, limit?: number, signal?: AbortSignal, onProgress?: Function}} [o]
     * @returns {Promise<{indexed:number, batches:number, totalPending:number}>}
     */
    async indexPendingWindows(o = {}) {
      if (typeof store.upsertWindowVecs !== 'function' || !extras?.window?.pending) {
        return { indexed: 0, batches: 0, totalPending: 0 };
      }
      const report = typeof o.onProgress === 'function' ? o.onProgress : onProgress;
      const budget = Number.isFinite(o.limit) ? Math.max(0, Math.floor(o.limit)) : Infinity;
      const totalPending = typeof extras.window.countPending === 'function'
        ? extras.window.countPending({ sessionId: o.sessionId })
        : 0;
      const targetTotal = Number.isFinite(budget) ? Math.min(totalPending, budget) : totalPending;
      if (targetTotal === 0) return { indexed: 0, batches: 0, totalPending: 0 };

      let indexed = 0;
      let batches = 0;
      report({ phase: 'window', done: 0, total: targetTotal });

      // 记录刚嵌入的 exchange 向量，供后续零成本本地切分 Thread 微话题
      const embeddedVecs = new Map();
      const exchangeScenes = new Set();

      while (indexed < budget) {
        const pageSize = Math.min(PENDING_PAGE, budget - indexed);
        const page = extras.window.pending({ sessionId: o.sessionId, limit: pageSize });
        if (page.length === 0) break;

        for (const w of page) {
          if (w.kind === 'exchange' && Number.isSafeInteger(Number(w.sceneId))) {
            exchangeScenes.add(Number(w.sceneId));
          }
        }

        const baseIndexed = indexed;
        const { written } = await embedAndWrite(
          page.map((w) => ({ id: w.id, text: w.text })),
          (pairs) => {
            store.upsertWindowVecs(pairs);
            for (const [id, v] of pairs) {
              if (v) embeddedVecs.set(Number(id), normalizeVector(v, dim));
            }
          },
          {
            signal: o.signal,
            onBatch: (_delta, doneInPage) => {
              report({
                phase: 'window',
                done: Math.min(baseIndexed + doneInPage, targetTotal),
                total: targetTotal,
              });
            },
          },
        );
        extras.window.markIndexed(page.map((w) => w.id), provider);
        indexed += written;
        batches += Math.ceil(page.length / maxBatch);
        report({ phase: 'window', done: indexed, total: targetTotal });
        if (page.length < pageSize) break;
      }

      // 为含 exchange 的场景自动切出 kind='thread' 微话题对话线（零额外 LLM/向量重算，复用内存向量）
      if (exchangeScenes.size > 0 && typeof extras.window.byScene === 'function') {
        const threadPending = [];
        for (const sceneId of exchangeScenes) {
          const allInScene = extras.window.byScene(sceneId) ?? [];
          if (allInScene.some((w) => w.kind === 'thread')) continue;
          const exRows = allInScene
            .filter((w) => w.kind === 'exchange')
            .sort((a, b) => a.idx - b.idx);
          if (exRows.length === 0) continue;

          const exWithVec = exRows.map((e) => ({
            ...e,
            vec: embeddedVecs.get(Number(e.id)) ?? null,
            msgs: Array.from({ length: Math.max(1, e.msgCount) }, () => ({})),
          }));
          const threads = segmentThreadsByValley(exWithVec);
          if (threads.length === 0) continue;

          const baseIdx = allInScene.reduce((mx, w) => Math.max(mx, Number(w.idx) || 0), -1) + 1;
          const ins = db.prepare(
            `INSERT INTO window (session_id, scene_id, idx, kind, start_msg_id, end_msg_id, start_at, end_at, msg_count, text)
             VALUES (?, ?, ?, 'thread', ?, ?, ?, ?, ?, ?)`,
          );
          withTx(db, () => {
            for (let t = 0; t < threads.length; t += 1) {
              /** @type {any} */
              const th = threads[t];
              const res = ins.run(
                String(exRows[0].sessionId),
                Number(sceneId),
                baseIdx + t,
                Number(th.startMsgId),
                Number(th.endMsgId),
                Number(th.startAt),
                Number(th.endAt),
                Number(th.msgCount),
                String(th.text ?? ''),
              );
              threadPending.push({ id: Number(res.lastInsertRowid), text: String(th.text ?? '') });
            }
          });
        }
        if (threadPending.length > 0) {
          const { written } = await embedAndWrite(
            threadPending,
            (pairs) => store.upsertWindowVecs(pairs),
            { signal: o.signal },
          );
          extras.window.markIndexed(threadPending.map((t) => t.id), provider);
          indexed += written;
          batches += Math.ceil(threadPending.length / maxBatch);
        }
      }

      return { indexed, batches, totalPending };
    },

    /**
     * 全量重建。
     *
     * @param {{force?: boolean, scenes?: any[], notes?: any[], windows?: boolean, signal?: AbortSignal, onProgress?: Function}} [o]
     *   force  —— 模型换了必须 force（否则 assertModel 抛）
     *   scenes —— 传了就顺便重建场景向量
     * @returns {Promise<Record<string, any>>}
     */
    async rebuild(o = {}) {
      const startedAt = Date.now();
      const forced = o.force === true;
      const report = typeof o.onProgress === 'function' ? o.onProgress : onProgress;

      // 非 force 时先校验模型（不一致就抛，别混写）
      if (!forced) indexer.assertModel();

      // **rebuild 总是全量重算**（先清后建）：
      // 测试「连跑两次，第二次也要索引同样多的行」要求的就是这个语义 ——
      // 否则第二次 pending() 是空的，只会返回 0。
      //
      // 记下清空前的规模：失败时要能说清「被清了什么」（A1 审计问题 6）
      let before = 0;
      try {
        before = Math.max(0, Math.trunc(Number(extras.vecMeta.get()?.indexed) || 0));
      } catch { before = 0; }

      report({ phase: 'prepare', done: 0, total: null });
      resetMsgIndex();

      let msgResult;
      try {
        msgResult = await indexer.indexPending({ signal: o.signal, onProgress: report });
      } catch (e) {
        // **失败必须说清后果**（2026-11-18，A1 审计问题 6）：
        // 重建是「先清后建」，所以失败时旧索引已经不在了。
        // 之前这个后果只表现为「面板显示还没建索引」，用户会以为本来就没有 ——
        // 点第二次、第三次，每次都失败且每次都重新清空。
        const err = /** @type {Error & { code?: string, clearedVectors?: number }} */ (new Error(
          `重建没成功：${e?.message ?? e}\n`
          + `注意：重建是先把旧索引清空再重算，所以这一刻库里没有可用的向量`
          + `（清空之前有 ${before} 条）。原文一条没动，重试一次就能恢复。`,
        ));
        err.code = 'REBUILD_AFTER_RESET';
        err.clearedVectors = before;
        throw err;
      }

      let sceneResult = null;
      if (Array.isArray(o.scenes) && o.scenes.length > 0) {
        sceneResult = await indexer.indexScenes(o.scenes, { onProgress: report });
      }
      let noteResult = null;
      if (Array.isArray(o.notes) && o.notes.length > 0) {
        noteResult = await indexer.indexNotes(o.notes, { onProgress: report });
      }
      let windowResult = null;
      if (o.windows !== false && typeof store.upsertWindowVecs === 'function' && extras?.window?.pending) {
        try {
          windowResult = await indexer.indexPendingWindows({ signal: o.signal, onProgress: report });
        } catch (e) {
          logger.warn?.(`对话窗向量构建跳过：${e?.message ?? e}`);
        }
      }

      // 场景结果摊平到顶层（调用方读 result.scenes 要的是**数字**，不是对象）
      return {
        msgs: msgResult.indexed,
        scenes: sceneResult?.indexed ?? 0,
        notes: noteResult?.indexed ?? 0,
        windows: windowResult?.indexed ?? 0,
        skippedScenes: sceneResult?.skipped ?? 0,
        skippedReasons: sceneResult?.skippedReasons ?? { emptyGist: 0, embedFailed: 0 },
        sceneSkipReason: sceneResult?.reason ?? null,
        sceneFailed: sceneResult?.failed ?? false,
        warnings: sceneResult?.warnings ?? [],
        forced,
        batches: msgResult.batches,
        chunks: msgResult.chunks ?? 0,
        elapsedMs: Date.now() - startedAt,
      };
    },
  };

  return indexer;
}

export default createIndexer;
