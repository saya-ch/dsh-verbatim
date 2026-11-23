/**
 * 三路 RRF 融合 —— 时间路 / 关键词路 / 向量路
 *
 * 规格来源：
 *   - BUILD-PLAN.md §4.5：`score = Σ 1/(k + rank)`，k = 60，候选 20 条
 *   - D-039 / D-010：三路各自独立召回，不用「先粗筛再精排」的两段式
 *   - D-147：**懒执行** —— 关键词路命中 ≥ 5 条就不跑向量路，省一次 100~500 ms 的网络调用
 *   - D-153：先不上 rerank（TA看得懂语境，rerank 模型不懂）
 *
 * 为什么用 RRF 而不是加权分数：三路的分数量纲根本不可比（FTS 的 bm25 是负数、
 * 余弦在 [-1,1]、时间路压根没有分）。RRF 只看**排名**，天然绕开归一化问题，
 * 剩下的唯一超参就是 k=60（业界默认）和三路权重。
 *
 * 权重选择（默认等权，都是 1）：
 *   - 等权是 RRF 的原始形式，它的前提就是「各路排序质量未知」。
 *     这里三路质量确实都未知（没有标注集，D-151 的 rerank 也没实测），
 *     拍一个"关键词更重要 1.5"这种数字，纯属用假精度掩盖没数据。
 *   - 真正在做的重分配是**懒执行**：关键词够用就直接不跑向量路，
 *     等价于把向量路的权重降到 0，而且省一次网络调用 —— 这是有依据的（D-147）。
 *   - 实测有真数据后再调，调的地方就是 `DEFAULT_WEIGHTS`。
 *
 * 降级（D-147 提到的另一半）：向量路失败（网络/额度/模型不一致）时，
 * 用时间 + 关键词的结果继续，并在 meta 里写清原因 —— 不能静默地少一路。
 */

/** RRF 平滑常数（BUILD-PLAN §4.5） */
export const RRF_K = 60;

/** 最终返回多少条候选（BUILD-PLAN §4.5：候选 20 条） */
export const DEFAULT_LIMIT = 20;

/**
 * 三路默认权重。等权，理由见文件头。
 * 键名顺序也是「融合时取字段基准」的优先级：同一 key 既在时间路又在关键词路时，
 * 先用时间路的行做基准（它带场景区间，字段最全）。
 */
export const DEFAULT_WEIGHTS = Object.freeze({ time: 1, keyword: 1, vector: 1 });

/** 路由名，同时是默认的展示顺序 */
export const ROUTES = Object.freeze(['time', 'keyword', 'vector']);

/** 把三路的入参统一成 [{ name, hits, weight }] */
function normalizeLists(lists, weights) {
  const out = [];
  if (Array.isArray(lists)) {
    for (const item of lists) {
      if (!item) continue;
      out.push({
        name: String(item.name ?? item.route ?? 'unknown'),
        hits: Array.isArray(item.hits) ? item.hits : [],
        weight: Number.isFinite(item.weight) ? item.weight : (weights?.[item.name] ?? 1),
      });
    }
    return out;
  }
  for (const name of Object.keys(lists ?? {})) {
    if (!ROUTES.includes(name)) continue; // 只认三路，别让拼错的 key 静默失效
    const hits = lists[name];
    if (!Array.isArray(hits)) continue;
    out.push({ name, hits, weight: Number.isFinite(weights?.[name]) ? weights[name] : 1 });
  }
  return out;
}

/** 默认的 key 提取：三路必须以同一粒度返回（建议都是 msg.id） */
function defaultKeyOf(hit) {
  return hit?.id ?? hit?.msgId ?? hit?.sceneId;
}

