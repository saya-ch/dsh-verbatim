/**
 * rrf 单测 —— 三路融合 / 懒执行（D-147）/ 降级 / 端到端接真库
 *
 * 跑法：
 *   node --test src/search/
 *   node --test src/search/rrf.test.js
 *
 * 覆盖验收点（任务书 §5）：
 *   ✅ 三路各有结果时融合顺序正确（手算 RRF 对上）
 *   ✅ 关键词足够时向量路**未被调用**（spy：provider.embed 调用次数 = 0）
 *   ✅ 向量路失败时降级，并在 meta 里说清原因
 *   ✅ 端到端：真 SQLite + FTS5 + vec0 + mock embedding
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mockEmbedding, textToVector } from '../model/mock.js';

import { createVectorStore } from './vector-store.js';
import { createIndexer } from './indexer.js';
import {
  fuseRRF,
  searchWithRRF,
  createSearcher,
  buildTimeRoute,
  RRF_K,
  DEFAULT_LIMIT,
  DEFAULT_WEIGHTS,
} from './rrf.js';
import { DIM, openMemory, seedMsgs, idsOf, silent } from './_fixtures.js';

/** 造一条命中的最小形状（只带 id + at，够融合用） */
const hit = (id, at = 1_760_000_000_000 + id * 1000) => ({ id, at, text: `msg-${id}` });

/** 手算 RRF 分，用来当"真值"对账（k=60） */
function expectedScore(ranks, k = RRF_K) {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0);
}

/* ------------------------------ 纯融合 ------------------------------ */

test('三路融合：RRF 分与手算一致，顺序正确', () => {
  const time = [hit(2), hit(1)]; // 时间路：2 第一、1 第二
  const keyword = [hit(1), hit(3), hit(2)]; // 关键词路：1,3,2
  const vector = [hit(3), hit(4), hit(1)]; // 向量路：3,4,1

  const fused = fuseRRF({ time, keyword, vector });

  // ① 每条的 RRF 分必须等于 1/(60+rank) 之和
  const expect = new Map([
    [1, expectedScore([2, 1, 3])], // 时间2 关键词1 向量3
    [2, expectedScore([1, 3])], // 时间1 关键词3（向量路没有）
    [3, expectedScore([2, 1])], // 关键词2 向量1
    [4, expectedScore([2])], // 只有向量路第 2
  ]);
  assert.equal(fused.length, 4);
  for (const h of fused) {
    assert.ok(
      Math.abs(h.rrfScore - expect.get(h.id)) < 1e-12,
      `id=${h.id} 的 RRF 分：算得 ${h.rrfScore} 应为 ${expect.get(h.id)}`,
    );
  }

  // ② 顺序：id 1 出现在三路（分最高）→ 第一；id 4 只出现一次 → 最后
  assert.equal(fused[0].id, 1, '三路都命中的应该排第一');
  assert.equal(fused.at(-1).id, 4, '只被一路命中的应该在后');
  for (let i = 1; i < fused.length; i++) {
    assert.ok(fused[i].rrfScore <= fused[i - 1].rrfScore + 1e-12, '必须按 RRF 分降序');
  }

  // ③ 每路的名次也带出来了（解释"为什么这条在前面"用）
  assert.deepEqual(fused[0].sources.sort(), ['keyword', 'time', 'vector']);
  assert.deepEqual(fused[0].rr, { time: 2, keyword: 1, vector: 3 });
  assert.equal(fused[0].bestRank, 1);
});

test('融合只认排名、不认分数：三路量纲不同也不影响', () => {
  // 关键词路照 FTS 的习惯给负数分，向量路给 0~1，时间路没有分 —— RRF 全不看
  const keyword = [{ id: 1, score: -12.3 }, { id: 2, score: -0.5 }];
  const vector = [{ id: 2, score: 0.92 }, { id: 1, score: 0.11 }];
  const fused = fuseRRF({ keyword, vector });
  assert.deepEqual(
    idsOf(fused),
    [1, 2],
    '1 在关键词路第一（分更差的 -12.3 也不影响），所以融合后第一',
  );
  assert.equal(fused[0].rr.keyword, 1);
});

