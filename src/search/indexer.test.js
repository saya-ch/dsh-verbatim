/**
 * indexer 单测 —— 全量 / 增量 / D-152 模型校验 / 分批 / 重试
 *
 * 跑法：
 *   node --test src/search/
 *   node --test src/search/indexer.test.js
 *
 * 覆盖验收点（任务书 §5）：
 *   ✅ 全量索引 100 条，pending 清空，vec_model/vec_dim 记账
 *   ✅ 增量：新 msg 立刻可查
 *   ✅ 模型不一致时 vecMeta.assert 抛错，且索引器拒绝写入（D-152）
 *   ✅ 按 provider.maxBatch 分批；网络抖动重试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mockEmbedding, textToVector } from '../model/mock.js';

import { createVectorStore } from './vector-store.js';
import { createIndexer } from './indexer.js';
import { DIM, openMemory, seedMsgs, idsOf, silent } from './_fixtures.js';

/** 另一个"模型"：id 不同、向量空间不同（用不同的 hash 盐），用来触发 D-152 */
function anotherProvider() {
  return {
    id: 'sf:Qwen/Qwen3-Embedding-8B@1024',
    dim: DIM,
    maxBatch: 32,
    async embed(texts) {
      return texts.map((t) => textToVector(`${t}——另模型`, DIM));
    },
  };
}

function setup(providerOpts = {}) {
  const ctx = openMemory();
  const provider = mockEmbedding(DIM, providerOpts);
  const store = createVectorStore(ctx.handle, { dim: DIM, logger: silent });
  const indexer = createIndexer({
    handle: ctx.handle,
    provider,
    extras: ctx.extras,
    store,
    logger: silent,
  });
  return { ...ctx, provider, store, indexer };
}

test('全量索引：100 条入库 + 记账 + pending 清空 + 立刻可查', async () => {
  const ctx = setup();
  try {
    const { msgs } = seedMsgs({ repo: ctx.repo, count: 100 });
    assert.equal(ctx.extras.vecMeta.pending({ limit: 1000 }).length, 100, '索引前 100 条都待索引');

    const result = await ctx.indexer.indexPending();
    assert.equal(result.indexed, 100);
    assert.equal(result.hasMore, false);
    assert.equal(ctx.store.countMsgVec(), 100, '向量表里应有 100 条');
    assert.equal(ctx.extras.vecMeta.pending({ limit: 1000 }).length, 0, '索引后不应再有待索引的');

    // D-152 的记账：vec_model / vec_dim 必须写进 msg
    const meta = ctx.extras.vecMeta.get();
    assert.equal(meta.model, ctx.provider.id);
    assert.equal(meta.dim, DIM);
    assert.equal(meta.indexed, 100);
    assert.equal(meta.total, 100);

    // 索引完就能查，且自己查自己第一
    const hits = ctx.store.knnMsg(textToVector(msgs[7].text, DIM), 3);
    assert.equal(hits[0].id, msgs[7].id);
    assert.ok(hits[0].score > 0.9999);

    // 再跑一次是空转（幂等，不会重复 embedding）
    const again = await ctx.indexer.indexPending();
    assert.equal(again.indexed, 0);
    assert.equal(ctx.provider.calls.length, 4, '100 条 / 每批 32 条 = 4 批，第二次不该再调用');
  } finally {
    ctx.close();
  }
});

