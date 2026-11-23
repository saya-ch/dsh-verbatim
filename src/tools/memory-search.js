/**
 * memory_search —— 合并检索（时间路 + 关键词路 + 语义路）
 *
 * 参数组合决定走哪条路：
 *   只有 query  → 关键词路 + 语义路（RRF 融合）
 *   只有 when   → 时间路：返回场景 + 摘录
 *   when + query → 时间路先圈出候选场景，再在候选里匹配（关键词 + 语义）
 *   都没有      → 列最近一次聊天
 *
 * 语义路（D-143 / D-201）：
 *   只要 embedding 可用且向量索引覆盖达标，就始终与关键词路并行混合检索 → RRF 融合（k=60，等权）。
 *   没有 embedding key / 没有向量索引 → **只跑关键词，并在返回里明说「语义搜索未启用」**（不静默降级）。
 *   语义路抛错 → 用其余路继续，meta 里写清原因，输出里也提一句。
 *
 * **索引可跑性闸门（M2，2026-11-18）** —— 语义路的第 0 步，排在 embedding 之前：
 *   实测缺陷：真实库 7479 条 msg、`vec_msg` 0 条，但语义路照跑 —— TA查一次就白付一次
 *   embedding 网络调用（100~500ms + 钱），最后什么也召回不到。
 *
 *   三种「不可用」必须分开报，不能混成一句「语义不可用」：
 *     `vec:off`     没有 key / 没有 provider（根本装备不起来）
 *     `vec:empty`   有 key，但索引是空的（0 / N 条）→ **不 embed、不召回**，直接说原因
 *     `vec:partial` 有 key、有索引，但覆盖率 < minIndexCoverage（默认 50%）→ **也不跑**
 *   `vec:err` 只有真的跑了才可能出现（装配失败 / 网络失败 / 模型不一致）。
 *
 *   为什么 partial 选择「不跑」而不是「跑+标注」：向量路只在这部分里召回，而关键词路查全库，
 *   RRF 融合会把「已索引的那部分」系统性抬高 —— 结果偏向且看不出来。宁可省掉一次调用、
 *   把覆盖率写在标记里，也不要给TA一份看起来正常、其实是抽样检索的结果。
 *   空索引/低覆盖都只是**这一路暂时不跑**：关键词路与时间路照常，返回里写明怎么补索引。
 *
 * 去重：RRF 按 msg.id 合并，同一条被两路命中只出现一次、分数**累加**（searchWithRRF/fuseRRF 负责）。
 *
 * 三条铁律（同旧版）：
 * ① 返回纯文本；② 只返回原文，不返回 gist / 诊断；③ 不写 SQL。
 */

import {
  MARK_COMPACTED_ONE,
  MARK_EXCLUDED_ONE,
  buildMediaAnnotator,
  clipInline,
  clipText,
  emptyText,
  fmtCount,
  fmtDate,
  fmtPhase,
  fmtRange,
  fmtStamp,
  fmtTime,
  indentText,
  noteAboutLabel,
  speakerLabel,
  CONTEXT_CLIP_MAX,
  HIT_CLIP_MAX,
} from './format.js';
import { createExtras, createRepo, getDefaultExtras, getDefaultRepo } from '../store/repo.js';
import { resolveSessionId, sessionStats } from './scope.js';
import { runTimeOnlyRoute, resolveTimeWindow } from './time-route.js';
import { searchWithRRF, fuseRRF } from '../search/rrf.js';
import { SCENE_FALLBACK_ENABLED } from '../search/scene-fallback.js';
import { formatChunkWithContext } from '../search/chunk.js';
import { dedupeBySpan, createSpanIndex } from '../search/dedupe.js';
import { foldTimelineClusters } from '../search/thread.js';
import {
  NOTE_MIN_SCORE_DEFAULT,
  PINNED_NOTE_MAX_DEFAULT,
  searchRankedNotes,
} from '../search/note-rank.js';

/** 默认返回几条（§7.2） */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/**
 * 曾用于粗排扩池的候选池宽度常量（已停用）。
 *
 * cross-encoder 在小候选集上更稳定，盲目扩池反而会引入近似干扰项并打乱 RRF 排序，
 * 因此保持紧凑候选池；此常量已不再使用，仅作备查。
 */
const RERANK_POOL_SIZE = 50;

/** rerank 默认精排条数（与 RERANK_POOL_SIZE 对齐，保证整池都排到） */
const RERANK_TOPN_DEFAULT = 50;

/**
 * 索引覆盖率低于这个比例就不跑语义路（M2）。
 * 50% 是「抽样还是全库」的分界：一半以上没索引时，向量路的召回集合已经是偏的。
 */
const DEFAULT_MIN_INDEX_COVERAGE = 0.5;

/**
 * 在标题里回显 query 时最多显示多少字。
 * query 本身不截断（长句也能走 LIKE 兜底），只有**回显**截断 + 折成一行（P2-B）。
 */
const QUERY_LABEL_MAX = 40;

/** note 表没有关键词索引，一次最多取这么多条在内存里过滤 */
const NOTE_PROBE = 500;

/** scope 的合法值 */
export const SEARCH_SCOPES = Object.freeze(['msg', 'note', 'all']);

/* ================================ 内部工具 ================================ */

/** 依赖解析：构造时注入 > ctx 注入 > 默认库单例（懒开库） */
function resolveDeps(injected = {}, ctx = {}) {
  const handle = ctx.handle ?? injected.handle ?? null;
  const repo = ctx.repo ?? injected.repo ?? (handle ? createRepo(handle) : getDefaultRepo());
  const extras =
    ctx.extras ?? injected.extras ?? (handle ? createExtras(handle) : getDefaultExtras());
  return { repo, extras, handle };
}

