/**
 * vector-store 单测 —— sqlite-vec 主路径 + 暴力余弦降级路径
 *
 * 跑法：
 *   node --test src/search/
 *   node --test "src/search/*.test.js"
 *   node --test src/search/vector-store.test.js
 *
 * 覆盖验收点（任务书 §5）：
 *   ✅ 100 条假向量，KNN 返回正确 top-k（真值在测试里用点积独立算，不拿 vec0 当尺子）
 *   ✅ 主键必须 BigInt（D-149 坑②）—— 直接绑 Number 会抛，本模块 API 不抛
 *   ✅ 时间过滤在外层（D-150）—— 时间窗外的"最相似"不能出现在结果里
 *   ✅ hasVec=false 时暴力余弦与 vec0 返回同一批 id、同一个分数
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../store/db.js';
import { createRepo } from '../store/repo.js';
import { textToVector } from '../model/mock.js';

import { createVectorStore, normalizeVector, distanceToScore } from './vector-store.js';
import { DIM, openMemory, seedMsgs, referenceTopK, idsOf, silent } from './_fixtures.js';

/** 每组用例都开一个干净的内存库，跑完关掉 */
function withDb(fn) {
  return async () => {
    const ctx = openMemory();
    try {
      await fn(ctx);
    } finally {
      ctx.close();
    }
  };
}

test('100 条假向量：KNN 返回的 top-k 与数学真值一致', withDb(async ({ handle, repo }) => {
  const store = createVectorStore(handle, { dim: DIM });
  assert.equal(store.hasVec, true, '这台机器应该能加载 sqlite-vec（加载失败则本用例无意义）');
  assert.equal(store.mode, 'vec0');

  const { msgs, vectors } = seedMsgs({ repo, count: 100 });
  store.insertMsgVecs(vectors);
  assert.equal(store.countMsgVec(), 100);

  // 用第 0 条的原文当查询 → 它自己必须排第一，且余弦≈1
  const queryText = msgs[0].text;
  const query = textToVector(queryText, DIM);

  for (const k of [1, 5, 10, 20]) {
    const hits = store.knnMsg(query, k);
    assert.equal(hits.length, k, `k=${k} 应该正好返回 ${k} 条`);

    const truth = referenceTopK(query, vectors, k);
    assert.deepEqual(idsOf(hits), truth.map((t) => t.id), `k=${k} 的 top-k id 序列应与真值一致`);

    // 分数也要对得上（vec0 的 L2 距离换算成余弦后允许 1e-4 的浮点误差）
    for (let i = 0; i < k; i++) {
      assert.ok(
        Math.abs(hits[i].score - truth[i].score) < 1e-4,
        `第 ${i + 1} 名的分数：vec0=${hits[i].score.toFixed(6)} 真值=${truth[i].score.toFixed(6)}`,
      );
    }
  }

  // 自己查自己：cos = 1，distance = 0
  const self = store.knnMsg(query, 1)[0];
  assert.equal(self.id, msgs[0].id);
  assert.ok(self.score > 0.9999, `自己查自己余弦应≈1，实际 ${self.score}`);
  assert.ok(self.distance < 1e-3, `自己查自己 L2 距离应≈0，实际 ${self.distance}`);

  // 升序：分数单调不增
  const top = store.knnMsg(query, 20);
  for (let i = 1; i < top.length; i++) {
    assert.ok(top[i].score <= top[i - 1].score + 1e-6, '结果必须按相似度降序');
    assert.equal(top[i].vecRank, i + 1, 'vecRank 应从 1 开始连续');
  }
}));