test('增量索引：新 msg 立刻入索引，不用等全量重建', async () => {
  const ctx = setup();
  try {
    const { msgs } = seedMsgs({ repo: ctx.repo, count: 5 });
    await ctx.indexer.indexPending();
    assert.equal(ctx.store.countMsgVec(), 5);

    // 模拟"新消息来了"：先入库，再立刻索引这一条
    const newId = ctx.repo.insertMsg({
      sessionId: 's-test',
      seq: 999,
      at: Date.now(),
      speaker: 'user',
      text: '刚刚说的这句话也要能搜到',
      inSurface: 1,
    });
    const fresh = { id: newId, text: '刚刚说的这句话也要能搜到' };

    const before = ctx.store.knnMsg(textToVector(fresh.text, DIM), 3);
    assert.ok(!idsOf(before).includes(newId), '索引之前查不到');

    const written = await ctx.indexer.indexMsgs([fresh]);
    assert.equal(written, 1);
    const after = ctx.store.knnMsg(textToVector(fresh.text, DIM), 3);
    assert.equal(after[0].id, newId, '索引之后应当排第一');
    assert.equal(ctx.store.countMsgVec(), 6);

    // 老消息不受影响
    const oldHit = ctx.store.knnMsg(textToVector(msgs[2].text, DIM), 3);
    assert.equal(oldHit[0].id, msgs[2].id);
  } finally {
    ctx.close();
  }
});

test('indexMsgs 空数组 / 脏数据不炸', async () => {
  const ctx = setup();
  try {
    assert.equal(await ctx.indexer.indexMsgs([]), 0);
    assert.equal(await ctx.indexer.indexMsgs([null, { id: 'x', text: 1 }, {}]), 0);
  } finally {
    ctx.close();
  }
});

test('场景 gist 向量：有 gist 才索引，没 gist 的算跳过', async () => {
  const ctx = setup();
  try {
    const withGist = ctx.repo.insertScene({
      sessionId: 's-test',
      startAt: 1_760_000_000_000,
      endAt: 1_760_000_100_000,
      msgCount: 12,
    });
    ctx.repo.setSceneGist(withGist, '【发生了什么】TA在问怕黑的事【原话】"我怕那个"');
    const noGist = ctx.repo.insertScene({
      sessionId: 's-test',
      startAt: 1_760_000_200_000,
      endAt: 1_760_000_300_000,
      msgCount: 8,
    });

    const scenes = [withGist, noGist].map((id) => ctx.repo.sceneById(id));
    const result = await ctx.indexer.indexScenes(scenes);
    // 返回值从「只有两个数」变成带原因的（T8 的 skippedScenes 115/116 就是这么猜出来的）
    assert.equal(result.indexed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedReasons.emptyGist, 1);
    assert.equal(result.skippedReasons.embedFailed, 0);
    assert.match(result.reason, /gist 为空/, '跳过原因必须说清是 gist 没生成，不是别的');
    assert.equal(ctx.store.countSceneVec(), 1);

    const hits = ctx.store.knnScene(
      textToVector('【发生了什么】TA在问怕黑的事【原话】"我怕那个"', DIM),
      3,
    );
    assert.equal(hits[0].id, withGist);
    assert.ok(hits[0].gist.includes('怕黑'));
  } finally {
    ctx.close();
  }
});

test('模型不一致：vecMeta.assert 抛错 + 索引器拒绝写入（D-152）', async () => {
  const ctx = setup();
  try {
    seedMsgs({ repo: ctx.repo, count: 10 });
    await ctx.indexer.indexPending();

    const other = anotherProvider();

    // ① store 层的 assert 直接抛（最里面那道闸）
    assert.throws(() => ctx.extras.vecMeta.assert(other), /向量模型不一致/, 'vecMeta.assert 必须拦住');
    // ② indexer.check() 给不抛的版本（面板/工具层用）
    const check = createIndexer({
      handle: ctx.handle,
      provider: other,
      extras: ctx.extras,
      store: createVectorStore(ctx.handle, { dim: DIM, logger: silent }),
      logger: silent,
    }).check();
    assert.equal(check.ok, false);
    assert.match(check.error, /向量模型不一致/);
    assert.equal(check.current.model, ctx.provider.id);

    // ③ 用新模型的索引器写 → 必须抛，不能混写
    const otherIndexer = createIndexer({
      handle: ctx.handle,
      provider: other,
      extras: ctx.extras,
      store: createVectorStore(ctx.handle, { dim: DIM, logger: silent }),
      logger: silent,
    });
    await assert.rejects(() => otherIndexer.indexPending(), /向量模型不一致/);
    assert.equal(ctx.store.countMsgVec(), 10, '被拒之后库里仍是原来那 10 条，没被污染');

    // ④ 换模型的正路只有 rebuild({force:true})：清旧向量 + 清指纹 + 用新模型重算
    const rebuilt = await otherIndexer.rebuild({ force: true });
    assert.equal(rebuilt.msgs, 10);
    assert.equal(rebuilt.forced, true);
    assert.equal(ctx.store.countMsgVec(), 10, '重建后条数不变，但向量是新的');
    assert.equal(ctx.extras.vecMeta.get().model, other.id, '记账已切到新模型');
    assert.doesNotThrow(() => ctx.extras.vecMeta.assert(other));
  } finally {
    ctx.close();
  }
});