/** now 可以是数字或函数 */
function resolveNow(injected = {}, ctx = {}) {
  const candidate = ctx.now ?? injected.now;
  const value = typeof candidate === 'function' ? candidate() : candidate;
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function clampLimit(limit, fallback = DEFAULT_LIMIT) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** 把用户给的字面量 clause 收进白名单，认不出的一律按默认走 */
function normalizeScope(scope) {
  const value = String(scope ?? '')
    .trim()
    .toLowerCase();
  return SEARCH_SCOPES.includes(value) ? value : 'msg';
}

/** 空结果要用的库统计；统计本身失败也不该让工具挂掉。
 *  **按会话取**（A1）：报的必须是这个会话的范围。 */
function safeStats(extras, sessionId = null) {
  return sessionStats(extras, sessionId);
}

/** 查询切词（与 extras 里的同一套标点口径，不引第二个实现） */
function splitTerms(raw) {
  return String(raw ?? '')
    .trim()
    .split(/[\s,.;:!?"'“”‘’、，。；：！？「」『』（）()【】[\]…—-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 空 query 或「全部」类字面量 → 在 note 里表示「都列出来」 */
function isListAllQuery(query) {
  return query === '' || query === '*' || query === '全部' || query === '所有';
}

/* ================================ 语义路 ================================ */

/**
 * 语义路的解析结果。
 * @typedef {{ok:boolean, reason:string|null, provider?:object, store?:object}} SemanticState
 */

/** handle → 语义路解析结果（同一个库不重复建向量 storage / provider） */
const semanticCache = new WeakMap();

/**
 * 会话 → 形态判别结果（决定 `windowQuota`）。
 *
 * 用 **`WeakMap<handle, Map<sessionId, shape>>`** 而不是一个裸的 `Map`：
 *   · 键必须含 handle —— 同一个 sessionId 在不同库里形态完全不同（隔离库 vs 生产库），
 *     只按 sessionId 缓存会让不同库的数据互相污染；
 *   · 用 WeakMap 让库连接被回收时缓存一起消失，不会无限增长。
 *
 * ⚠ 这里曾经写成 `const cacheKey = \`${sessionId}\`` 但**从未声明 shapeCache**，
 *   引用一个不存在的变量 → ReferenceError → 被外层 `catch` 吞掉 → `windowQuota` 永远回落 1.0。
 *   也就是说「按会话形态自适应」这个功能上线后**从未真正生效过**，而且完全不报错。
 */
const shapeCache = new WeakMap();

/** 语义不可用的统一说法（G5：必须明说，不能静默降级） */
const SEMANTIC_OFF_PREFIX = '语义搜索未启用';
/** 术语化短注（作者 2026-11-18：不必写中文长句） */
const SEMANTIC_OFF_TAG = 'vec:off';
/** 有 key、但向量表是空的（M2 止血：不许为此白调一次 embedding） */
/** 语义召回的最低余弦相似度（实测 0.50 能分开相关/无关） */
/** 场景整场给的阈值：≤ 这个字数就完整回（真实聊天场景中位数 569 字，技术对话 2248 字） */
/** 分片段最长显示多少字（片本身约 400 字，全显示即可） */
const SEGMENT_MAX = 500;
const AUTO_FULL_SCENE_CHARS = 1500;
/** 单次返回的上下文字数总预算：用完之后的场景自动降级成接缝 */
const MAX_TOTAL_CONTEXT_CHARS = 8000;
/**
 * 语义召回的最低余弦阈值。
 *
 * 不同 embedding 模型的余弦分分布存在系统性偏移，
 * 默认 0.52 可通过 `deps.vectorMinScore` 按模型覆盖。
 */
const VECTOR_MIN_SCORE = 0.52;

/**
 * 「相关度偏低」提示的地板。
 *
 * 选择 0.62 偏重**精度优先**：这是给用户看的提示，误报（明明有记忆却提示
 * 「可能不靠谱」）比漏报更伤信任。
 *
 * 不做硬拒答的原因：人很少用原话检索，字面未命中不代表记忆不存在，
 * 硬拦截会把语义改写后的正常查询误判为没有记忆。
 */
export const WEAK_TOP1_FLOOR = 0.62;
const SEMANTIC_EMPTY_TAG = 'vec:empty';
/** 有向量，但只覆盖了一部分消息（M2：抽样检索，必须说明不是全库） */
const SEMANTIC_PARTIAL_TAG = 'vec:partial';

/**
 * 语义路这次的「可跑性」判定（M2）。**必须在调用 provider.embed 之前**执行。
 *
 * @typedef {{
 *   usable: boolean,               // false = 这次不要跑向量路（不花 embedding）
 *   tag: string|null,              // 'vec:empty' / 'vec:partial' / null
 *   note: string|null,             // 给输出用的一行短注（术语 + 数字 + 怎么补）
 *   vectors: number|null,          // 已索引条数（读不出来为 null）
 *   total: number|null,            // 全库消息条数（读不出来为 null）
 *   ratio: number|null,            // 覆盖率 0~1
 * }} VectorIndexState
 */

/**
 * 读一次索引覆盖率并判定能不能跑语义路。
 *
 * 三种情况：
 *   ① 读不到计数接口（测试注入的 store 桩 / 老 extras）→ **不拦**（usable:true）。
 *      宁可让下游跑一次并自己报错，也不要因为统计失败把语义路永久关掉。
 *   ② `countMsgVec() === 0` → usable:false + `vec:empty`。这就是 M2 要止血的那一种：
 *      索引一条都没有，语义路注定召回为空，唯一的产出是白付一次 embedding。
 *   ③ 覆盖率 < minCoverage → usable:false + `vec:partial`，并把「x/y（z%）」写出来。
 *      覆盖率的分母用全库消息数（`vecMeta.get().total`，与面板 `indexed/total` 同口径）：
 *      索引本来就是全库建的（panel.rebuild 的 vector 分支走 indexPending，不分会话），
 *      所以「建全了没有」只能按全库算。
 *
 * @param {{semantic: SemanticState, extras: object, minCoverage: number}} input
 * @returns {VectorIndexState}
 */
function assessVectorIndex({ semantic, extras, minCoverage, sessionId = null }) {
  const store = semantic?.store;
  const meta = extras?.vecMeta;
  if (!semantic?.ok || typeof store?.countMsgVec !== 'function' || typeof meta?.get !== 'function') {
    return { usable: true, tag: null, note: null, vectors: null, total: null, ratio: null };
  }

  let vectors;
  let total;
  try {
    // 面板 vectorStatus 按 sessionId 统计覆盖率；这里对齐同一口径（D-014）。
    // 传 { sessionId } 给 extras.vecMeta.get；旧桩忽略参数时也能兼容。
    const info = (sessionId ? meta.get({ sessionId }) : meta.get()) ?? {};
    const msgLevel = Math.max(0, Math.trunc(Number(store.countMsgVec()) || 0));
    const fingerprinted = Math.max(0, Math.trunc(Number(info.indexed) || 0));
    total = Math.max(0, Math.trunc(Number(info.total) || 0));

    if (!sessionId) {
      // 全库单库模式：取「有指纹的消息数」（含分片）和消息级向量数的较大者
      vectors = Math.max(msgLevel, fingerprinted);
    } else if (fingerprinted === 0 && msgLevel > 0) {
      // 兼容直接调 store.insertMsgVec 而不走 vecMeta.set 的测试桩：仅当全库就是这个会话时兜底
      const globalTotal = Math.max(0, Math.trunc(Number(meta.get()?.total) || 0));
      vectors = globalTotal > 0 && globalTotal === total ? msgLevel : 0;
    } else {
      vectors = fingerprinted;
    }
  } catch {
    return { usable: true, tag: null, note: null, vectors: null, total: null, ratio: null };
  }

  if (vectors === 0) {
    return {
      usable: false,
      tag: SEMANTIC_EMPTY_TAG,
      note:
        `${SEMANTIC_EMPTY_TAG} 索引还没建（${fmtCount(vectors)} / ${fmtCount(total)} 条）` +
        '；面板 [重建] 可补（要 embedding key）',
      vectors,
      total,
      ratio: 0,
    };
  }

  const ratio = total > 0 ? vectors / total : 1;
  if (ratio < minCoverage) {
    return {
      usable: false,
      tag: SEMANTIC_PARTIAL_TAG,
      note:
        `${SEMANTIC_PARTIAL_TAG} 索引只覆盖 ${fmtCount(vectors)}/${fmtCount(total)}` +
        `（${(ratio * 100).toFixed(1)}%），不是全库检索；面板 [重建] 可补全`,
      vectors,
      total,
      ratio,
    };
  }

  return { usable: true, tag: null, note: null, vectors, total, ratio };
}

/** minIndexCoverage 只认 0~1 的数；其余一律回默认 */
function resolveMinIndexCoverage(injected = {}) {
  const value = Number(injected.minIndexCoverage);
  if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  return DEFAULT_MIN_INDEX_COVERAGE;
}

/**
 * 解析语义路：显式注入 > 从 handle + 全局配置自动装配。
 *
 * 为什么允许注入：测试要 spy（数 embedding 调用次数），宿主也可能自己管 provider。
 * 为什么自动装配要读全局配置：宿主（index.js）不传 provider，而 embedding 的模型/key
 * 全在 `$DSH_HOME/verbatim/config.json` 里 —— **只读，不写**。
 *
 * @param {object} injected createSearchTool 的 deps
 * @param {object} ctx handler 的 ctx
 * @param {object} extras 仓储附加接口（vecMeta.assert 用）
 * @returns {SemanticState}
 */
function resolveSemantic(injected = {}, ctx = {}, extras = {}) {
  // ① 显式关闭（测试、排障、或宿主自己决定不启用）
  if (injected.semantic === false || ctx.semantic === false) {
    return { ok: false, reason: `${SEMANTIC_OFF_PREFIX}（调用方关掉了语义路）` };
  }

  // ② 显式注入的 provider + store（测试用 mock，宿主也可以自己装配）
  const provider = ctx.provider ?? injected.provider ?? null;
  const store = ctx.store ?? injected.store ?? null;
  if (provider && store) return { ok: true, reason: null, provider, store };

  // ③ 自动装配：没有库连接就没有向量索引，直接说清楚
  const handle = ctx.handle ?? injected.handle ?? null;
  if (!handle) {
    return { ok: false, reason: `${SEMANTIC_OFF_PREFIX}（这次调用没有库连接，拿不到向量索引）` };
  }

  // 同一个 handle 按配置签名缓存（设置页改模型/地址/key 后自动失效重建，无需重启进程）
  let state;
  let signature = null;
  try {
    const { loadGlobalConfig, embeddingReady } = globalConfigModule;
    const { config } = loadGlobalConfig(
      handle.dshHome ? { dshHome: handle.dshHome } : undefined,
    );
    const emb = config?.embedding ?? {};
    const envName = typeof emb.apiKeyEnv === 'string' ? emb.apiKeyEnv : '';
    const envPresent = Boolean(envName && process.env[envName]);
    signature = JSON.stringify([
      emb.mode ?? 'remote',
      emb.model ?? '',
      emb.dim ?? 1024,
      emb.baseUrl ?? '',
      emb.apiKey ?? '',
      envName,
      envPresent,
      emb.maxBatch ?? 32,
    ]);

    const cached = semanticCache.get(handle);
    if (cached && cached.signature === signature && cached.state?.ok) {
      return cached.state;
    }

    const ready = embeddingReady(config);
    if (!ready.ready) {
      state = { ok: false, reason: `${SEMANTIC_OFF_PREFIX}：${ready.reason}` };
    } else if (!extras?.vecMeta?.assert) {
      state = { ok: false, reason: `${SEMANTIC_OFF_PREFIX}（这个库没提供向量索引接口）` };
    } else {
      const { createSiliconFlowEmbedding } = embeddingModule;
      const { createVectorStore } = vectorStoreModule;
      const builtProvider = createSiliconFlowEmbedding({
        model: emb.model,
        dim: emb.dim,
        maxBatch: emb.maxBatch,
        baseURL: emb.baseUrl,
        apiKey: typeof emb.apiKey === 'string' && emb.apiKey.trim() ? emb.apiKey.trim() : undefined,
        apiKeyEnv: envName,
        local: emb.mode === 'local',
      });
      const builtStore = createVectorStore(handle, {
        dim: builtProvider.dim,
        logger: injected.logger ?? { warn: () => {} },
      });
      state = {
        ok: true,
        reason: null,
        provider: builtProvider,
        store: builtStore,
      };
    }
  } catch (error) {
    state = {
      ok: false,
      reason: `${SEMANTIC_OFF_PREFIX}：向量索引装配失败（${error?.message ?? error}）`,
    };
  }
  if (state.ok && signature) semanticCache.set(handle, { signature, state });
  return state;
}

/** 全局配置 / embedding / rerank / 向量库的模块引用（延迟 import，避免测试时读盘） */
let globalConfigModule = null;
let embeddingModule = null;
let rerankModule = null;
let vectorStoreModule = null;

async function loadSemanticModules() {
  if (!globalConfigModule) {
    globalConfigModule = await import('../config/global-config.js');
    embeddingModule = await import('../model/embedding.js');
    rerankModule = await import('../model/rerank.js');
    vectorStoreModule = await import('../search/vector-store.js');
  }
}

async function resolveReranker(injected) {
  if (injected.rerank === false) return null;
  if (injected.reranker) return { reranker: injected.reranker, topN: Number(injected.rerankTopN) || RERANK_TOPN_DEFAULT };
  if (injected.provider || injected.store || injected.semantic === false) return null;

  try {
    await loadSemanticModules();
    const { loadGlobalConfig, rerankReady } = globalConfigModule;
    const { config } = loadGlobalConfig({ dshHome: injected.dshHome });
    const ready = rerankReady(config);
    if (!ready.ready) return null;
    const r = config.rerank;
    const reranker = rerankModule.createReranker({
      model: r.model,
      baseURL: r.baseUrl,
      apiKey: typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey.trim() : undefined,
      apiKeyEnv: r.apiKeyEnv,
      local: r.mode === 'local',
      timeoutMs: r.timeoutMs,
    });
    const topN = Number.isInteger(r.topN) && r.topN > 0 ? r.topN : RERANK_TOPN_DEFAULT;
    return { reranker, topN };
  } catch {
    return null;
  }
}

function buildRerankDoc(hit, repo, sceneMsgsCache) {
  // 0) 若多粒度融合阶段已为该命中备好「核心原子文本（如精准 Exchange + 语境）」，优先使用，避免整条长 Thread 稀释精排聚焦度
  if (hit?.rerankDoc) return String(hit.rerankDoc);
  // ① 已带滑动对话窗文本：直接喂完整多句上下文
  if (hit?.window?.text) return String(hit.window.text);
  // ② 超长消息分片命中：喂命中的具体分片（第 2~N 片带首行上下文头，与入库嵌入对齐）
  if (hit?.chunk && Number.isFinite(hit.chunk.startChar) && Number.isFinite(hit.chunk.endChar)) {
    const raw = String(hit.text ?? '');
    const slice = raw.slice(hit.chunk.startChar, hit.chunk.endChar);
    return formatChunkWithContext(raw, slice, hit.chunk.idx, hit.chunk.startChar);
  }
  const baseText = String(hit?.text ?? hit?.snippet ?? '');
  // ③ 长消息本身已具完整语义，直接喂原文
  if (baseText.length >= 300 || !repo || typeof repo.msgsByScene !== 'function') {
    return baseText;
  }
  const sid = hit?.sceneId === null || hit?.sceneId === undefined ? null : Number(hit.sceneId);
  if (!Number.isSafeInteger(sid) || sid <= 0) return baseText;
  try {
    let scMsgs = sceneMsgsCache.get(sid);
    if (!scMsgs) {
      scMsgs = repo.msgsByScene(sid, false);
      sceneMsgsCache.set(sid, scMsgs);
    }
    const idx = scMsgs.findIndex((m) => Number(m.id) === Number(hit.id));
    if (idx < 0) return baseText;
    const from = Math.max(0, idx - 2);
    const to = Math.min(scMsgs.length - 1, idx + 2);
    const parts = [];
    let totalLen = 0;
    for (let i = from; i <= to; i += 1) {
      const m = scMsgs[i];
      const t = String(m.text ?? '').trim();
      if (!t) continue;
      // 邻居若本身是超长消息，只截前 200 字以免喧宾夺主
      const piece = i === idx ? t : (t.length > 200 ? `${t.slice(0, 200)}…` : t);
      if (i !== idx && totalLen + piece.length > 700) continue;
      parts.push(`${speakerLabel(m.speaker)}：${piece}`);
      totalLen += piece.length;
    }
    return parts.length > 0 ? parts.join('\n') : baseText;
  } catch {
    return baseText;
  }
}

async function applyRerank(rerankCfg, query, hits, repo = null) {
  if (!rerankCfg?.reranker || !Array.isArray(hits) || hits.length <= 1) {
    return { hits, reranked: false, rerankError: null, rerankModel: null };
  }
  const topN = Math.min(rerankCfg.topN || RERANK_TOPN_DEFAULT, hits.length);
  const head = hits.slice(0, topN);
  const tail = hits.slice(topN);
  try {
    const sceneMsgsCache = new Map();
    const docs = head.map((h) => buildRerankDoc(h, repo, sceneMsgsCache));
    const ranked = await rerankCfg.reranker.rerank(query, docs, { topN });
    if (!Array.isArray(ranked) || ranked.length === 0) {
      return { hits, reranked: false, rerankError: null, rerankModel: rerankCfg.reranker.model ?? null };
    }
    const used = new Set();
    const reordered = [];
    for (const r of ranked) {
      used.add(r.index);
      reordered.push({ ...head[r.index], rerankScore: r.score });
    }
    for (let i = 0; i < head.length; i += 1) {
      if (!used.has(i)) reordered.push(head[i]);
    }
    return {
      hits: [...reordered, ...tail],
      reranked: true,
      rerankError: null,
      rerankModel: rerankCfg.reranker.model ?? null,
    };
  } catch (error) {
    return {
      hits,
      reranked: false,
      rerankError: error?.message ?? String(error),
      rerankModel: rerankCfg.reranker.model ?? null,
    };
  }
}

/**
 * 「这次召回可能不靠谱」的柔提示 —— **只提示，不拦截**。
 *
 * 只用已有的余弦分判断，不调任何额外模型。返回 null 表示无需提示。
 *
 * 为什么不做硬拒答：
 *   ① 提高余弦阈值会误伤大量正例；
 *   ② 词重叠度与 top1−top2 分数差在正负例之间区分度极低；
 *   ③ 人不会用原话搜索（原话「医院居然关门了」→ 查询「带猫看病跑空」，零字面重合），
 *      这正是语义检索存在的理由，任何「无字面命中即拒答」的规则都会误杀核心场景；
 *   ④ 检索路径保持纯检索，不额外引入 LLM 核对层。
 *
 * 因此这里只做一件事：当「最好的那条都不够像」时，在结果顶上写一句话，
 * 让 Agent 知道该谨慎，而不是替它下结论。
 * 硬闸门一旦误判，用户就再也搜不到那条 —— 代价远大于多给几条让 Agent 自己挑。
 *
 * @param {object[]} hits 已排序的命中（带 score）
 * @param {number} keywordHits 关键词路命中数（>0 说明有字面证据，不算弱）
 * @returns {string|null}
 */
export const WEAK_RERANK_FLOOR = 0.15;
export const WEAK_QWEN3_RERANK_FLOOR = 0.45;

export function weakEvidenceHint(hits, keywordHits = 0, rerankModel = '') {
  const list = Array.isArray(hits) ? hits : [];
  // 若已执行 Rerank 且精排最高分仍极低，即便字面撞了同名实体词也要触发低置信提示
  const rrScores = list.map((h) => h?.rerankScore).filter((s) => typeof s === 'number');
  if (rrScores.length > 0) {
    const floor = /qwen3[-_ ]?reranker/i.test(String(rerankModel ?? ''))
      ? WEAK_QWEN3_RERANK_FLOOR
      : WEAK_RERANK_FLOOR;
    const topRR = Math.max(...rrScores);
    if (topRR < floor) {
      return `⚠ 相关度偏低（重排最高 ${topRR.toFixed(2)}）：下面几条可能只是话题相近，未必真的回答了你要找的事。请先读原文自行确认，对不上就换更具体的说法或指定时间再搜一次。`;
    }
  }
  if (keywordHits > 0) return null;   // 无重排或重排未否决时，有字面命中不算弱
  const scores = list
    .map((h) => h?.score)
    .filter((s) => typeof s === 'number');
  if (scores.length === 0) return null;
  const top1 = Math.max(...scores);
  if (top1 >= WEAK_TOP1_FLOOR) return null;
  return `⚠ 相关度偏低（最高 ${top1.toFixed(2)}）：下面几条可能只是话题相近，未必真的回答了你要找的事。请先读原文自行确认，对不上就换更具体的说法或指定时间再搜一次。`;
}

/* ================================ 排版 ================================ */

/**
 * 场景块渲染 —— 「适当省略，支持完整」。
 *
 * 作者 2026-11-18 的观察：**真实对话场景都很短**，不能按长文档的思路一律截断。
 * 实测两个会话：
 *
 *   qqb 会话（QQ 桥接的真实聊天）  场景中位数 569 字，P75 956 字，最大 5920 字
 *                                   消息中位数 12 字，最大 1685 字，**0 条超 2000**
 *   当前会话（技术长谈）           场景中位数 2248 字，最大 36442 字
 *
 * 所以阈值不能拍一个数了事，要按"这一场实际多大"决定：
 *   ≤ AUTO_FULL_SCENE_CHARS  → **整场给**（真实聊天 85% 的场景落在这）
 *   >  阈值                  → 接缝（开头 2 + 命中处前后 2 + 结尾 2），标注省略了多少轮
 *   expand === 'scene'       → 无条件整场（TA明确要）
 *   expand === 'snippet'     → 只给命中句 + 紧邻 1 句（最省）
 *
 * 同一场里命中多条时**只渲染一次**（避免同一段往来重复贴好几遍）。
 */
function renderShown(shown, opts) {
  const { includeExcluded, expand, repo, extras = null, dshHome = null } = opts;

  // ① 按场景分组，保住命中顺序
  const groups = new Map();
  for (const row of shown) {
    const sid = row.sceneId === null || row.sceneId === undefined ? null : Number(row.sceneId);
    const key = sid === null ? `msg:${row.id}` : `scene:${sid}`;
    if (!groups.has(key)) groups.set(key, { sceneId: sid, rows: [] });
    groups.get(key).rows.push(row);
  }

  // 预取所有相关消息的媒体附件路径与备注（含同场次邻居，确保 [图片] 均带本地路径）
  const mediaIds = new Set(shown.map((r) => r.id).filter((id) => id !== undefined && id !== null));
  if (repo && typeof repo.msgsByScene === 'function') {
    for (const g of groups.values()) {
      if (g.sceneId !== null) {
        try {
          for (const m of repo.msgsByScene(g.sceneId, includeExcluded)) {
            if (m && m.id !== undefined && m.id !== null) mediaIds.add(m.id);
          }
        } catch { /* ignore */ }
      }
    }
  }
  const annotateMedia = buildMediaAnnotator(extras, [...mediaIds], dshHome);

  const blocks = [];
  // 预算：1 条命中的短场景整场给约 5000 字；8 条都整场就 4 万字，会撑爆上下文。
  // 用完预算之后自动降级成接缝（不改变 auto 的语义，只是兜住总量）。
  let budget = MAX_TOTAL_CONTEXT_CHARS;
  for (const g of groups.values()) {
    if (g.sceneId === null) {
      // 还没归场的消息：只能单条给
      for (const row of g.rows) {
        const block = renderHit(row, { includeExcluded, annotateMedia });
        budget -= block.length;
        blocks.push(block);
      }
      continue;
    }
    const bestRank = Math.min(...g.rows.map((r) => (typeof r._rank === 'number' ? r._rank : 1)));
    const rowExpand = expand === 'auto' && bestRank >= 4 ? 'snippet' : expand;
    const block = renderSceneBlock(g.rows, { includeExcluded, expand: rowExpand, repo, budget, compactTime: opts?.compactTime === true, annotateMedia });
    budget -= block.length;
    blocks.push(block);
  }
  return blocks.join('\n\n');
}

/**
 * 一条场景内的消息怎么排（hit = 它是本次命中，hitRow 带 sources/score）
 *
 * @param {object} msg
 * @param {{hit:boolean, hitRow:object|null, includeExcluded:boolean,
 *          compactTime?:boolean}} opts
 *   `compactTime` —— 陪伴型会话只给 `MM-DD 时段`（不给时分）。
 *   实测陪伴场景时间戳占 **21.6%** 的篇幅，行头（缩进+时间+说话人）共占 **41.2%**，
 *   而单条正文平均只有 20 字 —— 时分在密集短对话里几乎没有信息价值。
 */
function renderSceneMsg(msg, opts) {
  const { hit, hitRow, includeExcluded, compactTime = false, inHitWindow = false, inFocusExchange = false } = opts;
  // **来源标记不能丢**（作者 2026-11-18）：场景块里的命中句同样要标 kw / vec / kw+vec + 余弦
  let mark = '';
  if (hit && hitRow) {
    const sources = Array.isArray(hitRow.sources) ? hitRow.sources : null;
    if (sources && sources.length > 0) {
      const vecOnly = sources.length === 1 && sources[0] === 'vector';
      const both = sources.includes('keyword') && sources.includes('vector');
      const cos = typeof hitRow.score === 'number' ? hitRow.score.toFixed(2) : null;
      if (vecOnly) mark = ` vec${cos ? ` ${cos}` : ''}`;
      else if (both) mark = ` kw+vec${cos ? ` ${cos}` : ''}`;
    }
  }
  const focusMark = hit ? '  ←' : (inFocusExchange ? '  ◆' : '');
  const chunkInfo = hit && hitRow ? hitRow.chunk : null;
  const clipMax = (hit || inFocusExchange || (compactTime && inHitWindow))
    ? HIT_CLIP_MAX
    : (inHitWindow ? 480 : CONTEXT_CLIP_MAX);
  const clippedBase = clipText(msg.text, clipMax);
  const msgText = opts.annotateMedia ? opts.annotateMedia(msg.id, clippedBase) : clippedBase;

  const lines = [];
  if (compactTime && !(chunkInfo && Number.isFinite(chunkInfo.startChar) && Number.isFinite(chunkInfo.endChar))) {
    const textLines = msgText.split('\n');
    const suffix = `${mark}${focusMark}`;
    lines.push(`    ${speakerLabel(msg.speaker)}：${textLines[0]}${textLines.length === 1 ? suffix : ''}`);
    for (let i = 1; i < textLines.length; i++) {
      lines.push(`      ${textLines[i]}${i === textLines.length - 1 ? suffix : ''}`);
    }
  } else {
    const stamp = compactTime ? `${fmtDate(msg.at)} ${fmtPhase(msg.at)}` : fmtStamp(msg.at);
    lines.push(`    ${stamp}  ${speakerLabel(msg.speaker)}${mark}${focusMark}`);
    if (chunkInfo && Number.isFinite(chunkInfo.startChar) && Number.isFinite(chunkInfo.endChar)) {
      const seg = String(msg.text ?? '').slice(chunkInfo.startChar, chunkInfo.endChar);
      const segMax = hit ? Math.max(SEGMENT_MAX, seg.length) : CONTEXT_CLIP_MAX;
      const segClipped = clipText(seg, segMax);
      const segText = opts.annotateMedia ? opts.annotateMedia(msg.id, segClipped) : segClipped;
      lines.push(indentText(segText, '      '));
      const total = chunkInfo.total ?? null;
      const where = total ? `第 ${chunkInfo.idx + 1}/${total} 段` : `第 ${chunkInfo.idx + 1} 段`;
      lines.push(`      ✂ ${where}（全文 ${fmtCount(String(msg.text ?? '').length)} 字）`);
    } else {
      lines.push(indentText(msgText, '      '));
    }
  }
  if (hit && msg.inSurface === 0) lines.push(`      ${MARK_COMPACTED_ONE}`);
  if (hit && includeExcluded && msg.excluded === 1) lines.push(`      ${MARK_EXCLUDED_ONE}`);
  if (hit && Array.isArray(hitRow?.relatedTimeline) && hitRow.relatedTimeline.length > 0) {
    const dates = hitRow.relatedTimeline.map((rt) => fmtDate(rt.at)).filter(Boolean);
    if (dates.length > 0) lines.push(`      ↳ 跨日同主题：${[...new Set(dates)].join('、')}`);
  }
  return lines.join('\n');
}

/** 跨场动态上下文桥接的最大时间间隔：仅在连贯对话（≤10m）的切分边界附近补前后 2 句 */
const CONTINUOUS_BRIDGE_GAP_MS = 10 * 60_000;

/** 渲染一场（整场 / 接缝 / 片段），并在命中紧贴连贯切界时动态桥接前后相邻 2 句 */
function renderSceneBlock(rows, opts) {
  const { includeExcluded, expand, repo, budget = MAX_TOTAL_CONTEXT_CHARS, compactTime = false, annotateMedia = null } = opts;
  const anchor = rows[0];
  const sceneId = Number(anchor.sceneId);
  const hitIds = new Set();
  for (const r of rows) {
    hitIds.add(Number(r.id));
    if (Array.isArray(r.matchedMsgIds)) {
      for (const mid of r.matchedMsgIds) hitIds.add(Number(mid));
    }
  }
  // id → 命中行（带 sources / score），渲染时要用它标 kw/vec
  const rowById = new Map(rows.map((r) => [Number(r.id), r]));

  let msgs = [];
  try {
    msgs = repo.msgsByScene(sceneId, includeExcluded).map((m) => ({
      ...m,
      // 数据库行没有 sources/score，命中标记靠 id 判断，不需要带
    }));
  } catch {
    msgs = [];
  }

  // 拉不到整场（老库没归场 / 查询失败）→ 退回单条，信息不丢
  if (msgs.length === 0) {
    return rows.map((r) => renderHit(r, { includeExcluded })).join('\n\n');
  }

  const totalChars = msgs.reduce((s, m) => s + String(m.text ?? '').length, 0);
  const range = fmtRange(anchor.sceneStartAt, anchor.sceneEndAt);
  const n = msgs.length;
  const hitIndices = [];
  msgs.forEach((m, i) => { if (hitIds.has(Number(m.id))) hitIndices.push(i); });
  const hitCount = hitIndices.length;

  // 若命中紧贴连贯场景的开头/结尾（≤2 句），跨界补 2 句上下文避免边界误切丢前因后果
  let bridgeBefore = [];
  let bridgeAfter = [];
  if (expand !== 'snippet' && hitIndices.length > 0 && typeof repo?.sceneById === 'function') {
    const firstHit = hitIndices[0];
    const lastHit = hitIndices[hitIndices.length - 1];
    if (firstHit <= 1 || lastHit >= n - 2) {
      try {
        const sc = repo.sceneById(sceneId);
        if (firstHit <= 1 && sc?.precededBy && typeof sc.gapBeforeMs === 'number' && sc.gapBeforeMs <= CONTINUOUS_BRIDGE_GAP_MS) {
          bridgeBefore = repo.msgsByScene(sc.precededBy, includeExcluded).slice(-2);
        }
        if (lastHit >= n - 2 && sc?.followedBy && typeof sc.gapAfterMs === 'number' && sc.gapAfterMs <= CONTINUOUS_BRIDGE_GAP_MS) {
          bridgeAfter = repo.msgsByScene(sc.followedBy, includeExcluded).slice(0, 2);
        }
      } catch {
        bridgeBefore = [];
        bridgeAfter = [];
      }
    }
  }

  const pushBridge = (lines, label, list) => {
    if (!list.length) return;
    lines.push(`    ${label}`);
    for (const m of list) {
      lines.push(renderSceneMsg(m, { hit: false, hitRow: null, includeExcluded, compactTime }));
    }
  };

  // ── snippet：只有命中句 + 紧邻 1 句 ──
  if (expand === 'snippet') {
    const keep = new Set();
    msgs.forEach((m, i) => {
      if (!hitIds.has(Number(m.id))) return;
      keep.add(i);
      if (i > 0) keep.add(i - 1);
      if (i < n - 1) keep.add(i + 1);
    });
    const picked = [...keep].sort((a, b) => a - b);
    const lines = [`  ${range} · ${fmtCount(n)}轮 · 命中 ${fmtCount(hitCount)} 处（片段）`];
    let prev = -2;
    for (const i of picked) {
      if (i !== prev + 1) lines.push('    ⋯');
      lines.push(renderSceneMsg(msgs[i], { hit: hitIds.has(Number(msgs[i].id)), hitRow: rowById.get(Number(msgs[i].id)), includeExcluded, compactTime, annotateMedia }));
      prev = i;
    }
    return lines.join('\n');
  }

  // ── 整场：场景够小，或者TA明确要 ──
  // 整场给的条件：TA明确要，或者场景够小**且**总预算还够（预估渲染开销约 4 倍字数）
  const fitsBudget = budget > totalChars * 4;
  const wantFull = expand === 'scene' || (totalChars <= AUTO_FULL_SCENE_CHARS && fitsBudget);
  if (wantFull) {
    const why = expand === 'scene' ? '' : ` · ${fmtCount(totalChars)}字`;
    const lines = [`  ${range} · ${fmtCount(n)}轮${why} · 命中 ${fmtCount(hitCount)} 处`];
    pushBridge(lines, '↖ 紧接前文（跨场连贯）', bridgeBefore);
    for (const m of msgs) {
      lines.push(renderSceneMsg(m, { hit: hitIds.has(Number(m.id)), hitRow: rowById.get(Number(m.id)), includeExcluded, compactTime, annotateMedia }));
    }
    pushBridge(lines, '↘ 紧接下文（跨场连贯）', bridgeAfter);
    return lines.join('\n');
  }

  // ── 接缝：开头 2 + 命中处前后 2（及命中对话窗全段）+ 结尾 2 ──
  const EDGE = 2;
  const AROUND = 2;
  const keep = new Set();
  const hitWindowMsgIds = new Set();
  const focusExchangeMsgIds = new Set();
  for (let i = 0; i < Math.min(EDGE, n); i++) keep.add(i);
  for (let i = Math.max(0, n - EDGE); i < n; i++) keep.add(i);
  msgs.forEach((m, i) => {
    if (!hitIds.has(Number(m.id))) return;
    const hitItem = rowById.get(Number(m.id));
    const win = hitItem?.window;
    const isTopNoWin = !win && typeof hitItem?._rank === 'number' && hitItem._rank <= 2;
    const afterSpan = isTopNoWin ? 5 : AROUND;
    for (let k = Math.max(0, i - AROUND); k <= Math.min(n - 1, i + afterSpan); k++) {
      keep.add(k);
      if (isTopNoWin && k > i) hitWindowMsgIds.add(Number(msgs[k].id));
    }
    if (win && Number.isFinite(win.startMsgId) && Number.isFinite(win.endMsgId)) {
      for (let k = 0; k < n; k++) {
        const mid = Number(msgs[k].id);
        if (mid >= win.startMsgId && mid <= win.endMsgId) {
          keep.add(k);
          hitWindowMsgIds.add(mid);
        }
      }
    }
    const fex = hitItem?.focusExchange;
    if (fex && Number.isFinite(fex.startMsgId) && Number.isFinite(fex.endMsgId)) {
      for (let k = 0; k < n; k++) {
        const mid = Number(msgs[k].id);
        if (mid >= fex.startMsgId && mid <= fex.endMsgId) focusExchangeMsgIds.add(mid);
      }
    }
  });
  const picked = [...keep].sort((a, b) => a - b);
  const omitted = n - picked.length;

  /**
   * **省略段给出可定位的时间区间** —— 否则 Agent 想补查也不知道 `when` 填什么。
   *
   * 实测过：现在只说「省略 17 轮」，Agent 即便愿意再查一次也无从下手
   * （拿 `when` 精确补查 22 条省略消息，只找回 3 条 —— 因为时间路自己也在摘录）。
   *
   * 所以这里把**第一个被省略段**的起止时刻说出来，
   * 让 `memory_search({ when: "2026-10-31 18:24..18:38" })` 变成一条真实可走的路径。
   */
  let omittedSpan = '';
  if (omitted > 0) {
    const gaps = [];
    let runStart = null;
    for (let i = 0; i < n; i += 1) {
      const kept = picked.includes(i);
      if (!kept && runStart === null) runStart = i;
      if (kept && runStart !== null) {
        gaps.push([runStart, i - 1]);
        runStart = null;
      }
    }
    if (runStart !== null) gaps.push([runStart, n - 1]);
    // 只标最长的那个缺口（其余靠「省略 N 轮」总数就够了）
    const widest = gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    if (widest) {
      const a = msgs[widest[0]];
      const b = msgs[widest[1]];
      const fmtWhenPoint = (ms) => {
        const d = new Date(Number(ms) + 8 * 3600_000);
        const p2 = (v) => String(v).padStart(2, '0');
        return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
      };
      omittedSpan = `最大一段 ${fmtWhenPoint(a.at)}..${fmtWhenPoint(b.at)} 可传 when 补查`;
    }
  }

  const lines = [
    `  ${range} · ${fmtCount(n)}轮 · ${fmtCount(totalChars)}字 · 命中 ${fmtCount(hitCount)} 处`
    + `（省略 ${fmtCount(omitted)} 轮${omittedSpan ? `；${omittedSpan}` : "；要看全用 expand: 'scene'"}）`,
  ];
  pushBridge(lines, '↖ 紧接前文（跨场连贯）', bridgeBefore);
  let prev = -2;
  for (const i of picked) {
    if (i !== prev + 1) lines.push('    ⋯');
    const mid = Number(msgs[i].id);
    lines.push(renderSceneMsg(msgs[i], {
      hit: hitIds.has(mid),
      hitRow: rowById.get(mid),
      includeExcluded,
      compactTime,
      inHitWindow: hitWindowMsgIds.has(mid),
      inFocusExchange: focusExchangeMsgIds.has(mid),
      annotateMedia,
    }));
    prev = i;
  }
  pushBridge(lines, '↘ 紧接下文（跨场连贯）', bridgeAfter);
  return lines.join('\n');
}


function renderHit(row, opts) {
  const lines = [`  ${fmtStamp(row.at)}  ${speakerLabel(row.speaker)}`];
  if (row.chunk && Number.isFinite(row.chunk.startChar) && Number.isFinite(row.chunk.endChar)) {
    const seg = String(row.text ?? '').slice(row.chunk.startChar, row.chunk.endChar);
    const segText = opts.annotateMedia ? opts.annotateMedia(row.id, seg) : seg;
    lines.push(indentText(segText, '    '));
    const total = row.chunk.total ?? null;
    const where = total ? `第 ${row.chunk.idx + 1}/${total} 段` : `第 ${row.chunk.idx + 1} 段`;
    lines.push(`    ✂ ${where}（全文 ${fmtCount(String(row.text ?? '').length)} 字）`);
  } else {
    const rowText = opts.annotateMedia ? opts.annotateMedia(row.id, row.text) : row.text;
    lines.push(indentText(clipText(rowText, HIT_CLIP_MAX), '    '));
  }

  const hasScene = row.sceneStartAt !== null && row.sceneStartAt !== undefined;
  if (hasScene) {
    lines.push(`    ⤷ ${fmtRange(row.sceneStartAt, row.sceneEndAt)} / ${fmtCount(row.sceneMsgCount ?? 0)}轮`);
  }
  // 未归场时不写任何占位 —— 每行重复一句"还没归到哪一场里"只是噪声（作者 2026-11-18 指出）

  // **来源标记**（作者 2026-11-18：返回可以用检索术语，不必写成中文长句）
  // sources 由 RRF 融合时写入：字面命中 = kw，语义召回 = vec。
  // 只有 vec 的条目是「猜的」，必须让TA看得见 —— 否则语义路 top-k 会把无关句也当命中。
  let mark = '';
  const sources = Array.isArray(row.sources) ? row.sources : null;
  if (sources && sources.length > 0) {
    const vecOnly = sources.length === 1 && sources[0] === 'vector';
    const both = sources.includes('keyword') && sources.includes('vector');
    // 显示**余弦**（像不像），不是 RRF 分（排第几）——
    // 作者 2026-11-18：`vec 0.016` 那种数字看不出相关性，0.62 才看得出。
    const cos = typeof row.score === 'number' ? row.score.toFixed(2) : null;
    if (vecOnly) mark = ` vec${cos ? ` ${cos}` : ''}`;
    else if (both) mark = ` kw+vec${cos ? ` ${cos}` : ''}`;
  }
  // 并到时间行末尾（省一整行）：`  11-09 15:01  我  vec 0.016`
  if (mark) lines[0] += mark;

  if (row.inSurface === 0) lines.push(`    ${MARK_COMPACTED_ONE}`);
  if (opts.includeExcluded && row.excluded === 1) lines.push(`    ${MARK_EXCLUDED_ONE}`);
  if (Array.isArray(row.relatedTimeline) && row.relatedTimeline.length > 0) {
    const dates = row.relatedTimeline.map((rt) => fmtDate(rt.at)).filter(Boolean);
    if (dates.length > 0) lines.push(`    ↳ 跨日同主题：${[...new Set(dates)].join('、')}`);
  }
  return lines.join('\n');
}

/**
 * 一条笔记怎么排：
 *  `  11-17 18:20  笔记 #3`
 *     `他说「我怕你把我忘了」，我把这句记下来了。`
 *     `（关于你们俩）`
 *
 * @param {{id:number, content:string, about?:string|null, at:number}} note
 * @returns {string}
 */
function renderNote(note) {
  const lines = [`  ${fmtStamp(note.at)}  笔记 #${note.id}`];
  lines.push(indentText(clipText(note.content), '    '));
  const label = noteAboutLabel(note.about); // 全仓共用一份标签（format.js）
  if (label) lines.push(`    （${label}）`);
  return lines.join('\n');
}

/**
 * 在内存里按 query 过滤笔记（note 表没有 FTS；TA的笔记总量很小，够快）。
 *
 * 匹配口径与关键词路一致：任一「词」被正文包含即算命中（不分大小写）。
 * @param {object[]} notes
 * @param {string} query
 * @returns {object[]}
 */
function filterNotes(notes, query) {
  if (isListAllQuery(query)) return notes;
  const terms = splitTerms(query);
  if (terms.length === 0) return notes;
  const haystacks = terms.map((t) => t.toLowerCase());
  return notes.filter((note) => {
    const body = String(note?.content ?? '').toLowerCase();
    return haystacks.some((t) => body.includes(t));
  });
}

/* ================================ 路由实现 ================================ */

/**
 * 纯时间参数 → 给关键词/语义路用的硬边界。
 * `latest` 且没有显式时间时返回 null（= 不限时间）。
 *
 * @returns {{from:number, to:number}|null}
 */
function windowBounds(window) {
  if (!window || window.kind === 'latest' || window.from === null || window.to === null) return null;
  return { from: Number(window.from), to: Number(window.to) };
}

/**
 * 时间路先圈出候选场景 → 返回候选场景 id 集合（合并查询的"候选"就是这些场次里的消息）。
 *
 * @returns {Set<number>|null} null = 没有时间约束
 */
function candidateSceneIds(repo, sessionId, bounds) {
  if (!bounds) return null;
  const scenes = repo.scenesByTimeRange(sessionId, bounds.from, bounds.to, 500);
  return new Set(scenes.map((s) => Number(s.id)));
}

/**
 * 把命中限制在候选场景里（场景 id 缺失的老数据按时间窗已经过滤过，保留）。
 * @param {object[]} rows
 * @param {Set<number>|null} allowed
 * @returns {object[]}
 */
function restrictToCandidates(rows, allowed) {
  if (!allowed) return rows;
  return rows.filter((row) => {
    if (row.sceneId === null || row.sceneId === undefined) return true;
    return allowed.has(Number(row.sceneId));
  });
}

/**
 * 把一条滑动对话窗命中（window hit）映射为与 msg 命中同形的对象：
 * 挑选窗口内最具代表性的锚点消息，并附带 `window` 区间与完整对话窗文本供渲染与 Rerank 使用。
 */
function hydrateWindowHit(win, { repo, includeExcluded, queryTerms = [], bounds = null, sceneMsgsCache = new Map() }) {
  if (!win || !repo) return null;
  const sid = Number(win.sceneId);
  let smsgs = [];
  if (Number.isSafeInteger(sid) && sid > 0 && typeof repo.msgsByScene === 'function') {
    if (sceneMsgsCache.has(sid)) {
      smsgs = sceneMsgsCache.get(sid);
    } else {
      try {
        smsgs = repo.msgsByScene(sid, includeExcluded);
      } catch {
        smsgs = [];
      }
      sceneMsgsCache.set(sid, smsgs);
    }
  }
  const startId = Number(win.startMsgId);
  const endId = Number(win.endMsgId);
  const inWin = smsgs.filter((m) => Number(m.id) >= startId && Number(m.id) <= endId);
  let anchor = null;
  if (inWin.length > 0) {
    if (queryTerms.length > 0) {
      anchor = inWin.find((m) => {
        const t = String(m.text ?? '');
        return queryTerms.some((term) => term && t.includes(term));
      }) ?? null;
    }
    if (!anchor) {
      anchor = inWin.find((m) => m.speaker === 'user' && String(m.text ?? '').trim().length >= 4) ?? inWin[0];
    }
  } else if (typeof repo.msgsByIds === 'function' && Number.isSafeInteger(startId)) {
    try {
      const [m] = repo.msgsByIds([startId]);
      if (m && (includeExcluded || Number(m.excluded) !== 1)) anchor = m;
    } catch {
      anchor = null;
    }
  }
  if (!anchor) return null;
  if (bounds && (anchor.at < bounds.from || anchor.at >= bounds.to)) return null;
  return {
    ...anchor,
    sceneStartAt: win.sceneStartAt ?? anchor.sceneStartAt ?? win.startAt,
    sceneEndAt: win.sceneEndAt ?? anchor.sceneEndAt ?? win.endAt,
    sceneMsgCount: win.sceneMsgCount ?? anchor.sceneMsgCount ?? win.msgCount,
    ...(typeof win.score === 'number' ? { score: win.score } : {}),
    ...(typeof win.distance === 'number' ? { distance: win.distance } : {}),
    window: {
      id: Number(win.windowId ?? win.id),
      kind: String(win.kind ?? 'window'),
      startMsgId: startId,
      endMsgId: endId,
      msgCount: Number(win.msgCount ?? inWin.length),
      text: String(win.text ?? ''),
    },
  };
}

/**
 * 向量路：assert 模型（D-152）→ embed 查询 → KNN（时间过滤在外层，D-150）。
 * 四层自适应融合：
 *   ① vec_msg    单条消息（保留长文本单句与精准短句泛用性）
 *   ② vec_chunk  超长消息分片（>=800 字）
 *   ③ vec_window 场景内短消息滑动对话窗（解决跨多句语义与指代缺失）
 *   ④ vec_scene  整场 gist 兜底（宏观主题补齐）
 *
 * @returns {object[]} 命中（带 sceneStartAt 等字段，与关键词路同形）
 */
async function runVectorRoute({
  provider, store, extras, query, sessionId, bounds, includeExcluded, perRoute, repo,
  // 开关必须**作为参数传入**：本函数是模块级的，看不到 handler 里的局部变量
  disableWindowVector = false,
  // 余弦阈值：可按模型分布覆盖
  vectorMinScore = VECTOR_MIN_SCORE,
  // 对话窗召回配额：默认 1.0（全量参与）
  windowQuota = 1.0,
  /**
   * 是否把 `vec_chunk` 提升为独立一路（默认关闭，生产勿开）。
   *
   * 原因：同一条长消息的不同分片会成为多个候选，在 RRF 里互相投票抬高总分，
   * 反而稀释真正精确命中的单句排名。保留此开关仅用于行为对照。
   */
  chunkAsSeparateRoute = false,
}) {
  extras.vecMeta.assert(provider); // D-152：模型不一致在这里抛，走降级说明
  const modelTag = String(provider?.model ?? provider?.id ?? '');
  const isQwen3Emb = /qwen3[-_ ]?embedding/i.test(modelTag);
  const embedQuery = isQwen3Emb && !String(query).startsWith('Instruct:')
    ? `Instruct: Given a conversation search query, retrieve relevant dialogue messages and events\nQuery: ${query}`
    : query;
  const [vec] = await provider.embed([embedQuery]);
  if (!vec) return [];
  const filter = { sessionId, includeExcluded, limit: perRoute };
  if (bounds) {
    filter.from = bounds.from;
    filter.to = bounds.to;
  }
  // **余弦阈值**（2026-11-18 实测定的）：语义路 top-k 一定有结果，哪怕毫不相关。
  // 真实数据分布：相关查询 0.55~0.96（「设置页打不开」0.963）；
  // 无关查询 0.37~0.50（「火星上的天气」0.500）。0.52 能干净分开（0.50 会让那条卡边界）。
  filter.minScore = vectorMinScore;

  // ① 消息级（短消息，一条一个向量）
  const msgHits = store.knnMsg(vec, perRoute, filter);

  // ② 分片级（超长消息，D-247）。同一条消息的多个分片命中只留最高分那条。
  const chunkHits = typeof store.knnChunk === 'function'
    ? store.knnChunk(vec, perRoute, filter)
    : [];

  // 分片命中 → 补全消息行（chunk 只给了 msg_id 和位置）
  const ids = [...new Set(chunkHits.map((h) => h.msgId))];
  let rowsById = new Map();
  if (ids.length > 0) {
    try {
      const rows = repo.msgsByIds(ids);
      for (const r of rows) rowsById.set(Number(r.id), r);
    } catch {
      rowsById = new Map();
    }
  }

  /**
   * msgId → 该消息命中的**全部**分片（按分数降序）
   *
   * 之前的实现只留最高分那一片（`bestChunk`），对超长消息是**信息丢失**：
   * 一条 7301 字的消息有 18 个分片，若查询命中的是第 15 片，
   * 其余 17 片里可能是**另一个主题**的内容，却被完全丢弃。
   *
   * 现在保留全部分片命中，把它们作为**同一消息的多个证据点**：
   *   · 融合时同一条消息只占一个名额（避免重复占位）
   *   · 但 `chunkSegments` 记录所有命中位置，渲染与后续扩展时可用
   */
  const chunksByMsg = new Map();
  for (const h of chunkHits) {
    const k = Number(h.msgId);
    if (!chunksByMsg.has(k)) chunksByMsg.set(k, []);
    chunksByMsg.get(k).push(h);
  }
  for (const arr of chunksByMsg.values()) arr.sort((a, b) => b.score - a.score);

  const chunkAsMsg = [];
  for (const [msgId, segs] of chunksByMsg) {
    const row = rowsById.get(msgId);
    if (!row) continue;
    // 时间窗 / 排除条件在外层（`hydrateMsgs` 已经管了消息级，这里补一次）
    if (bounds && (row.at < bounds.from || row.at >= bounds.to)) continue;
    if (!includeExcluded && Number(row.excluded) === 1) continue;
    // 分片位置：渲染时只显示这一段，并标注「第 k/M 段」
    let totalChunks = null;
    try { totalChunks = extras?.chunk?.count?.(msgId) || null; } catch { totalChunks = null; }
    const top = segs[0];
    chunkAsMsg.push({
      ...row,
      score: top.score,
      distance: top.distance,
      chunk: {
        idx: top.idx,
        startChar: top.startChar,
        endChar: top.endChar,
        total: totalChunks,
      },
      // 该消息命中的**所有**分片位置：同一条消息可能在不同主题上被多处命中的
      // 证据（渲染时只用 top，其余留给后续扩展或诊断）
      chunkSegments: segs.map((s) => ({
        idx: s.idx,
        startChar: s.startChar,
        endChar: s.endChar,
        score: s.score,
      })),
    });

  }
  // ③ 合并：同一 msg 既在消息级又在分片级 → 取高的那条（并用分片信息补位置）
  //
  // **F2（chunkAsSeparateRoute）**：开启时不在这里合并。
  // 原因：这里的 `if (r.score > prev.score)` 是按「消息」比较，
  // 一条长消息只会保留分数最高的那个分片；如果另一个分片讲的是**完全不同的主题**，
  // 它的证据就永久丢失了。开启后让分片自己成为一路候选（见下方 chunkRoute），
  // 由 RRF 按名次融合 —— 同一消息在跨路时仍会因 span 分组被合成一项。
  const merged = new Map();
  for (const r of msgHits) merged.set(Number(r.id), r);
  if (!chunkAsSeparateRoute) {
    for (const r of chunkAsMsg) {
      const prev = merged.get(Number(r.id));
      if (!prev || (r.score ?? 0) > (prev.score ?? 0)) merged.set(Number(r.id), r);
      else if (prev) prev.chunk = r.chunk;   // 分数低的也把分片位置带上（显示用）
    }
  }

  // ③.5 对话窗 / 交互原子 / 微话题级（vec_window）：多句短消息合窗语义召回
  // 可用 deps.disableWindowVector 关掉（对照调试用，生产默认开启）
  const exchangeHits = [];
  const threadHits = [];
  if (!includeExcluded && typeof store.knnWindow === 'function' && repo && disableWindowVector !== true) {
    try {
      const quota = Number.isFinite(windowQuota) && windowQuota >= 0 ? windowQuota : 1.0;
      const winLimit = Math.max(1, Math.round(perRoute * quota));
      const winFetch = Math.max(winLimit * 3, 48);
      const winHits = store.knnWindow(vec, winFetch, {
        sessionId,
        from: bounds?.from,
        to: bounds?.to,
        minScore: vectorMinScore,
      });
      // 若库内启用了微话题体系（含 exchange/thread），额外保证单独捞足 Top-20 thread，
      // 避免高分的短 exchange 把长 thread 挤出前 48 名导致退化成散碎窗口。
      const hasTypedWindows = Array.isArray(winHits) && winHits.some((w) => w.kind === 'exchange' || w.kind === 'thread');
      if (hasTypedWindows) {
        const extraThreads = store.knnWindow(vec, 20, {
          sessionId,
          from: bounds?.from,
          to: bounds?.to,
          minScore: vectorMinScore,
          kind: 'thread',
          overFetch: 16,
        });
        const seenWinIds = new Set(winHits.map((w) => Number(w.id)));
        for (const th of extraThreads) {
          if (!seenWinIds.has(Number(th.id))) {
            seenWinIds.add(Number(th.id));
            winHits.push(th);
          }
        }
      }
      if (Array.isArray(winHits) && winHits.length > 0) {
        const sceneMsgsCache = new Map();
        const queryTerms = splitTerms(query);
        for (const wh of winHits) {
          const mapped = hydrateWindowHit(wh, { repo, includeExcluded, queryTerms, bounds, sceneMsgsCache });
          if (!mapped) continue;
          const kind = mapped.window?.kind ?? 'window';
          if (kind === 'exchange') {
            exchangeHits.push(mapped);
            continue;
          }
          if (kind === 'thread') {
            threadHits.push(mapped);
            continue;
          }
          const mid = Number(mapped.id);
          const prev = merged.get(mid);
          if (!prev || (mapped.score ?? 0) > (prev.score ?? 0)) {
            merged.set(mid, prev ? { ...prev, ...mapped, window: mapped.window } : mapped);
          } else if (prev && !prev.window) {
            prev.window = mapped.window;
          }
        }
      }
    } catch {
      // vec_window 未建或不可用时静默跳过，不影响 msg/chunk/scene 召回
    }
  }

  // ④ 场景级（vec_scene，基于 scene.gist）：**默认关闭**。
  //    gist 仅用短摘要概括整场对话，容易偏向场景开头并丢失深处细节；
  //    整场语义召回已由 vec_window 承担，vec_scene 只保留给时间轴目录标题使用。
  //    需要旧行为（把整场摘要当兜底锚点）时显式传 deps.sceneFallback = true。
  if (SCENE_FALLBACK_ENABLED && typeof store.knnScene === 'function' && repo && typeof repo.msgsByScene === 'function') {
    try {
      const sceneHits = store.knnScene(vec, Math.min(perRoute, 6), {
        sessionId,
        from: bounds?.from,
        to: bounds?.to,
        minScore: Math.max(vectorMinScore, 0.56),
      });
      if (Array.isArray(sceneHits) && sceneHits.length > 0) {
        const coveredScenes = new Set(
          [...merged.values()]
            .map((r) => (r.sceneId === null || r.sceneId === undefined ? null : Number(r.sceneId)))
            .filter((x) => x !== null),
        );
        for (const sh of sceneHits) {
          const sid = Number(sh.id);
          if (!Number.isSafeInteger(sid) || coveredScenes.has(sid)) continue;
          const smsgs = repo.msgsByScene(sid, includeExcluded);
          if (!smsgs || smsgs.length === 0) continue;
          const anchor = smsgs.find((m) => m.speaker === 'user' && String(m.text ?? '').trim().length >= 6) ?? smsgs[0];
          if (!anchor) continue;
          if (bounds && (anchor.at < bounds.from || anchor.at >= bounds.to)) continue;
          if (!merged.has(Number(anchor.id))) {
            merged.set(Number(anchor.id), {
              ...anchor,
              sceneStartAt: sh.startAt ?? anchor.at,
              sceneEndAt: sh.endAt ?? anchor.at,
              sceneMsgCount: sh.msgCount ?? smsgs.length,
              score: sh.score,
              distance: sh.distance,
            });
            coveredScenes.add(sid);
          }
        }
      }
    } catch {
      // vec_scene 未建或不可用时静默跳过，不影响消息级/分片级召回
    }
  }

  const sortedRaw = [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const mainHits = dedupeBySpan(sortedRaw, { mode: 'score', limit: perRoute });

  // **F2**：分片作为独立一路返回（默认不启用）。
  //
  // 关键：这里不做 `dedupeBySpan` 的跨消息合并，因为分片的目的是
  // 「让长消息里的另一个主题也有一次进候选的机会」。同一条消息在 RRF 阶段
  // 会被 span 分组归并（`createSpanIndex`），所以不会重复占名额。
  //
  // 只保留「不在主路里」的分片候选 —— 已经在主路里的消息不需要第二次机会。
  if (chunkAsSeparateRoute) {
    const mainIds = new Set(mainHits.map((h) => Number(h.id)));
    const extraChunks = chunkAsMsg
      .filter((r) => !mainIds.has(Number(r.id)))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, perRoute);
    return { hits: mainHits, chunkRoute: extraChunks, exchangeRoute: exchangeHits, threadRoute: threadHits };
  }

  return { hits: mainHits, chunkRoute: [], exchangeRoute: exchangeHits, threadRoute: threadHits };
}


/**
 * 语义状态说明（G5：降级必须说话；M2：三种「不可用」各说各的）。
 *
 *   vec:off     没有 key / 没有 provider
 *   vec:empty   有 key 但索引为空 —— **没跑**
 *   vec:partial 有索引但覆盖率不足 —— **没跑**
 *   vec:err     跑了但失败
 *
 * @param {SemanticState} semantic
 * @param {object|null} meta searchWithRRF 的 meta
 * @param {VectorIndexState|null} [vectorIndex]
 * @returns {string|null}
 */
function semanticNote(semantic, meta, vectorIndex = null) {
  const trimTail = (text) => String(text ?? '').replace(/[。.\s]+$/u, '');
  // G5 要求「必须明说，不能静默降级」，但没必要写成一整句中文。
  if (!semantic.ok) return `${SEMANTIC_OFF_TAG} ${trimTail(semantic.reason)}`;
  if (vectorIndex?.note) return vectorIndex.note; // vec:empty / vec:partial（没跑，先于 err 判定）
  if (meta?.degraded && meta.vectorError) return `vec:err ${trimTail(meta.vectorError)}`;
  return null;
}

/* ================================ 工具定义 ================================ */

export const SEARCH_DESCRIPTION =
  '按时间或按意思翻以前说过的话与笔记。只看某段时间聊了什么 → 填 when（如 2026-11-09、11-09、2026-11、2026-11-09..2026-11-12 或 7d）。'
  + '找某句话、某件事或某种感觉 → 填 query；两个都填 = 在该时间段里找。都不填 → 看最近一次聊天。'
  + '被用户设为不回想/排除的记录不会返回。scope 填 note 可只翻你自己记过的笔记（含回收站提示）。'
  + '\n\n'
  + '【返回说明】\n'
  + '· 说话人：`他`=对方， `我`=你自己；`←` 标出本次命中的原话（完整不截断）。\n'
  + '· 若某场对话过长被折叠，会给出省略区间，可用 `when` 填该区间单独展开。';

export const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      maxLength: 200,
      description:
        '要找的词、句子或模糊印象。和 when 一起给 = 在该时间范围里找；scope 为 note 时留空 = 列出最近笔记（含回收站可用 ID）。',
    },
    when: {
      type: 'string',
      description:
        '标准日期或区间（上海时间）：单日（2026-11-09 / 11-09）、整月（2026-11）、区间（2026-11-09..2026-11-12）、最近天数（7d、30d）。留空不限时间。',
    },
    limit: {
      type: 'number',
      description: '最多返回几条；只按时间翻时为展开场数（默认 3 场），找原话时默认 8 条。',
    },
    scope: {
      type: 'string',
      enum: ['msg', 'note', 'all'],
      description:
        '不填（默认）= 翻对话原话并自动置顶高相关笔记（最多 3 条）；msg = 仅翻原话；note = 仅翻你的笔记；all = 两边完整检索。',
    },
    expand: {
      type: 'string',
      enum: ['auto', 'scene', 'snippet'],
      description:
        '上下文展开程度：auto（默认）= 自适应；scene = 整场完整往来；snippet = 仅命中句及紧邻一两句。',
    },
  },
  additionalProperties: false,
};

/**
 * 造一个 memory_search 工具（M1 合并版）。
 *
 * @param {{
 *   repo?: object, extras?: object, handle?: object,
 *   now?: number|(() => number),
 *   sessionId?: string,            // A1：绑定的会话（宿主按会话创建工具实例）
 *   provider?: object,             // 语义路的 embedding 提供方（测试/宿主注入）
 *   store?: object,                // 语义路的向量索引（测试/宿主注入）
 *   semantic?: boolean,            // false = 明确不启用语义路
 *   minIndexCoverage?: number,     // 索引覆盖率门槛（默认 0.5，M2：低于它不跑语义路）
 *   logger?: { warn(msg:string): void },
 *   onResult?: (info: {
 *     hits: object[], meta: object|null, semantic: object, keywordRows: object[],
 *     vectorIndex: object|null,
 *   }) => void,                    // 诊断/测试钩子：融合后的命中与 meta（生产不传）
 * }} [deps] 不传则用默认库单例（懒加载）
 * @returns {{name:string, description:string, parameters:object,
 *            handler:(args:object, ctx?:object) => Promise<string>}}
 */
export function createSearchTool(deps = {}) {
  return {
    name: 'memory_search',
    description: SEARCH_DESCRIPTION,
    parameters: SEARCH_PARAMETERS,

    async handler(args = {}, ctx = {}) {
      const now = resolveNow(deps, ctx);
      // A1：这个工具实例属于哪个会话。关键词路（msg）和 note 路都必须带上它。
      const sessionId = resolveSessionId(deps, ctx);
      try {
        const { repo, extras, handle } = resolveDeps(deps, ctx);
        const stats = safeStats(extras, sessionId);
        const includeExcluded = (deps?.allowExcluded === true || ctx?.allowExcluded === true)
          && Boolean(args?.includeExcluded);
        // 对照开关（默认 false）
        const disableWindowVector = deps.disableWindowVector === true || ctx.disableWindowVector === true;

        // **对话窗配额与时间格式检测**：
        // 显式传 deps.windowQuota 时以显式值为准。
        // 形态检测只做一次（按 库+会话 缓存），避免每次检索都扫全表。
        let windowQuota = Number.isFinite(deps.windowQuota) ? deps.windowQuota : null;
        /** 陪伴型 → 消息行只给「日期 + 时段」，不给时分（时分占 21.6% 篇幅却几乎无信息量） */
        let compactTime = typeof deps.compactTime === 'boolean' ? deps.compactTime : null;
        if (windowQuota === null || compactTime === null) {
          try {
            let perDb = shapeCache.get(handle);
            if (!perDb) {
              perDb = new Map();
              shapeCache.set(handle, perDb);
            }
            const cacheKey = String(sessionId ?? '');
            if (!perDb.has(cacheKey)) {
              const { detectSessionShape } = await import('../search/session-shape.js');
              perDb.set(cacheKey, detectSessionShape(handle, sessionId));
            }
            const shape = perDb.get(cacheKey);
            if (windowQuota === null) windowQuota = shape.windowQuota ?? 1.0;
            if (compactTime === null) compactTime = shape.shape === 'companion';
          } catch {
            if (windowQuota === null) windowQuota = 1.0;   // 检测失败时保守：全量开
            if (compactTime === null) compactTime = false; // 检测失败时保守：保留时分（信息更全）
          }
        }
        const limit = clampLimit(args?.limit);
        const rawScope = String(args?.scope ?? '').trim().toLowerCase();
        const explicitScope = SEARCH_SCOPES.includes(rawScope) ? rawScope : null;
        const scope = explicitScope ?? 'msg';
        // 返回多少上下文：auto（按场景大小自适应，默认）/ scene（整场）/ snippet（片段）
        const expand = ['scene', 'snippet'].includes(args?.expand) ? args.expand : 'auto';
        // query 本身不截断（长句还能走 LIKE 兜底），但**回显**必须折成一行 + 截断。
        const query = String(args?.query ?? '').trim();
        const queryLabel = clipInline(query, QUERY_LABEL_MAX);
        const wantMsg = scope !== 'note';
        const wantNote = scope !== 'msg';
        // 未显式指定 scope 且有 query 时：对高相关笔记做置顶补充（不占 msg 名额，受分数门槛约束）
        const wantPinnedNotes = explicitScope === null && query !== '';
        const window = resolveTimeWindow(args, now);
        const hasQuery = query !== '';
        const wantSemantic = (wantMsg || wantNote || wantPinnedNotes) && hasQuery;

        // 语义路的模块（global-config / embedding / vector-store）延迟加载：
        // 没 query 时连这三个模块都不 import。
        if (wantSemantic) await loadSemanticModules();
        const semantic = wantSemantic
          ? resolveSemantic({ ...deps, handle }, ctx, extras)
          : { ok: false, reason: null };

        /* -------------------- ① 没看懂的时间词 -------------------- */
        // 给了 when 却解析不出来：说清没看懂，绝不静默当成「不限时间」。
        if (window.kind === 'unknown') {
          return emptyText({
            head: `没看懂「${window.label}」指的是哪段时间。`,
            stats,
            tips: [
              'when 请用标准格式：例如 "2026-11-09"、"11-09"、"2026-11"、"2026-11-09..2026-11-12" 或 "7d"。',
              '不填 when 且不填 query 时，会返回最近一次聊天。',
            ],
          });
        }

        const bounds = windowBounds(window);
        const dshHome = deps?.dshHome || ctx?.dshHome || null;

        /* -------------------- ② 只有时间（或什么都没有） -------------------- */
        if (!hasQuery) {
          // 时间路：按场景与摘录展开
          const timeText = wantMsg
            ? runTimeOnlyRoute({
                repo,
                sessionId,
                now,
                extras,
                window,
                limit: args?.limit,
                includeExcluded,
                dshHome,
              })
            : null;

          if (!wantNote) return timeText;

          // scope=note/all 且 query 为空 → 列笔记（旧的「列出最近记下的笔记」行为）
          const notes = selectNotes({ extras, sessionId, window, query: '', limit });
          if (!wantMsg) return renderNotesOnly(notes, { stats, window, limit, extras, sessionId });
          if (notes.length === 0) return timeText;
          return `${timeText}\n\n${renderNotesOnly(notes, { stats, window, limit, extras, sessionId })}`;
        }

        /* -------------------- ③ 有 query：关键词 + 语义 -------------------- */
        if (wantMsg && typeof extras?.search?.keyword !== 'function') {
          return [
            '检索能力不可用：这个库没提供 extras.search.keyword。',
            '（不是「没聊过」，是仓储层缺少关键词检索接口。）',
          ].join('\n');
        }

        const allowed = candidateSceneIds(repo, sessionId, bounds);

        // —— rerank 预判（复用已加载的精排配置） ——
        //
        // cross-encoder 在紧凑候选池上更稳定，避免候选池过大导致近似干扰项混入；
        // 这里顺便复用已判出的配置，避免后面二次 resolve 重读一次全局配置。
        let earlyRerankCfg = null;
        if (wantMsg) {
          try {
            earlyRerankCfg = await resolveReranker({ ...deps, ...ctx });
          } catch {
            earlyRerankCfg = null;
          }
        }
        // 陪伴优先：除显式关闭或已启用多粒度 exchange/thread 外，开 rerank 统一给 24 候选池
        const perRoute = earlyRerankCfg
          ? Math.max(limit * 3, 24)
          : Math.max(limit * 2, DEFAULT_LIMIT);

        // —— 关键词路（单条精确匹配） ——
        //
        // 跨句多词窗口关键词路已移除：它召回的是「多个查询词分散在不同短消息里」的窗口，
        // 而这类窗口的语义**已经被 `vec_window` 覆盖** —— 保留它只会稀释精确命中的名次。
        let rows = [];
        let msgTotal = 0;
        if (wantMsg) {
          const searchOptions = { sessionId, includeExcluded };
          if (bounds) {
            searchOptions.from = bounds.from;
            searchOptions.to = bounds.to;
          }
          rows = extras.search.keyword(query, { ...searchOptions, limit: perRoute }) ?? [];
          rows = restrictToCandidates(rows, allowed);
          // 关键词总数：`keyword()` 已按 perRoute 截断——
          // 无时间约束且返回没截满时，总数必然就是已返回的条数，
          // 不必再跑一次全表 COUNT（实测省约 330ms/次）。
          // 有时间约束时经过了场景二次过滤，不能这样推，仍走 COUNT。
          if (!bounds && rows.length < perRoute) {
            msgTotal = rows.length;
          } else {
            const countKeyword = extras?.search?.countKeyword;
            msgTotal =
              typeof countKeyword === 'function'
                ? Math.max(0, Math.trunc(Number(countKeyword(query, searchOptions)) || 0))
                : rows.length;
          }
        }

        // —— 语义路 + 融合（D-147 懒执行：关键词够了就不调 embedding） ——
        // M2：先判索引能不能跑（空 / 覆盖不足都不 embed），再决定要不要进 RRF。
        let vectorIndex = null;
        if (wantMsg && semantic.ok) {
          vectorIndex = assessVectorIndex({
            semantic,
            extras,
            minCoverage: resolveMinIndexCoverage(deps),
            sessionId,
          });
        }
        let hits = rows;
        let semanticMeta = null;
        if (wantMsg && semantic.ok && vectorIndex?.usable !== false) {
          // 向量路只能跑一次（要花钱），先取回命中再建区间索引：
          // 这样 RRF 融合时「重叠区间」在各路内部只按最好名次计一次，跨路则组内求和。
          // 事后再去重的两种做法都实测更差（394 题）：累加分会把精确短句挤下 #1（24 题劣化），
          // 只保序则窗口抢不过拿了两路的单句（跨句多词 R@1 少 8 个点）。
          let vectorHits = [];
          let chunkRoute = [];
          let exchangeRoute = [];
          let threadRoute = [];
          let vectorError = null;
          try {
            const vr = await runVectorRoute({
              provider: semantic.provider,
              store: semantic.store,
              extras,
              repo,
              query,
              sessionId,
              bounds,
              includeExcluded,
              perRoute,
              disableWindowVector,
              vectorMinScore: Number.isFinite(deps.vectorMinScore) ? deps.vectorMinScore : VECTOR_MIN_SCORE,
              windowQuota,
              chunkAsSeparateRoute: deps.chunkAsSeparateRoute === true || ctx.chunkAsSeparateRoute === true,
            });
            vectorHits = vr.hits ?? [];
            chunkRoute = vr.chunkRoute ?? [];
            exchangeRoute = vr.exchangeRoute ?? [];
            threadRoute = vr.threadRoute ?? [];
          } catch (error) {
            vectorError = error;
          }

          // **F2**：分片独立成路时，span 索引要覆盖三路；
          // **微话题多粒度共振**：当库内有 exchange / thread 时，它们与 msg / keyword 一起进
          // createSpanIndex + fuseRRF，跨路按所属 Thread 共振计分、同路内不刷屏。
          const f2 = chunkRoute.length > 0;
          const hasMultiGranular = !vectorError && (exchangeRoute.length > 0 || threadRoute.length > 0);
          // 多粒度归并关键：为命中的场景加载其全部 parent thread 窗口，确保同一微话题内的
          // msg / keyword / exchange 全部归入同一个 Thread spanKey，不互相刷屏。
          let parentThreads = [];
          if (hasMultiGranular && typeof extras?.window?.byScene === 'function') {
            const touchedScenes = new Set();
            for (const list of [rows, vectorHits, exchangeRoute, threadRoute]) {
              for (const item of list) {
                if (item?.sceneId !== null && item?.sceneId !== undefined) touchedScenes.add(Number(item.sceneId));
              }
            }
            const seenTh = new Set(threadRoute.map((t) => Number(t.window?.id)));
            for (const scId of touchedScenes) {
              try {
                for (const w of extras.window.byScene(scId) ?? []) {
                  if (w.kind !== 'thread' || seenTh.has(Number(w.id))) continue;
                  seenTh.add(Number(w.id));
                  parentThreads.push({
                    id: Number(w.startMsgId),
                    sceneId: Number(w.sceneId),
                    window: {
                      id: Number(w.id),
                      kind: 'thread',
                      startMsgId: Number(w.startMsgId),
                      endMsgId: Number(w.endMsgId),
                      msgCount: Number(w.msgCount),
                      text: String(w.text ?? ''),
                    },
                  });
                }
              } catch { /* ignore */ }
            }
          }
          const spanLists = [rows, vectorHits];
          if (f2) spanLists.push(chunkRoute);
          if (exchangeRoute.length > 0) spanLists.push(exchangeRoute);
          if (threadRoute.length > 0) spanLists.push(threadRoute);
          if (parentThreads.length > 0) spanLists.push(parentThreads);
          const spanIndex = createSpanIndex(spanLists);

          let fused;
          const poolLimit = perRoute;
          const fetchPoolLimit = earlyRerankCfg && hasMultiGranular ? Math.max(poolLimit, 96) : poolLimit;
          if (f2 || hasMultiGranular) {
            if (vectorError) throw vectorError;
            // exchange / thread 用独立路名参与 RRF，融合后映射回 'vector' 来源标签以保持渲染契约
            const rawFused = fuseRRF(
              [
                { name: 'keyword', hits: rows },
                { name: 'vector', hits: vectorHits },
                ...(f2 ? [{ name: 'chunk', hits: chunkRoute }] : []),
                ...(exchangeRoute.length > 0 ? [{ name: 'exchange', hits: exchangeRoute }] : []),
                ...(threadRoute.length > 0 ? [{ name: 'thread', hits: threadRoute }] : []),
              ],
              {
                limit: fetchPoolLimit,
                keyOf: spanIndex.keyOf,
                ...(Number.isFinite(deps.rrfK) ? { k: deps.rrfK } : {}),
                ...(deps.rrfWeights ? { weights: deps.rrfWeights } : {}),
              },
            );
            // 同 spanKey 组内若有 thread/exchange 窗口，把最宽的完整对话线 window 补挂到融合主项上
            //（否则 fuseRRF 优先保留先出现的 keyword/msg 单句而丢掉 window 区间）。
            const bestWindowBySpan = new Map();
            for (const srcList of [parentThreads, threadRoute, exchangeRoute]) {
              for (const item of srcList) {
                if (!item?.window) continue;
                const k = spanIndex.keyOf(item);
                const prev = bestWindowBySpan.get(k);
                if (!prev || (prev.kind !== 'thread' && item.window.kind === 'thread')) {
                  bestWindowBySpan.set(k, item.window);
                }
              }
            }
            // 同 spanKey 组内保留最精准的 Exchange 文本作为 Rerank 打分载体（避免被整条长 Thread 稀释）
            const bestDocBySpan = new Map();
            const bestExchangeBySpan = new Map();
            for (const item of exchangeRoute) {
              if (!item?.window?.text) continue;
              const k = spanIndex.keyOf(item);
              if (!bestDocBySpan.has(k)) {
                bestDocBySpan.set(k, String(item.window.text));
                bestExchangeBySpan.set(k, {
                  startMsgId: Number(item.window.startMsgId),
                  endMsgId: Number(item.window.endMsgId),
                });
              }
            }
            const fusedHits = rawFused.map((h) => {
              const k = h.fusionKey ?? spanIndex.keyOf(h);
              const bestWin = bestWindowBySpan.get(k);
              const win = bestWin && (!h.window || (h.window.kind !== 'thread' && bestWin.kind === 'thread'))
                ? bestWin
                : h.window;
              const focusEx = bestDocBySpan.get(k);
              const focusExRange = bestExchangeBySpan.get(k) ?? null;
              const rerankDoc = focusEx && win?.kind === 'thread' && focusEx !== win.text
                ? `[核心问答]\n${focusEx.slice(0, 700)}\n[微话题上下文]\n${String(win.text ?? '').slice(0, 450)}`
                : (focusEx ?? undefined);
              return {
                ...h,
                ...(win ? { window: win } : {}),
                ...(focusExRange && win?.kind === 'thread' ? { focusExchange: focusExRange } : {}),
                ...(rerankDoc ? { rerankDoc } : {}),
                sources: [...new Set((h.sources ?? []).map((s) => (s === 'exchange' || s === 'thread' ? 'vector' : s)))],
              };
            });
            fused = {
              hits: fusedHits,
              meta: {
                counts: {
                  time: 0,
                  keyword: rows.length,
                  vector: vectorHits.length + exchangeRoute.length + threadRoute.length,
                  chunk: chunkRoute.length,
                },
                usedRoutes: [
                  ...(rows.length > 0 ? ['keyword'] : []),
                  ...((vectorHits.length + exchangeRoute.length + threadRoute.length) > 0 ? ['vector'] : []),
                  ...(chunkRoute.length > 0 ? ['chunk'] : []),
                ],
                vectorSkipped: false,
                vectorSkipReason: null,
                vectorError: null,
                degraded: false,
                errors: [],
                notes: [],
                f2,
                multiGranular: hasMultiGranular,
              },
            };
          } else {
            fused = await searchWithRRF(
              {
                keyword: rows,
                vector: () => {
                  if (vectorError) throw vectorError;
                  return vectorHits;
                },
              },
              {
                limit: poolLimit,
                keyOf: spanIndex.keyOf,
                // 融合参数可由调用方覆盖（默认使用标准 RRF 参数）
                ...(Number.isFinite(deps.rrfK) ? { k: deps.rrfK } : {}),
                ...(deps.rrfWeights ? { weights: deps.rrfWeights } : {}),
              },
            );
          }
          hits = dedupeBySpan(restrictToCandidates(fused.hits, allowed), { limit: fetchPoolLimit });
          // 单路头部保底：仅在多粒度（exchange+thread 关联路可能把单句向量/关键词 Top-3 挤出 poolLimit）时启用
          if (hasMultiGranular && hits.length > poolLimit) {
            const keyOfHit = (h) => h.fusionKey ?? spanIndex.keyOf(h);
            const protectedKeys = new Set();
            for (const item of vectorHits.slice(0, 3)) protectedKeys.add(keyOfHit(item));
            for (const item of rows.slice(0, 3)) protectedKeys.add(keyOfHit(item));
            const top = hits.slice(0, poolLimit);
            const inTop = new Set(top.map((h) => keyOfHit(h)));
            const rescued = [];
            for (const h of hits.slice(poolLimit)) {
              const k = keyOfHit(h);
              if (protectedKeys.has(k) && !inTop.has(k)) {
                inTop.add(k);
                rescued.push(h);
              }
            }
            let rIdx = 0;
            for (let i = top.length - 1; i >= Math.max(limit, 8) && rIdx < rescued.length; i -= 1) {
              if (!protectedKeys.has(keyOfHit(top[i]))) {
                top[i] = rescued[rIdx++];
              }
            }
            hits = top;
          }
          semanticMeta = { ...fused.meta, spanGroups: spanIndex.groupCount };
        }

        if (wantMsg && hits.length > 1) {
          // 复用前面为决定 perRoute 已判出的 rerank 配置，不二次 resolve
          //（二次 resolve 会重读一次全局配置，多一次文件 IO）。
          const rerankCfg = earlyRerankCfg;
          if (rerankCfg) {
            const rr = await applyRerank(rerankCfg, query, hits, repo);
            hits = rr.hits;
            if (rr.reranked || rr.rerankError) {
              semanticMeta = {
                ...(semanticMeta ?? {}),
                reranked: rr.reranked,
                rerankModel: rr.rerankModel,
                rerankError: rr.rerankError,
              };
            }
          }
        }

        // 跨日高相似 Thread 时间线折叠（陪伴场景下把跨日重复的同类微话题合并为主条 + 关联日期提示）
        if ((compactTime || semanticMeta?.multiGranular) && hits.length > 1 && semantic.ok && typeof semantic.store?.getWindowVecs === 'function') {
          const winIds = hits.map((h) => Number(h.window?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
          if (winIds.length > 1) {
            const vecMap = semantic.store.getWindowVecs(winIds);
            hits = foldTimelineClusters(hits, (h) => vecMap.get(Number(h.window?.id)) ?? null, {
              threshold: 0.92,
              limit: Math.max(limit, hits.length),
            });
          }
        }

        // 诊断/测试钩子：把融合结果交出去（生产不传，零影响）
        const onResult = ctx.onResult ?? deps.onResult;
        const hydrateEnclosingThreads = (items) => {
          if (typeof extras?.window?.byScene !== 'function' || !Array.isArray(items) || items.length === 0) return;
          const cache = new Map();
          for (const item of items) {
            if (!item || item.window?.kind === 'thread' || item.sceneId == null) continue;
            const scId = Number(item.sceneId);
            if (!cache.has(scId)) {
              try { cache.set(scId, extras.window.byScene(scId) ?? []); }
              catch { cache.set(scId, []); }
            }
            const mid = Number(item.id);
            const th = cache.get(scId).find(
              (w) => w.kind === 'thread' && mid >= Number(w.startMsgId) && mid <= Number(w.endMsgId),
            );
            if (th) {
              if (item.window?.kind === 'exchange' && !item.focusExchange) {
                item.focusExchange = {
                  startMsgId: Number(item.window.startMsgId),
                  endMsgId: Number(item.window.endMsgId),
                };
              }
              item.window = th;
            }
          }
        };

        if (typeof onResult === 'function') {
          try {
            /**
             * **`hits` 是候选池，`shownHits` 才是 Agent 真正看到的**
             *
             * 两套口径需显式分开：
             *   · `hits`：RRF 融合后的候选池
             *   · `shownHits`：去重并截断到 `limit` 后最终展示给 Agent 的条数
             */
            const seenIds = new Set();
            const deduped = [];
            for (const row of hits) {
              const id = Number(row.id);
              if (seenIds.has(id)) continue;
              seenIds.add(id);
              deduped.push(row);
            }
            const shownForResult = deduped.slice(0, limit).map((r) => ({ ...r }));
            if (wantMsg) hydrateEnclosingThreads(shownForResult);
            onResult({
              hits,
              shownHits: shownForResult,
              meta: semanticMeta,
              semantic,
              keywordRows: rows,
              vectorIndex,
              // 形态判别的结果必须**可观测**：这个值曾经因为引用未声明变量而永远等于 1.0，
              // 且因为整段被 catch 吞掉，外部完全看不出来。暴露出来才能被测试钉住。
              windowQuota,
            });
          } catch {
            // 钩子自己的异常不能影响检索
          }
        }

        // —— 笔记路（显式 note/all 完整检索，或默认模式下高分置顶补充，均支持关键词 + vec_note 语义） ——
        let noteHits = [];
        let pinnedNotes = [];
        if (wantNote || wantPinnedNotes) {
          const hasAnyNotes = typeof extras?.note?.count === 'function'
            ? extras.note.count({ sessionId }) > 0
            : true;
          if (hasAnyNotes) {
            const ranked = await searchRankedNotes({
              extras,
              sessionId,
              query,
              from: bounds?.from ?? null,
              to: bounds?.to ?? null,
              provider: semantic.ok ? semantic.provider : null,
              store: semantic.ok ? semantic.store : null,
              minScore: NOTE_MIN_SCORE_DEFAULT,
              limit: wantNote ? NOTE_PROBE : PINNED_NOTE_MAX_DEFAULT,
            });
            if (wantNote) noteHits = ranked.hits;
            else pinnedNotes = ranked.hits.slice(0, PINNED_NOTE_MAX_DEFAULT);
          }
        }

        /* -------------------- ④ 一条都没有 -------------------- */
        if (hits.length === 0 && noteHits.length === 0 && pinnedNotes.length === 0) {
          return emptySearchText({
            queryLabel,
            query,
            stats,
            bounds,
            window,
            hasQuery,
            wantNote: wantNote || wantPinnedNotes,
            semanticNoteText: wantMsg ? semanticNote(semantic, semanticMeta, vectorIndex) : null,
          });
        }

        /* -------------------- ④.5 低置信提示 -------------------- */
        // **不做硬拒答**，只把「这次召回可能不靠谱」作为一行提示附在结果前面。
        //
        // 为什么不用硬拒答：
        //   任何基于相似度/词重叠的硬闸门都会误伤大量正例。
        //   用户明明说过，系统却说「没找到」—— 这比多给几条更糟。
        //   检索结果是给 Agent 的，它读得到原文、知道上下文，比统计信号更有资格判断。
        //   系统只负责**如实标注不确定性**，把判断权留给 Agent。
        //
        // 判据只用**已有的余弦分**（不额外调模型）：最高分低于地板，或与竞争者拉不开差距。
        const weakHint = wantMsg && hasQuery && hits.length > 0
          ? weakEvidenceHint(hits, rows.length, earlyRerankCfg?.model)
          : null;

        // —— 原话：去重（同一 id 只留一次）、取前 limit 条，展示按时间升序 ——
        const seen = new Set();
        const unique = [];
        for (const row of hits) {
          const id = Number(row.id);
          if (seen.has(id)) continue;
          seen.add(id);
          unique.push({ ...row, _rank: unique.length + 1 });
        }
        let effectiveLimit = limit;
        if (wantMsg && hasQuery && expand === 'auto' && unique.length > 4 && semanticMeta?.reranked) {
          const rr0 = unique[0]?.rerankScore;
          const rr1 = unique[1]?.rerankScore;
          if (typeof rr0 === 'number' && rr0 >= 0.78 && (typeof rr1 !== 'number' || rr0 - rr1 >= 0.25)) {
            effectiveLimit = Math.min(limit, 4);
          }
        }
        const shown = unique.slice(0, effectiveLimit).sort((a, b) => a.at - b.at);
        if (wantMsg) hydrateEnclosingThreads(shown);
        const msgHitTotal = Math.max(msgTotal, unique.length);
        const msgTotalText = `${fmtCount(msgHitTotal)} 处`;

        const activeNotes = wantNote ? noteHits : pinnedNotes;
        const noteTotal = activeNotes.length;
        const noteTouchedCap = wantNote && noteTotal >= NOTE_PROBE;
        // 显式 scope=note/all 时按最近优先选前 limit 条再按时间升序；置顶补充已按相关度降序选出前 3 条
        const shownNotes = wantNote
          ? [...activeNotes]
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.at - a.at || b.id - a.id)
              .slice(0, limit)
              .sort((a, b) => a.at - b.at || a.id - b.id)
          : [...activeNotes];
        const noteTotalText = noteTouchedCap
          ? `${fmtCount(NOTE_PROBE)} 条以上`
          : `${fmtCount(noteTotal)} 条`;

        const rangeHint = bounds ? `（只在 ${window.label} 里找）` : '';
        // scope=note 且没跑语义时才不提；只要想跑语义且有说明就附上
        const note = wantMsg ? semanticNote(semantic, semanticMeta, vectorIndex) : null;

        /* ---------------- 只有原话（且没有置顶笔记命中）：保持 §7.2 的原始排面 ---------------- */
        if (!wantNote && shownNotes.length === 0) {
          // 只在被截断时才提「M / N」；全显示时不写分母（避免冗余信息）
          const footer = [];
          if (shown.length < msgHitTotal) {
            footer.push(`截断 ${fmtCount(shown.length)}/${fmtCount(msgHitTotal)}｜加 when 缩小范围（如 "2026-11-09..2026-11-12" 或 "7d"），或给更长的原话片段`);
          }
          if (note) footer.push(note);
          const lines = [`「${queryLabel}」— ${msgTotalText}`];
          // 时间范围单独一行：标题行必须保持 `「q」— N 处` 的原样（验收脚本按行解析）
          if (rangeHint) lines.push(rangeHint);
          // 低置信柔提示：只提示不拦截，把判断权留给 Agent
          if (weakHint) lines.push('', weakHint);
          lines.push('', renderShown(shown, { includeExcluded, expand, repo, compactTime, extras, dshHome }), '');
          lines.push(footer.join('\n'));
          return lines.join('\n');
        }

        /* ---------------- 含笔记（显式 note/all 或默认高权重置顶）：分两段呈现，绝不混在一起（D-084） ---------------- */
        const parts = [];
        // 默认模式下若命中了原话，标题行保留 `「query」— N 处` 契约，置顶笔记紧随其后排在原话前面
        parts.push(!wantNote && shown.length > 0 ? `「${queryLabel}」— ${msgTotalText}` : `「${queryLabel}」`);
        if (rangeHint) parts.push(rangeHint);
        if (weakHint) parts.push('', weakHint);
        if (shownNotes.length > 0) {
          const noteHeading = wantNote
            ? `你自己记的 — ${noteTotalText}`
            : `你自己记的（高权重置顶） — ${noteTotalText}`;
          parts.push('', noteHeading, '');
          parts.push(shownNotes.map(renderNote).join('\n\n'));
        }
        if (shown.length > 0) {
          parts.push('', `你们说过的话 — ${msgTotalText}`, '');
          parts.push(renderShown(shown, { includeExcluded, expand, repo, compactTime, extras, dshHome }));
        }

        if (wantNote) {
          const trashHint = formatTrashHint(extras, sessionId);
          if (trashHint) parts.push('', trashHint);
        }

        const footerParts = [];
        if (wantMsg) footerParts.push(`原话 ${fmtCount(shown.length)}/${fmtCount(msgHitTotal)}`);
        if (wantNote || shownNotes.length > 0) {
          footerParts.push(
            noteTouchedCap
              ? `笔记 ${fmtCount(shownNotes.length)}/${NOTE_PROBE}+`
              : `笔记 ${fmtCount(shownNotes.length)}/${fmtCount(noteTotal)}`,
          );
        }
        parts.push('', footerParts.join('｜'));

        if (query && shown.length > 0 && shown.length < msgHitTotal) {
          parts.push(`截断提示：加 when 缩小范围（如 "2026-11-09..2026-11-12" 或 "7d"），或给更长的原话片段`);
        }
        if (note) parts.push(note);
        return parts.join('\n').replace(/^\n+/, '');
      } catch (error) {
        // D-096：库不可用要给明确错误，不能返回空结果
        return [
          `记忆库现在读不到：${error?.message ?? String(error)}`,
          '（这不是「没聊过」，是库本身打不开或者坏了。）',
        ].join('\n');
      }
    },
  };
}

/* ======================== 笔记 / 空结果（拆分出来免得 handler 太长） ======================== */

/**
 * 选笔记：按会话 + 时间窗 + query 过滤。
 *
 * @param {{extras:object, sessionId:string|null, window:object, query:string, limit:number}} input
 * @returns {object[]}
 */
function selectNotes({ extras, sessionId, window, query, limit }) {
  // A1：note 也要按会话过滤 —— TA在 A 会话里翻不到 B 会话记的笔记。
  const all = extras?.note?.list ? extras.note.list({ limit: Math.max(NOTE_PROBE, limit), sessionId }) : [];
  let pool = all;
  if (window && window.from !== null && window.to !== null) {
    pool = pool.filter((n) => Number(n.at) >= window.from && Number(n.at) < window.to);
  }
  return filterNotes(pool, query);
}

/** note 模式的输出（无 query 或 scope=note 且 query 留空时） */
function renderNotesOnly(notes, { stats, window, limit, extras = null, sessionId = null }) {
  const shown = [...notes]
    .sort((a, b) => b.at - a.at || b.id - a.id)
    .slice(0, limit)
    .sort((a, b) => a.at - b.at || a.id - b.id);
  const rangeHint =
    window && window.from !== null && window.to !== null ? `（${window.label}）` : '';
  const trashHint = formatTrashHint(extras, sessionId);
  if (shown.length === 0) {
    return emptyText({
      head: `没有找到${rangeHint ? ` ${window.label} ` : ''}记下的笔记。`,
      stats,
      tips: [
        '你是没记过，还是记在别处了？可以换个说法，或者不加时间再列一次。',
        '想记一条就用 memory_remember。',
        ...(trashHint ? [trashHint] : []),
      ],
    });
  }
  const out = [
    `你自己记的 — ${fmtCount(notes.length)} 条${rangeHint}`,
    '',
    shown.map(renderNote).join('\n\n'),
    '',
    `已显示 ${fmtCount(shown.length)} / ${fmtCount(notes.length)} 条笔记。`,
  ];
  if (trashHint) out.push('', trashHint);
  return out.join('\n');
}

/** 空结果的统一说法：库范围 + 建议，绝不返回空白（D-096） */
function formatTrashHint(extras, sessionId) {
  if (typeof extras?.note?.list !== 'function') return null;
  try {
    const all = extras.note.list({ limit: 20, includeDeleted: true, sessionId });
    const deleted = Array.isArray(all) ? all.filter((n) => n && n.deletedAt !== null) : [];
    if (deleted.length === 0) return null;
    const preview = deleted.slice(0, 3).map((n) => {
      const txt = String(n.content ?? '').replace(/\s+/g, ' ').trim();
      const short = txt.length > 28 ? `${txt.slice(0, 28)}…` : txt;
      return `#${n.id}「${short}」`;
    }).join('、');
    return `回收站里还有 ${fmtCount(deleted.length)} 条已删笔记（可用 memory_forget(id, restore: true) 恢复）：${preview}`;
  } catch {
    return null;
  }
}

function emptySearchText({
  queryLabel,
  query,
  stats,
  bounds,
  window,
  hasQuery,
  wantNote,
  semanticNoteText,
}) {
  const tips = [];
  if (bounds) {
    tips.push(`刚才只在 ${window.label} 里找，去掉 when 可以找全库。`);
  }
  if (wantNote) {
    const notes = Number(stats?.notes ?? 0);
    tips.push(
      notes > 0
        ? `你自己记的笔记一共 ${fmtCount(notes)} 条，换个说法或者干脆 scope 填 note、query 留空，我把最近的列出来。`
        : '你还没记过笔记（memory_remember 之后就能在这里翻到）。',
    );
  }
  if (hasQuery) {
    if (Array.from(query).length > 0 && Array.from(query).length <= 2) {
      tips.push('两个字不好命中就多给几个字：比如原话里的「怕黑」「不想开灯」一起给。');
    }
    tips.push('也可以只填 when（如 "2026-11-09"、"2026-11" 或 "7d"），不填 query，直接按时间翻那一阵的对话。');
  }
  const head = hasQuery
    ? `没有找到跟「${queryLabel}」有关的记录${bounds ? `（只在 ${window.label} 里找的）` : ''}。`
    : '还没有记下任何东西。';
  if (semanticNoteText) tips.push(semanticNoteText);
  return emptyText({ head, stats, tips });
}

/** 默认实例：用默认库单例，import 时不碰磁盘 */
export const memorySearchTool = createSearchTool();

export default memorySearchTool;

/** 供 T8 / 面板复用的常量 */
export {
  DEFAULT_LIMIT as SEARCH_DEFAULT_LIMIT,
  NOTE_PROBE as SEARCH_NOTE_PROBE,
  QUERY_LABEL_MAX as SEARCH_QUERY_LABEL_MAX,
  DEFAULT_MIN_INDEX_COVERAGE as SEARCH_MIN_INDEX_COVERAGE,
};