/**
 * 纯函数融合：给三路的命中列表，算出 RRF 分并排序。
 *
 * 不做任何 IO、不调用任何路由 —— 懒执行在 searchWithRRF 里做。
 *
 * @param {{time?: object[], keyword?: object[], vector?: object[]} | {name: string, hits: object[], weight?: number}[]} lists
 * @param {{k?: number, limit?: number, weights?: object, keyOf?: (hit: object) => any,
 *          mutateHits?: boolean}} [opts]
 * @returns {object[]} 融合后的命中，带 rrfScore / routes / bestRank / sources
 */
export function fuseRRF(lists, opts = {}) {
  const k = Number.isFinite(opts.k) ? opts.k : RRF_K;
  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIMIT;
  const keyOf = typeof opts.keyOf === 'function' ? opts.keyOf : defaultKeyOf;
  const groups = normalizeLists(lists, opts.weights);

  /** @type {Map<any, {key: any, hit: object, score: number, ranks: object, sources: string[], bestRank: number}>} */
  const merged = new Map();

  for (const group of groups) {
    if (group.weight === 0) continue;
    const seen = new Set(); // 同一路里重复出现只认最好的名次
    let rank = 0;
    for (const hit of group.hits) {
      if (!hit) continue;
      const key = keyOf(hit);
      if (key === undefined || key === null) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      rank += 1;

      const contribution = group.weight / (k + rank);
      let entry = merged.get(key);
      if (!entry) {
        entry = { key, hit, score: 0, ranks: {}, sources: [], bestRank: Infinity };
        merged.set(key, entry);
      }
      entry.score += contribution;
      entry.ranks[group.name] = rank;
      entry.sources.push(group.name);
      if (rank < entry.bestRank) entry.bestRank = rank;
    }
  }

  // 排序：融合分降序 → 最好名次升序 → 时间新的在前 → key 升序（保证确定性）
  const atOf = (e) => (Number.isFinite(e.hit.at) ? e.hit.at : Number.isFinite(e.hit.startAt) ? e.hit.startAt : 0);
  const sorted = [...merged.values()].sort(
    (a, b) => b.score - a.score || a.bestRank - b.bestRank || atOf(b) - atOf(a) || String(a.key).localeCompare(String(b.key)),
  );

  const pick = limit > 0 ? sorted.slice(0, limit) : sorted;
  return pick.map((e) => ({
    ...e.hit,
    fusionKey: e.key,
    rrfScore: e.score,
    rr: e.ranks, // 每路的名次，调试/解释用
    sources: e.sources, // ['time','keyword','vector'] 的子集
    bestRank: e.bestRank,
  }));
}

/* ============================ 带懒执行的融合 ============================ */

/** 统一执行一路：可以是数组，也可以是函数（同步/异步都行） */
async function runRoute(route) {
  if (route === undefined || route === null) return { skipped: true, hits: [] };
  if (Array.isArray(route)) return { hits: route };
  if (typeof route !== 'function') {
    throw new TypeError('路由必须是命中数组或返回命中数组的函数');
  }
  const out = await route();
  return { hits: Array.isArray(out) ? out : [] };
}

/**
 * 三路始终混合融合 + 降级说明。
 *
 * 只要提供了某一路，就会参与执行并通过 RRF 融合；单路失败只降级并记录原因。
 *
 * @param {{time?: object[]|Function, keyword?: object[]|Function, vector?: object[]|Function}} routes
 * @param {{
 *   limit?: number, k?: number, weights?: object,
 *   onDegrade?: (info: {route: string, error?: Error, reason?: string}) => void,
 *   keyOf?: Function,
 * }} [opts]
 * @returns {Promise<{hits: object[], meta: object}>}
 */