test('按 provider.maxBatch 分批，不一次性把全文塞进请求', async () => {
  const ctx = setup({ maxBatch: 5 });
  try {
    seedMsgs({ repo: ctx.repo, count: 12 });
    await ctx.indexer.indexPending();
    const sizes = ctx.provider.calls.map((c) => c.texts.length);
    assert.deepEqual(sizes, [5, 5, 2], `12 条按每批 5 条应是 [5,5,2]，实际 ${JSON.stringify(sizes)}`);
  } finally {
    ctx.close();
  }
});

test('embedding 抖动会重试，最终成功', async () => {
  const ctx = openMemory();
  try {
    let failures = 1;
    const flaky = {
      id: 'mock:flaky@1024',
      dim: DIM,
      maxBatch: 32,
      async embed(texts) {
        if (failures-- > 0) throw new Error('模拟网络抖动');
        return texts.map((t) => textToVector(t, DIM));
      },
    };
    const store = createVectorStore(ctx.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({ handle: ctx.handle, provider: flaky, extras: ctx.extras, store, logger: silent });

    seedMsgs({ repo: ctx.repo, count: 3 });
    const result = await indexer.indexPending();
    assert.equal(result.indexed, 3, '重试之后应当全部索引成功');
  } finally {
    ctx.close();
  }
});

test('excluded=1 的消息默认不索引（省 embedding 调用，D-169/170）', async () => {
  const ctx = setup();
  try {
    const { msgs } = seedMsgs({ repo: ctx.repo, count: 10 });
    // 排除掉 3 条
    for (const m of msgs.slice(0, 3)) {
      ctx.handle.db.prepare('UPDATE msg SET excluded = 1 WHERE id = ?').run(m.id);
    }
    const result = await ctx.indexer.indexPending();
    assert.equal(result.indexed, 7, '只该索引未被排除的 7 条');
    assert.equal(ctx.store.countMsgVec(), 7);

    // 明确要求时连排除的一起索引
    const all = await ctx.indexer.indexPending({ includeExcluded: true });
    assert.equal(all.indexed, 3);
    assert.equal(ctx.store.countMsgVec(), 10);
  } finally {
    ctx.close();
  }
});

test('维度与库不符要当场拦住（vec0 表的维度建表后不可变）', () => {
  const ctx = openMemory();
  try {
    assert.throws(
      () =>
        createIndexer({
          handle: ctx.handle,
          provider: mockEmbedding(256),
          extras: ctx.extras,
          logger: silent,
        }),
      // 报错必须同时说清「库是多少」和「provider 是多少」，否则排查时只能猜
      /float\[1024\][\s\S]*256|256[\s\S]*float\[1024\]/,
    );
  } finally {
    ctx.close();
  }
});

test('status() 能说清"索引到哪了"', async () => {
  const ctx = setup();
  try {
    seedMsgs({ repo: ctx.repo, count: 6 });
    const before = ctx.indexer.status();
    assert.equal(before.total, 6);
    assert.equal(before.indexed, 0);
    assert.equal(before.hasPending, true);
    assert.equal(before.consistent, true, '干净库当然是一致的');

    await ctx.indexer.indexPending({ limit: 4 });
    const mid = ctx.indexer.status();
    assert.equal(mid.indexed, 4);
    assert.equal(mid.hasPending, true);
    assert.equal(mid.store.msgVectors, 4);
    assert.equal(mid.provider.id, ctx.provider.id);
  } finally {
    ctx.close();
  }
});

/* ======================= T8 集成时发现的两个真 bug =======================
 * 都是「单测全绿但合起来就出事」：
 *   ① rebuild 非 force 分支只清向量表不清指纹 → 第二次 rebuild 产出 0 条
 *   ② rebuild({scenes}) 在 gist 写回之前调用 → 静默跳过一整个场景库
 * ====================================================================== */

test('rebuild 幂等：同一个库对象连跑两次，第二次必须索引同样多的行', async () => {
  const ctx = setup();
  try {
    seedMsgs({ repo: ctx.repo, count: 30 });

    const first = await ctx.indexer.rebuild();
    assert.equal(first.msgs, 30, '第一次应当索引 30 条');
    assert.equal(ctx.store.countMsgVec(), 30);

    // ← 这一行就是 T8 的现场：不修的话第二次是 0
    const second = await ctx.indexer.rebuild();
    assert.equal(second.msgs, 30, '第二次也必须索引 30 条（指纹和向量表不能靠先后顺序自洽）');
    assert.equal(ctx.store.countMsgVec(), 30);

    // 第三次也一样，别只有第二次特殊
    const third = await ctx.indexer.rebuild();
    assert.equal(third.msgs, 30);
    assert.equal(ctx.extras.vecMeta.get().indexed, 30);
    assert.equal(ctx.indexer.status().consistent, true);

    // rebuild 之后依然能查
    const { msgs } = { msgs: ctx.repo.msgsByTimeRange('s-test', 0, Number.MAX_SAFE_INTEGER, 30) };
    const hits = ctx.store.knnMsg(textToVector(msgs[3].text, DIM), 3);
    assert.equal(hits[0].id, msgs[3].id);
  } finally {
    ctx.close();
  }
});

test('「指纹在、向量表被清空」能自愈（不清指纹就永远索引不出来）', async () => {
  const ctx = setup();
  try {
    seedMsgs({ repo: ctx.repo, count: 20 });
    await ctx.indexer.indexPending();
    assert.equal(ctx.extras.vecMeta.get().indexed, 20);

    // 模拟外部把向量表清了却没清指纹（rebuild 中途崩、别的工具清表都长这样）
    ctx.store.clearMsgVec();
    assert.equal(ctx.store.countMsgVec(), 0);
    assert.equal(ctx.extras.vecMeta.get().indexed, 20, '前置条件：指纹还在');
    assert.equal(ctx.extras.vecMeta.pending({ limit: 5 }).length, 0, '前置条件：pending 一条也捞不到');
    assert.equal(ctx.indexer.status().consistent, false, 'status 必须报出这种不一致');

    // ① 显式自愈接口
    const repair = ctx.indexer.repair();
    assert.equal(repair.repaired, true);
    assert.equal(repair.metaIndexed, 20);
    assert.equal(repair.vectors, 0);
    assert.equal(ctx.extras.vecMeta.pending({ limit: 5 }).length, 5, '清完指纹 pending 才看得见');

    // ② 不显式调用也能自愈：indexPending 开头会自己检查一遍
    const result = await ctx.indexer.indexPending();
    assert.equal(result.indexed, 20, '自愈之后必须能把 20 条重新索引回来');
    assert.equal(ctx.store.countMsgVec(), 20);
    assert.equal(ctx.indexer.status().consistent, true);
  } finally {
    ctx.close();
  }
});

test('场景跳过要分原因：gist 为空 vs embedding 失败', async () => {
  const ctx = setup();
  try {
    // 3 场：2 场有 gist、1 场没有
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = ctx.repo.insertScene({
        sessionId: 's-test',
        startAt: 1_760_000_000_000 + i * 3_600_000,
        endAt: 1_760_000_000_000 + i * 3_600_000 + 600_000,
        msgCount: 10,
      });
      if (i < 2) ctx.repo.setSceneGist(id, `【发生了什么】第${i}场TA在说怕黑`);
      ids.push(id);
    }

    const scenes = ids.map((id) => ctx.repo.sceneById(id));
    const result = await ctx.indexer.indexScenes(scenes);
    assert.equal(result.indexed, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedReasons.emptyGist, 1);
    assert.equal(result.skippedReasons.embedFailed, 0);
    assert.match(result.reason, /gist 为空/);
    assert.doesNotMatch(result.reason, /embedding/);
  } finally {
    ctx.close();
  }
});