test('主键必须 BigInt（D-149 坑②）：裸 SQL 绑 Number 抛错，本模块 API 正常', withDb(async ({ handle, repo }) => {
  const store = createVectorStore(handle, { dim: DIM });
  const { msgs } = seedMsgs({ repo, count: 3 });
  const vec = textToVector(msgs[0].text, DIM);
  const blob = new Uint8Array(normalizeVector(vec, DIM).buffer);

  // ① 裸 SQL 传 Number：这就是踩坑现场，必须抛
  assert.throws(
    () => handle.db.prepare('INSERT INTO vec_msg (msg_id, emb) VALUES (?, ?)').run(999, blob),
    /Only integers/i,
    '传 Number 应该报 Only integers（这是 D-149 坑②本身）',
  );

  // ② 裸 SQL 传 BigInt：能写进去
  handle.db.prepare('INSERT INTO vec_msg (msg_id, emb) VALUES (?, ?)').run(BigInt(998), blob);
  assert.equal(store.countMsgVec(), 1);

  // ③ 本模块的 API 接受普通 number，内部转 BigInt
  store.insertMsgVec(msgs[0].id, vec);
  assert.equal(store.countMsgVec(), 2);

  // ④ 非法主键要给人话，而不是 sqlite 的原始报错
  assert.throws(() => store.insertMsgVec(1.5, vec), /安全整数/);
  assert.throws(() => store.insertMsgVec(-1, vec), /安全整数/);
}));

test('时间过滤在外层（D-150）：窗外的"最相似"不会被返回', withDb(async ({ handle, repo }) => {
  const store = createVectorStore(handle, { dim: DIM });
  const startAt = 1_760_000_000_000;
  const stepMs = 60_000;
  const { msgs, vectors } = seedMsgs({ repo, count: 100, startAt, stepMs });
  store.insertMsgVecs(vectors);

  const anchor = msgs[0]; // 只有它和查询一模一样，向量上排第一
  const query = textToVector(anchor.text, DIM);

  // ① 时间窗把 anchor 排除掉：向量上它是第一名，但外层过滤后必须消失
  const outOfRange = store.knnMsg(query, 5, { from: anchor.at + 1, to: anchor.at + stepMs * 10 });
  assert.ok(!idsOf(outOfRange).includes(anchor.id), '时间窗外的消息不该出现在结果里（D-150）');
  assert.ok(outOfRange.length > 0, '窗外全都滤掉后仍应返回窗内的其他命中');

  // ② 时间窗正好只覆盖 anchor：结果只能是它
  const only = store.knnMsg(query, 5, { from: anchor.at, to: anchor.at + 1 });
  assert.deepEqual(idsOf(only), [anchor.id]);

  // ③ 左闭右开：to 恰好等于 anchor.at 时它不该在
  const none = store.knnMsg(query, 5, { from: anchor.at - stepMs, to: anchor.at });
  assert.ok(!idsOf(none).includes(anchor.id), '[from, to) 左闭右开，to 边界那条不算');

  // ④ 窗内有 20 条，取 3 条：结果仍按相似度降序
  const windowed = store.knnMsg(query, 3, { from: startAt, to: startAt + stepMs * 20 });
  assert.equal(windowed.length, 3);
  for (const h of windowed) {
    assert.ok(h.at >= startAt && h.at < startAt + stepMs * 20);
  }

  // ⑤ 外层过滤后不足 k 条时，有多少给多少，不报错
  const narrow = store.knnMsg(query, 50, { from: startAt, to: startAt + stepMs * 2 });
  assert.equal(narrow.length, 2);
}));

test('软排除（excluded=1）默认不返回，includeExcluded 才返回', withDb(async ({ handle, repo }) => {
  const store = createVectorStore(handle, { dim: DIM });
  const { msgs, vectors } = seedMsgs({ repo, count: 10 });
  store.insertMsgVecs(vectors);

  handle.db.prepare('UPDATE msg SET excluded = 1 WHERE id = ?').run(msgs[0].id);
  assert.equal(
    Number(handle.db.prepare('SELECT excluded FROM msg WHERE id = ?').get(msgs[0].id).excluded),
    1,
    '前置条件：这条确实被标成 excluded=1',
  );

  const query = textToVector(msgs[0].text, DIM);
  const normal = store.knnMsg(query, 10);
  assert.ok(!idsOf(normal).includes(msgs[0].id), '被软排除的消息不该出现在向量结果里');

  const withExcluded = store.knnMsg(query, 10, { includeExcluded: true });
  assert.ok(idsOf(withExcluded).includes(msgs[0].id), 'includeExcluded 时应能看到');
}));