export async function searchWithRRF(routes = {}, opts = {}) {
  const hits = { time: [], keyword: [], vector: [] };
  const attempted = [];
  const errors = [];
  const notes = [];

  /** 跑一路并把结果/异常收好 */
  async function attempt(name, route) {
    if (route === undefined || route === null) return;
    attempted.push(name);
    try {
      const result = await runRoute(route);
      hits[name] = result.hits ?? [];
    } catch (error) {
      hits[name] = [];
      errors.push({ route: name, error });
      notes.push(`${routeLabel(name)}失败：${error?.message ?? error}`);
      opts.onDegrade?.({ route: name, error });
    }
  }

  // ① 关键词路
  await attempt('keyword', routes.keyword);

  // ② 时间路：便宜，永远跑
  await attempt('time', routes.time);

  // ③ 向量路：只要提供就始终参与混合检索
  let vectorSkipped = false;
  let skipReason = null;
  if (routes.vector === undefined || routes.vector === null) {
    vectorSkipped = true;
    skipReason = '未提供向量路';
  } else {
    await attempt('vector', routes.vector);
  }

  // 尝试过的每一路都抛错才是「全部失败」；只要还有至少一路正常跑完（哪怕 0 命中），
  // 失败的那一路就走降级说明，绝不能把「关键词 0 命中 + 向量路出错」误报成「记忆库打不开」。
  if (attempted.length > 0 && errors.length >= attempted.length) {
    const first = errors[0];
    const error = new Error(`三路检索全部失败：${first.error?.message ?? first.error}`);
    error.errors = errors;
    throw error;
  }

  const fused = fuseRRF(
    ROUTES.map((name) => ({ name, hits: hits[name], weight: opts.weights?.[name] })),
    { k: opts.k, limit: opts.limit, keyOf: opts.keyOf },
  );

  return {
    hits: fused,
    meta: {
      /** 每路原始命中条数（融合前） */
      counts: { time: hits.time.length, keyword: hits.keyword.length, vector: hits.vector.length },
      usedRoutes: ROUTES.filter((n) => hits[n].length > 0),
      vectorSkipped,
      vectorSkipReason: skipReason,
      vectorError: errors.find((e) => e.route === 'vector')?.error?.message ?? null,
      degraded: errors.length > 0,
      errors: errors.map((e) => ({ route: e.route, message: e.error?.message ?? String(e.error) })),
      notes,
    },
  };
}

function routeLabel(name) {
  return name === 'time' ? '时间路' : name === 'keyword' ? '关键词路' : name === 'vector' ? '向量路' : name;
}

/* ============================ 现成的检索器 ============================ */

/**
 * 把「repo + extras + vector-store + provider」接成一个可直接调用的检索器。
 *
 * 三路的数据来源：
 *   keyword → extras.search.keyword（FTS trigram / LIKE 双路，T1 已实现）
 *   time    → repo.scenesByTimeRange + repo.msgsByScene（相交语义，和场景路一致）
 *   vector  → provider.embed(查询) + store.knnMsg（外层过滤，D-150）
 *
 * 每次走向量路之前做 `vecMeta.assert(provider)`（D-152）：
 * 库里的向量是别的模型算的就直接报，不拿两套不可比的向量硬算。
 *
 * @param {{
 *   repo: object, extras: object, store: object, provider: object,
 *   logger?: {warn(msg: string): void},
 * }} opts
 */