test('场景 embedding 失败只跳过失败那批，不炸整轮，并在 skippedReasons 里报出来', async () => {
  const ctx = openMemory();
  try {
    // 只让第 0 场的 gist 一直失败（重试也救不回来），其余照常
    const picky = {
      id: 'mock:picky@1024',
      dim: DIM,
      maxBatch: 1, // 每批 1 场，好控制"只挂一场"
      async embed(texts) {
        if (texts.some((t) => t.endsWith('第0场'))) throw new Error('模拟额度不足');
        return texts.map((t) => textToVector(t, DIM));
      },
    };
    const store = createVectorStore(ctx.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({ handle: ctx.handle, provider: picky, extras: ctx.extras, store, logger: silent });

    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = ctx.repo.insertScene({
        sessionId: 's-test',
        startAt: 1_760_000_000_000 + i * 3_600_000,
        endAt: 1_760_000_000_000 + i * 3_600_000 + 600_000,
        msgCount: 5,
      });
      ctx.repo.setSceneGist(id, `【发生了什么】第${i}场`);
      ids.push(id);
    }

    const result = await indexer.indexScenes(ids.map((id) => ctx.repo.sceneById(id)));
    assert.equal(result.indexed, 2, '另外两场照常索引');
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedReasons.embedFailed, 1, '失败原因要和"gist 为空"区分开');
    assert.equal(result.skippedReasons.emptyGist, 0);
    assert.match(result.reason, /embedding 调用失败/);
    assert.equal(result.failed, false, '有成功的就不算整体失败');
  } finally {
    ctx.close();
  }
});

