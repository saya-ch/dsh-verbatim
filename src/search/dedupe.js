/**
 * 区间去重与跨路证据聚合（Span-based Deduplication & Evidence Aggregation）
 *
 * 解决多粒度检索（msg / chunk / window / scene）与双路检索（keyword + vector）中的重复占位问题：
 *   1. 点落入窗口：单条 msg #103 与覆盖 [#101..#105] 的对话窗是同一件事，合并而非占两个名额；
 *   2. 窗口高度重叠：50% 重叠的相邻对话窗 [#101..#105] 与 [#103..#106] 只保留更高分者；
 *   3. 跨路共振保留：关键词命中 #103、向量窗口命中 [#101..#105] 时，合并 sources 为 kw+vec 并累加 RRF 分；
 *   4. 同场不同段不误杀：同一长场景内不相交的两个片段（如 #101..#105 与 #140..#145）各自保留。
 */

/** 两个窗口重叠比例达到该阈值即视为重复窗口 */
export const WINDOW_OVERLAP_RATIO = 0.4;

/** 同一区间每多一条独立证据时的微幅提权（仅 aggregate:true 时用于排序，默认关闭） */
const EVIDENCE_BOOST_STEP = 0.015;
const EVIDENCE_BOOST_CAP = 0.045;

/** 提取一条命中在所属场景内的消息 ID 区间 [start, end] */
export function spanOfHit(hit) {
  const win = hit?.window;
  if (win && Number.isFinite(win.startMsgId) && Number.isFinite(win.endMsgId)) {
    const a = Number(win.startMsgId);
    const b = Number(win.endMsgId);
    return {
      sceneId: hit.sceneId === null || hit.sceneId === undefined ? null : Number(hit.sceneId),
      start: Math.min(a, b),
      end: Math.max(a, b),
      isWindow: true,
      msgCount: Math.max(1, Number(win.msgCount) || (Math.abs(b - a) + 1)),
    };
  }
  const id = Number(hit?.id);
  return {
    sceneId: hit?.sceneId === null || hit?.sceneId === undefined ? null : Number(hit.sceneId),
    start: id,
    end: id,
    isWindow: false,
    msgCount: 1,
  };
}

/** 判断两个命中是否属于同一重叠区间 */
export function spansOverlap(a, b) {
  // 同一条消息 id 必然重复
  if (a.start === b.start && a.end === b.end) return true;
  // 必须同一场景（无场景归属时只按 id 判重）
  if (a.sceneId === null || b.sceneId === null || a.sceneId !== b.sceneId) return false;
  // 区间无交集
  if (a.end < b.start || b.end < a.start) return false;

  // 点 vs 窗：点只要落在窗口 [start, end] 内即视为被覆盖
  if (!a.isWindow || !b.isWindow) return true;

  // 窗 vs 窗：按 ID 跨度估算重叠比例（同场内 msg.id 单调递增，近似等于消息数重叠）
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1;
  const spanA = Math.max(1, a.end - a.start + 1);
  const spanB = Math.max(1, b.end - b.start + 1);
  const minSpan = Math.min(spanA, spanB);
  return inter >= 2 || inter / minSpan >= WINDOW_OVERLAP_RATIO;
}

/**
 * 把多条命中列表按「重叠区间」预先并成若干组，返回可直接交给 RRF 融合的 keyOf。
 *
 * 为什么需要在**融合之前**分组（394 题实测的结论）：
 *   - 事后去重 + 抬分：会让吞了多条弱命中的簇反超精确单句 —— T3 短句精准检索 R@1 从 65.3% 掉到 52.7%（24 题劣化）。
 *   - 事后去重 + 保序：单句不动了，但"窗口只拿到一路、里面的单句拿到两路"时，窗口的 RRF 分打不过那条单句 ——
 *     跨句多词 R@1 只有 59.4%（比抬分版低 8 个点）。
 *   - 先分组再融合：同一区间在**同一路里只按最好名次计一次**（不重复累加、不抬分），
 *     **跨路则是组内各取最好名次求和** —— 窗口继承组内关键词路的名次，单句继承组内向量路的名次，
 *     既不会让簇靠数量刷分压过精确命中，也不会让真正的联合证据被拆散。
 *
 * @param {object[][]} hitLists 各路命中（顺序即该路名次）
 * @returns {{keyOf: (hit: object) => any, groupCount: number, groupSizes: number[]}}
 */