export function createSearcher(opts = {}) {
  const { repo, extras, store, provider } = opts;
  if (!repo) throw new TypeError('createSearcher: 需要 repo');
  if (!extras?.search?.keyword) throw new TypeError('createSearcher: 需要 extras.search.keyword');
  if (!store?.knnMsg) throw new TypeError('createSearcher: 需要 vector-store');
  if (typeof provider?.embed !== 'function') throw new TypeError('createSearcher: 需要 embedding provider');

  /**
   * 检索消息（三路融合）。
   *
   * @param {{
   *   query: string,                       // 用户原话
   *   sessionId?: string|null,
   *   from?: number, to?: number,          // 时间窗（毫秒，左闭右开）
   *   limit?: number,                      // 最终返回条数，默认 20
   *   perRoute?: number,                   // 每路召回多少条，默认 limit*2
   *   includeExcluded?: boolean,
   *   time?: object[] | Function,          // 想自己给时间路就传（T4 覆盖用）
   *   timeSceneLimit?: number,             // 时间路展开几场，默认 3
   *   timeMsgLimit?: number,               // 时间路总共展开几条消息，默认 12
   *   signal?: AbortSignal,
   *   onDegrade?: Function,
   *   onDecision?: Function,
   * }} args
   * @returns {Promise<{hits: object[], meta: object}>}
   */
  async function searchMsgs(args = {}) {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return {
        hits: [],
        meta: {
          counts: { time: 0, keyword: 0, vector: 0 },
          usedRoutes: [],
          vectorSkipped: true,
          vectorSkipReason: '查询为空',
          vectorError: null,
          degraded: false,
          errors: [],
          notes: [],
          emptyQuery: true,
        },
      };
    }

    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : DEFAULT_LIMIT;
    const perRoute = Number.isFinite(args.perRoute) ? Math.max(1, Math.floor(args.perRoute)) : limit * 2;
    const sessionId = args.sessionId ?? null;
    const from = Number.isFinite(args.from) ? args.from : undefined;
    const to = Number.isFinite(args.to) ? args.to : undefined;
    const includeExcluded = Boolean(args.includeExcluded);

    /** 关键词路 */
    const keyword = () =>
      extras.search.keyword(query, { sessionId, from, to, limit: perRoute, includeExcluded });

    /** 向量路：先校验模型，再 embed 查询，再 KNN（时间过滤在 store 外层做） */
    const vector = async () => {
      extras.vecMeta.assert(provider); // D-152：模型不一致在这里抛，走降级说明
      const [vec] = await provider.embed([query], args.signal);
      if (!vec) return [];
      return store.knnMsg(vec, perRoute, { sessionId, from, to, includeExcluded, limit: perRoute });
    };

    /** 时间路：给一段时间窗，把落在里面的场景展开成消息 */
    // 注意展开顺序：归一化过的 sessionId/from/to 放在 args 之后，别让 args 里的原值盖掉
    const time = args.time ?? buildTimeRoute(repo, { ...args, sessionId, from, to });

    return searchWithRRF({ time, keyword, vector }, {
      limit,
      onDegrade: args.onDegrade,
    });
  }

  return { searchMsgs, repo, extras, store, provider };
}

/**
 * 时间路：场景 → 消息。
 *
 * 之所以先取场景再展开消息，而不是直接 msgsByTimeRange：TA要找的是「那一场」，
 * 一场里的每条消息都该算一次命中，而且要有场景区间（验收 2：每条结果都带时间区间）。
 *
 * @param {object} repo
 * @param {{sessionId?: string|null, from?: number, to?: number,
 *          timeSceneLimit?: number, timeMsgLimit?: number}} args
 * @returns {Function|null} 没有时间窗就返回 null（= 这次不跑时间路）
 */
export function buildTimeRoute(repo, args = {}) {
  const { from, to } = args;
  if (!Number.isFinite(from) && !Number.isFinite(to)) return null;
  const sceneLimit = Number.isFinite(args.timeSceneLimit) ? Math.max(1, args.timeSceneLimit) : 3;
  const msgLimit = Number.isFinite(args.timeMsgLimit) ? Math.max(1, args.timeMsgLimit) : 12;

  return () => {
    const scenes = repo.scenesByTimeRange(
      args.sessionId ?? null,
      Number.isFinite(from) ? from : 0,
      Number.isFinite(to) ? to : Date.now() + 1,
      sceneLimit,
    );
    const out = [];
    for (const scene of scenes) {
      if (out.length >= msgLimit) break;
      for (const msg of repo.msgsByScene(scene.id)) {
        out.push({
          ...msg,
          sceneStartAt: scene.startAt,
          sceneEndAt: scene.endAt,
          sceneMsgCount: scene.msgCount,
          sceneGist: scene.gist,
        });
        if (out.length >= msgLimit) break;
      }
    }
    return out;
  };
}

export default searchWithRRF;