test('rebuild({scenes}) 在 gist 还没写回时会给出明确警告（T8 的 115/116）', async () => {
  const ctx = setup();
  try {
    seedMsgs({ repo: ctx.repo, count: 5 });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        ctx.repo.insertScene({
          sessionId: 's-test',
          startAt: 1_760_000_000_000 + i * 3_600_000,
          endAt: 1_760_000_000_000 + i * 3_600_000 + 600_000,
          msgCount: 5,
        }),
      );
    }
    // 只有 1 场有 gist（覆盖率 25% < 50%）
    ctx.repo.setSceneGist(ids[0], '【发生了什么】只有这一场有 gist');

    const result = await ctx.indexer.rebuild({ scenes: ids.map((id) => ctx.repo.sceneById(id)) });
    assert.equal(result.msgs, 5, '消息向量不受场景时序影响');
    assert.equal(result.scenes, 1);
    assert.equal(result.skippedScenes, 3);
    assert.equal(result.skippedReasons.emptyGist, 3);
    assert.match(result.sceneSkipReason, /gist 为空/);
    assert.equal(result.warnings.length, 1, '覆盖率过低必须警告，不能让人对着 3/4 猜');
    assert.match(result.warnings[0], /scene\.gist/);
    assert.match(result.warnings[0], /覆盖率只有 1\/4/);

    // 把 gist 补齐再跑一次 → 不再警告，全部嵌进去
    for (const id of ids) ctx.repo.setSceneGist(id, `【发生了什么】第${id}场补上 gist`);
    const again = await ctx.indexer.rebuild({ scenes: ids.map((id) => ctx.repo.sceneById(id)) });
    assert.equal(again.scenes, 4);
    assert.equal(again.skippedScenes, 0);
    assert.deepEqual(again.warnings, []);
    assert.equal(ctx.store.countSceneVec(), 4);
  } finally {
    ctx.close();
  }
});