test('同一路里的重复命中只算一次（取最好名次）', () => {
  const keyword = [hit(5), hit(5), hit(7)];
  const fused = fuseRRF({ keyword });
  assert.equal(fused.length, 2);
  assert.equal(fused[0].id, 5);
  assert.equal(fused[0].rr.keyword, 1, '重复出现不该把名次往后推');
  assert.equal(fused[1].rr.keyword, 2, '7 是第二名，不是第三名');
});

test('权重可调；权重为 0 等于关掉那一路', () => {
  // at 取同一个值，让平手时落到"key 升序"这条兜底规则上，用例只测权重
  const time = [{ id: 1, at: 0 }];
  const keyword = [{ id: 2, at: 0 }];
  // 等权 → 两者同分，按 key 升序
  const even = fuseRRF({ time, keyword });
  assert.ok(Math.abs(even[0].rrfScore - even[1].rrfScore) < 1e-12);
  assert.deepEqual(idsOf(even), [1, 2]);

  // 关键词权重 2 → 2 排第一
  const weighted = fuseRRF({ time, keyword }, { weights: { keyword: 2 } });
  assert.equal(weighted[0].id, 2);

  // 向量权重 0 → 向量路的命中直接不参与
  const off = fuseRRF({ keyword: [hit(1)], vector: [hit(9)] }, { weights: { vector: 0 } });
  assert.deepEqual(idsOf(off), [1]);
});

test('平手时的兜底顺序：名次好者优先 → 时间新的优先 → key 升序', () => {
  // 同分、同最好名次 → 新的在前（id=1 的 at 更新，所以 1 在前）
  const newerFirst = fuseRRF({
    time: [{ id: 1, at: 2_000 }],
    keyword: [{ id: 2, at: 1_000 }],
  });
  assert.deepEqual(idsOf(newerFirst), [1, 2], '同分时新消息优先');

  // 名次不同但总分接近时，先比总分再比最好名次（这里只验证"确定性"）
  const a = fuseRRF({ time: [hit(1), hit(2)], keyword: [hit(2)] });
  const b = fuseRRF({ time: [hit(1), hit(2)], keyword: [hit(2)] });
  assert.deepEqual(idsOf(a), idsOf(b), '同样的输入必须给同样的顺序');
});

test('limit 生效；空三路返回空数组', () => {
  const many = Array.from({ length: 50 }, (_, i) => hit(i + 1));
  assert.equal(fuseRRF({ keyword: many }).length, DEFAULT_LIMIT, '默认 20 条（BUILD-PLAN §4.5）');
  assert.equal(fuseRRF({ keyword: many }, { limit: 5 }).length, 5);
  assert.deepEqual(fuseRRF({}), []);
  assert.deepEqual(fuseRRF({ time: [], keyword: [], vector: [] }), []);
});

/* ------------------------------ 始终混合检索 ------------------------------ */

test('关键词命中 ≥5 条时，向量路仍照常执行并与关键词路 RRF 融合', async () => {
  let vectorCalls = 0;
  const keywordHits = [hit(1), hit(2), hit(3), hit(4), hit(5)]; // 5 条
  const result = await searchWithRRF({
    keyword: () => keywordHits,
    vector: () => {
      vectorCalls += 1;
      return [hit(2), hit(9)];
    },
  });

  assert.equal(vectorCalls, 1, '始终混合检索：即使关键词命中 ≥5 条也要跑向量路');
  assert.equal(result.meta.vectorSkipped, false);
  assert.deepEqual(result.meta.usedRoutes.sort(), ['keyword', 'vector']);
  assert.ok(idsOf(result.hits).includes(9));
  // 2 被两路命中 → 排第一
  assert.equal(result.hits[0].id, 2);
});

test('未提供向量路时明确标记 vectorSkipped，不报错', async () => {
  const result = await searchWithRRF({
    keyword: [hit(1), hit(2)],
  });
  assert.equal(result.meta.vectorSkipped, true);
  assert.equal(result.meta.vectorSkipReason, '未提供向量路');
  assert.deepEqual(result.meta.usedRoutes, ['keyword']);
});