export function createSpanIndex(hitLists = []) {
  const items = [];
  for (const list of hitLists) {
    if (!Array.isArray(list)) continue;
    for (const hit of list) {
      if (!hit || !Number.isFinite(Number(hit.id))) continue;
      items.push({ hit, span: spanOfHit(hit) });
    }
  }
  if (items.length === 0) return { keyOf: (h) => (h?.id ?? h?.msgId), groupCount: 0, groupSizes: [] };

  const parent = items.map((_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (spansOverlap(items[i].span, items[j].span)) union(i, j);
    }
  }

  const groupOfHit = new Map();
  for (let i = 0; i < items.length; i += 1) groupOfHit.set(items[i].hit, `span:${find(i)}`);

  const sizes = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const key = `span:${find(i)}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }

  return {
    keyOf: (hit) => groupOfHit.get(hit) ?? (hit?.id ?? hit?.msgId),
    groupCount: sizes.size,
    groupSizes: [...sizes.values()],
  };
}

/**
 * 按区间去重并融合来源/分数/窗口上下文。
 *
 * `aggregate` 默认 **false**：落入同一区间的后续命中只贡献来源标签、对话窗上下文与 matchedMsgIds，
 * **绝不改动主项的排序**（394 题实测：抬分会让精确短句从 #1 掉到 #2，24 题劣化）。
 * 需要跨路合并时优先用 `createSpanIndex` + RRF 的 `keyOf`（组内每路取最好名次）。
 *
 * @param {object[]} hits 已按优先级/分数降序排好的候选列表
 * @param {{
 *   mode?: 'score' | 'rrf' | 'keyword',
 *   limit?: number,
 *   aggregate?: boolean,
 * }} [opts]
 * @returns {object[]}
 */
export function dedupeBySpan(hits, opts = {}) {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const mode = opts.mode ?? 'score';
  const aggregate = opts.aggregate === true;
  const kept = [];

  for (const item of hits) {
    if (!item || !Number.isFinite(Number(item.id))) continue;
    const sp = spanOfHit(item);

    let matchEntry = null;
    for (const entry of kept) {
      if (spansOverlap(entry.span, sp)) {
        matchEntry = entry;
        break;
      }
    }

    if (!matchEntry) {
      const copy = {
        ...item,
        sources: Array.isArray(item.sources) ? [...new Set(item.sources)] : undefined,
        matchedMsgIds: [Number(item.id)],
        evidenceCount: 1,
      };
      kept.push({ hit: copy, span: sp });
      continue;
    }

    // 合并到已接纳的高优主项中，绝不新占名额
    const target = matchEntry.hit;
    const itemId = Number(item.id);
    if (!target.matchedMsgIds.includes(itemId)) {
      target.matchedMsgIds.push(itemId);
    }
    target.evidenceCount += 1;

    // ① 来源合并（支持跨路 kw + vec 共振）
    if (Array.isArray(item.sources) && item.sources.length > 0) {
      const mergedSources = new Set([...(target.sources ?? []), ...item.sources]);
      target.sources = [...mergedSources];
    }

    // ② 上下文升级：若主项是单句或窄 Exchange，而新项是覆盖它的完整 Thread 对话窗，把完整 Thread 补挂上来
    if (
      item.window
      && (!target.window || (target.window.kind !== 'thread' && item.window.kind === 'thread'))
    ) {
      target.window = item.window;
      matchEntry.span = sp;
    }
    if (!target.chunk && item.chunk) {
      target.chunk = item.chunk;
    }

    // ③ 分数合并：默认只合并来源/上下文，**不改分、不重排**
    if (!aggregate) {
      // no-op：保持主项原分数与原次序（394 题实测：抬分会让精确短句从 #1 掉到 #2）
    } else if (mode === 'rrf') {
      // 跨路 RRF：不同路的 RRF 分累加（同路不重复加，避免单路刷分）
      const prevRoutes = new Set(Object.keys(target.rr ?? {}));
      const nextRr = item.rr ?? {};
      let addedRrf = 0;
      for (const [route, rank] of Object.entries(nextRr)) {
        if (!prevRoutes.has(route) && Number.isFinite(rank)) {
          addedRrf += 1 / (60 + rank);
          if (!target.rr) target.rr = {};
          target.rr[route] = rank;
        }
      }
      if (addedRrf > 0 && Number.isFinite(target.rrfScore)) {
        target.rrfScore += addedRrf;
      }
      if (typeof item.score === 'number' && (typeof target.score !== 'number' || item.score > target.score)) {
        target.score = item.score;
      }
    } else if (mode === 'score') {
      // 向量路内部：取最高原始余弦，并按独立证据数给微幅聚合提权
      const base = Math.max(
        typeof target.score === 'number' ? target.score : 0,
        typeof item.score === 'number' ? item.score : 0,
      );
      const boost = Math.min(EVIDENCE_BOOST_CAP, (target.evidenceCount - 1) * EVIDENCE_BOOST_STEP);
      target.score = Math.min(1, base + boost);
    }
  }

  let result = kept.map((e) => e.hit);
  if (!aggregate) {
    // 保持输入优先级顺序
  } else if (mode === 'rrf') {
    result.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0) || (b.score ?? 0) - (a.score ?? 0));
  } else if (mode === 'score') {
    result.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  if (Number.isFinite(opts.limit) && opts.limit > 0) {
    result = result.slice(0, opts.limit);
  }
  return result;
}

/**
 * 关键词路排序与去重：
 * 多词查询（>=2 词）时，优先让「同时包含全部查询词」的命中（无论是单句还是跨句对话窗）排在
 * 仅命中部分词的 FTS OR 单句前面，随后按区间去重，避免单句与包含它的对话窗重复占位。
 *
 * @param {object[]} msgRows 单句关键词命中
 * @param {object[]} winRows 对话窗多词 AND 命中（已 hydrate）
 * @param {string[]} terms 切分后的查询词
 * @param {{limit?: number}} [opts]
 * @returns {object[]}
 */
export function mergeKeywordHits(msgRows = [], winRows = [], terms = [], opts = {}) {
  if (winRows.length === 0) return dedupeBySpan(msgRows, { mode: 'keyword', limit: opts.limit });
  if (terms.length < 2) return dedupeBySpan([...msgRows, ...winRows], { mode: 'keyword', limit: opts.limit });

  const lowerTerms = terms.map((t) => String(t).toLowerCase()).filter(Boolean);
  const allMatch = (text) => {
    const s = String(text ?? '').toLowerCase();
    return lowerTerms.every((t) => s.includes(t));
  };

  // ① 单句自身就包含全部词（最精准）
  // ② 对话窗同时包含全部词（跨句共现）
  // ③ 仅命中部分词的 FTS OR 单句
  const msgFull = [];
  const msgPartial = [];
  for (const r of msgRows) {
    if (allMatch(r.text)) msgFull.push(r);
    else msgPartial.push(r);
  }
  return dedupeBySpan([...msgFull, ...winRows, ...msgPartial], { mode: 'keyword', limit: opts.limit });
}

export default dedupeBySpan;