test('场景（gist）向量：vec_scene 独立索引 + 相交语义过滤', withDb(async ({ handle, repo }) => {
  const store = createVectorStore(handle, { dim: DIM });
  const scenes = [];
  for (let i = 0; i < 5; i++) {
    const id = repo.insertScene({
      sessionId: 's-test',
      startAt: 1_760_000_000_000 + i * 3_600_000,
      endAt: 1_760_000_000_000 + i * 3_600_000 + 1_800_000,
      msgCount: 10,
    });
    repo.setSceneGist(id, `第${i}场：TA在说怕黑，提到月见草`);
    scenes.push(repo.sceneById(id));
  }

  store.insertSceneVecs(scenes.map((s, i) => [s.id, textToVector(`第${i}场：TA在说怕黑，提到月见草`, DIM)]));
  assert.equal(store.countSceneVec(), 5);

  const q = textToVector('第2场：TA在说怕黑，提到月见草', DIM);
  const hits = store.knnScene(q, 3);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].id, scenes[2].id, '同一段文本的 gist 应排第一');
  assert.ok(hits[0].score > 0.9999);
  assert.equal(typeof hits[0].gist, 'string');

  // 相交语义：窗落在第 3 场中间 → 只有第 3 场
  const mid = scenes[3].startAt + 1;
  const only = store.knnScene(q, 5, { from: mid, to: mid + 1 });
  assert.deepEqual(idsOf(only), [scenes[3].id]);
}));

test('写入幂等性：重复 INSERT 报错，upsert 覆盖，delete 生效', withDb(async ({ handle, repo }) => {
  const store = createVectorStore(handle, { dim: DIM });
  const { msgs } = seedMsgs({ repo, count: 3 });
  const a = textToVector(msgs[0].text, DIM);
  const b = textToVector('完全不同的另一句话', DIM);

  store.insertMsgVec(msgs[0].id, a);
  assert.throws(() => store.insertMsgVec(msgs[0].id, a), /UNIQUE|constraint/i, '重复主键应报错');

  store.upsertMsgVec(msgs[0].id, b); // 先删再插，不报错
  assert.equal(store.countMsgVec(), 1);
  const [hit] = store.knnMsg(b, 1);
  assert.ok(hit.score > 0.9999, 'upsert 之后应该能查出新向量');

  assert.equal(store.deleteMsgVec(msgs[0].id), 1);
  assert.equal(store.countMsgVec(), 0);
  assert.equal(store.deleteMsgVec(msgs[0].id), 0, '删不存在的返回 0，不抛');
}));