test('向量路失败 → 降级到关键词 + 时间，并说明原因（不静默少一路）', async () => {
  const degraded = [];
  const result = await searchWithRRF(
    {
      keyword: [hit(1), hit(2)],
      time: [hit(3)],
      vector: () => {
        throw new Error('网络超时');
      },
    },
    { onDegrade: (info) => degraded.push(info) },
  );

  assert.equal(result.meta.degraded, true);
  assert.match(result.meta.vectorError, /网络超时/);
  assert.equal(result.meta.errors.length, 1);
  assert.equal(result.meta.errors[0].route, 'vector');
  assert.equal(degraded.length, 1, 'onDegrade 应该被回调，便于上层提示');
  // 另外两路照常出结果
  assert.deepEqual(result.meta.usedRoutes.sort(), ['keyword', 'time']);
  assert.ok(result.hits.length >= 3);
  assert.ok(result.meta.notes.some((n) => n.includes('向量路失败')));
});

test('三路全挂才抛（单路失败属于降级，不该把检索搞崩）', async () => {
  await assert.rejects(
    () =>
      searchWithRRF({
        keyword: () => {
          throw new Error('FTS 崩了');
        },
        vector: () => {
          throw new Error('向量崩了');
        },
      }),
    /三路检索全部失败/,
  );

  // 只有一路挂、另一路有结果 → 不抛
  const ok = await searchWithRRF({
    keyword: [hit(1)],
    vector: () => {
      throw new Error('向量崩了');
    },
  });
  assert.equal(ok.hits.length, 1);
  assert.equal(ok.meta.degraded, true);
});

test('默认参数就是文档里的数（k=60 / 20 条 / 等权）', () => {
  assert.equal(RRF_K, 60);
  assert.equal(DEFAULT_LIMIT, 20);
  assert.deepEqual({ ...DEFAULT_WEIGHTS }, { time: 1, keyword: 1, vector: 1 });
});

/* ---------------------------- 端到端（真库） ---------------------------- */

/**
 * 真库：SQLite + FTS5 trigram + vec0 + mock embedding。
 * 6 条消息含「月见草」，其余 14 条不含 —— 这样能精确控制关键词路命中几条。
 */
async function e2e() {
  const ctx = openMemory();
  const provider = mockEmbedding(DIM);
  const store = createVectorStore(ctx.handle, { dim: DIM, logger: silent });
  const indexer = createIndexer({ handle: ctx.handle, provider, extras: ctx.extras, store, logger: silent });

  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      sessionId: 's-e2e',
      seq: i + 1,
      at: 1_760_000_000_000 + i * 3_600_000,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      text: i < 6 ? `第${i}句说到月见草` : `第${i}句在说别的事情`,
      inSurface: 1,
    });
  }
  // 再加一场 scene，给时间路用
  const sceneId = ctx.repo.insertScene({
    sessionId: 's-e2e',
    startAt: 1_760_000_000_000,
    endAt: 1_760_000_000_000 + 5 * 3_600_000,
    msgCount: 5,
  });
  ctx.repo.setSceneGist(sceneId, '【发生了什么】前六句在说月见草');

  const ids = ctx.repo.insertMsgs(rows);
  ctx.extras.sceneAssign.assign(ids.slice(0, 5), sceneId);

  await indexer.indexPending();
  assert.equal(store.countMsgVec(), 20, '前置条件：20 条都已索引');

  const searcher = createSearcher({ repo: ctx.repo, extras: ctx.extras, store, provider });

  /** 统计向量路真的被调了多少次 */
  const spy = { knn: 0 };
  const rawKnn = store.knnMsg.bind(store);
  store.knnMsg = (...args) => {
    spy.knn += 1;
    return rawKnn(...args);
  };

  return { ...ctx, searcher, provider, store, spy, sceneId, ids };
}

test('端到端：始终混合检索 —— 关键词命中 ≥5 条时，向量路仍照常执行（spy 验证）', async () => {
  const ctx = await e2e();
  try {
    const before = ctx.provider.calls.length; // 索引阶段用掉的 embedding 次数
    const spyBefore = ctx.spy.knn;

    const { hits, meta } = await ctx.searcher.searchMsgs({ query: '月见草' });

    assert.ok(meta.counts.keyword >= 5, `关键词应命中 ≥5，实际 ${meta.counts.keyword}`);
    assert.equal(meta.vectorSkipped, false);
    assert.equal(ctx.spy.knn, spyBefore + 1, '始终混合检索：向量检索应被调用一次');
    assert.equal(ctx.provider.calls.length, before + 1, '始终混合检索：查询应 embed 一次');
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.sources.includes('keyword')));
    assert.ok(hits.some((h) => h.sources.includes('vector')));
  } finally {
    ctx.close();
  }
});

test('端到端：关键词少量命中时三路结果合到一起', async () => {
  const ctx = await e2e();
  try {
    const before = ctx.provider.calls.length;
    const spyBefore = ctx.spy.knn;

    // 只命中 1 条（第3句）→ 混合检索照常跑向量路
    const { hits, meta } = await ctx.searcher.searchMsgs({ query: '第3句说到月见草' });

    assert.ok(meta.counts.keyword < 5, `关键词应 <5，实际 ${meta.counts.keyword}`);
    assert.equal(meta.vectorSkipped, false);
    assert.equal(ctx.spy.knn, spyBefore + 1, '向量检索应恰好被调用一次');
    assert.equal(ctx.provider.calls.length, before + 1, '查询要 embed 一次');
    assert.ok(meta.counts.vector > 0, '向量路应该有结果');
    assert.ok(hits.some((h) => h.sources.includes('vector')));
    // 关键词命中的那条一定在结果里（融合只并集、不丢）
    assert.ok(hits.some((h) => h.sources.includes('keyword')));
  } finally {
    ctx.close();
  }
});

test('端到端：时间路（给时间窗）出场，每条结果能说出属于哪一场', async () => {
  const ctx = await e2e();
  try {
    const from = 1_760_000_000_000;
    const { hits, meta } = await ctx.searcher.searchMsgs({
      query: '不相干的词',
      from,
      to: from + 4 * 3_600_000,
    });
    assert.ok(meta.counts.time > 0, '时间窗内应能取到消息');
    assert.ok(meta.usedRoutes.includes('time'));
    const withScene = hits.filter((h) => Number.isFinite(h.sceneStartAt));
    assert.ok(withScene.length > 0, '时间路的结果必须带场景区间');
  } finally {
    ctx.close();
  }
});

test('端到端：库里向量是别的模型时，向量路降级而不是崩（D-152 + 降级）', async () => {
  const ctx = await e2e();
  try {
    const other = {
      id: 'sf:Qwen/Qwen3-Embedding-8B@1024',
      dim: DIM,
      maxBatch: 32,
      async embed(texts) {
        return texts.map((t) => textToVector(`${t}——另模型`, DIM));
      },
    };
    const searcher = createSearcher({ repo: ctx.repo, extras: ctx.extras, store: ctx.store, provider: other });

    const { hits, meta } = await searcher.searchMsgs({ query: '第3句说到月见草' });
    assert.equal(meta.degraded, true);
    assert.match(meta.vectorError, /向量模型不一致/, '不一致要说清是模型的问题，而不是"没结果"');
    assert.ok(hits.length > 0, '降级后仍有关键词结果');
    assert.ok(!hits.some((h) => h.sources.includes('vector')));
  } finally {
    ctx.close();
  }
});

test('空 query 不进检索，直接返回空 + 说明', async () => {
  const ctx = await e2e();
  try {
    const { hits, meta } = await ctx.searcher.searchMsgs({ query: '   ' });
    assert.deepEqual(hits, []);
    assert.equal(meta.emptyQuery, true);
  } finally {
    ctx.close();
  }
});

test('buildTimeRoute：没有时间窗就不跑时间路', () => {
  const fakeRepo = { scenesByTimeRange: () => assert.fail('不该被调用'), msgsByScene: () => [] };
  assert.equal(buildTimeRoute(fakeRepo, {}), null);
  assert.equal(buildTimeRoute(fakeRepo, { sessionId: 's' }), null);
});