test('降级路径（hasVec=false）与 vec0 返回同一批结果 —— 等价性是硬要求', async () => {
  // 两个库：一个装 sqlite-vec，一个明确不装（模拟目标机器上 dll 加载失败）
  const withVec = openMemory({ loadVec: true });
  const without = openMemory({ loadVec: false });

  try {
    const storeA = createVectorStore(withVec.handle, { dim: DIM });
    const storeB = createVectorStore(without.handle, { dim: DIM, persistFallback: false });
    assert.equal(storeA.mode, 'vec0');
    assert.equal(storeB.mode, 'bruteforce');

    // 同一批消息、同一批向量喂给两边
    const corpus = seedMsgs({ repo: withVec.repo, count: 100 });
    const copied = corpus.msgs.map((m) => ({
      sessionId: m.sessionId,
      seq: m.seq,
      at: m.at,
      speaker: m.speaker,
      text: m.text,
      inSurface: m.inSurface,
    }));
    const idsB = without.repo.insertMsgs(copied);
    const vectorsB = new Map();
    corpus.msgs.forEach((m, i) => vectorsB.set(idsB[i], corpus.vectors.get(m.id)));

    storeA.insertMsgVecs(corpus.vectors);
    storeB.insertMsgVecs(vectorsB);

    assert.equal(storeA.countMsgVec(), storeB.countMsgVec(), '两边的索引条数应相同');

    // 换 8 个查询，逐个对比 top-10
    const queries = [
      corpus.msgs[0].text,
      corpus.msgs[7].text,
      corpus.msgs[42].text,
      corpus.msgs[99].text,
      '第13句关于月见草和害怕的事',
      '随便一句不在库里的话',
      '害怕',
      '',
    ];
    for (const text of queries) {
      if (!text.trim()) continue; // 空查询没有意义，跳过
      const q = textToVector(text, DIM);
      const hitsA = storeA.knnMsg(q, 10);
      const hitsB = storeB.knnMsg(q, 10);

      assert.deepEqual(
        idsOf(hitsA).map((id) => Number(id)),
        idsOf(hitsB).map((id) => Number(id)),
        `两条路径的 top-10 id 必须一致（查询：${text.slice(0, 20)}）`,
      );
      for (let i = 0; i < hitsA.length; i++) {
        assert.ok(
          Math.abs(hitsA[i].score - hitsB[i].score) < 1e-4,
          `第 ${i + 1} 名的分数应一致：vec0=${hitsA[i].score.toFixed(6)} 暴力=${hitsB[i].score.toFixed(6)}`,
        );
      }
    }

    // 底层候选层也要一致（走到 distance 这一级）
    const q = textToVector(corpus.msgs[3].text, DIM);
    const candA = storeA.candidates('msg', q, 15);
    const candB = storeB.candidates('msg', q, 15);
    assert.deepEqual(
      candA.map((c) => c.id),
      candB.map((c) => c.id),
    );
    for (let i = 0; i < candA.length; i++) {
      assert.ok(Math.abs(candA[i].distance - candB[i].distance) < 1e-4, 'distance 口径也应一致');
    }

    // 时间过滤在降级路径同样生效
    const anchor = corpus.msgs[0];
    const filteredB = storeB.knnMsg(q, 5, { from: anchor.at, to: anchor.at + 1 });
    const filteredA = storeA.knnMsg(q, 5, { from: anchor.at, to: anchor.at + 1 });
    assert.deepEqual(idsOf(filteredB), idsOf(filteredA));
  } finally {
    withVec.close();
    without.close();
  }
});

test('降级路径的向量能落盘并在"重启"后读回来', async () => {
  // 用文件库模拟进程重启：第二次 createVectorStore 只能从落盘表恢复
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-t6-fb-'));
  const dbPath = join(dir, 'memory.db');

  try {
    // 第一次：不加载 vec0，索引 20 条
    const first = openDb({ dbPath, loadVec: false, logger: silent });
    const store1 = createVectorStore(first, { dim: DIM, logger: silent });
    const repo1 = createRepo(first);
    const { msgs, vectors } = seedMsgs({ repo: repo1, count: 20 });
    store1.insertMsgVecs(vectors);
    assert.equal(store1.stats().fallbackPersisted, true, '降级向量本该落盘');

    const q = textToVector(msgs[5].text, DIM);
    const before = idsOf(store1.knnMsg(q, 3));
    first.close();

    // 第二次：同一个库文件，重开（内存索引是空的，只能靠落盘表）
    const second = openDb({ dbPath, loadVec: false, logger: silent });
    const store2 = createVectorStore(second, { dim: DIM, logger: silent });
    assert.equal(store2.countMsgVec(), 20, '重启后应从落盘表读回 20 条向量');
    assert.deepEqual(idsOf(store2.knnMsg(q, 3)), before, '重启后结果应完全一致');
    second.close();
  } finally {
    // Windows 上文件句柄释放略有延迟，清理失败不该影响测试结论
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

test('维度对不上要立刻报清楚（D-152 同源问题）', withDb(async ({ handle }) => {
  // 库里 vec_msg 是 float[1024]，想要 512 维必须报错，而不是悄悄写出无意义向量
  assert.throws(() => createVectorStore(handle, { dim: 512 }), /维度不一致/);

  // 传错长度的向量也要给人话
  const store = createVectorStore(handle, { dim: DIM });
  assert.throws(() => store.insertMsgVec(1, [1, 2, 3]), /维度不对/);
}));

test('分数换算：L2 距离 ↔ 余弦在单位向量下互换', () => {
  for (const cos of [1, 0.5, 0, -0.5, -1]) {
    const d = Math.sqrt(2 - 2 * cos);
    assert.ok(Math.abs(distanceToScore(d) - cos) < 1e-9, `cos=${cos} 换算应还原`);
  }
});
