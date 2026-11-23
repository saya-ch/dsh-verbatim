/**
 * 自适应场景内滑动对话窗（Window）单元测试与端到端检索集成测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../store/db.js';
import { createExtras, createRepo } from '../store/repo.js';
import { createVectorStore, DEFAULT_DIM } from './vector-store.js';
import { createIndexer } from './indexer.js';
import { buildSceneWindows, buildShortContext, hasWindowCoverage, WINDOW_SKIP_MSG_CHARS } from './window.js';
import { dedupeBySpan, createSpanIndex, mergeKeywordHits } from './dedupe.js';
import { rebuildScenesForSession } from '../pipeline.js';
import { createSearchTool } from '../tools/memory-search.js';

const BASE = Date.parse('2026-11-18T20:00:00+08:00');

function unitVec(axis, dim = DEFAULT_DIM) {
  const v = new Float32Array(dim);
  v[axis % dim] = 1;
  return v;
}

function makeMsg(id, seq, offsetSec, speaker, text, extra = {}) {
  return {
    id,
    sessionId: 'sess-w',
    seq,
    at: BASE + offsetSec * 1000,
    speaker,
    text,
    excluded: 0,
    ...extra,
  };
}

test('buildSceneWindows：短消息聚合成重叠窗口，长消息（>=400字）跳过并自然断窗', () => {
  const longText = '这是一段很长的技术架构说明。'.repeat(40); // > 400 字
  assert.ok(longText.length >= WINDOW_SKIP_MSG_CHARS);

  const msgs = [
    makeMsg(1, 1, 0, 'user', '我昨天带着橘猫去检查'),
    makeMsg(2, 2, 15, 'assistant', '怎么啦，它不舒服吗？'),
    makeMsg(3, 3, 30, 'user', '结果那家宠物医院关门了'),
    makeMsg(4, 4, 45, 'assistant', '那后来换了别家吗？'),
    makeMsg(5, 5, 60, 'user', longText),
    makeMsg(6, 6, 90, 'user', '顺便晚上去吃了重庆火锅'),
    makeMsg(7, 7, 110, 'assistant', '辣不辣，点微辣了吗？'),
  ];

  const wins = buildSceneWindows(msgs, { sceneId: 10, sessionId: 'sess-w', targetChars: 60 });
  assert.ok(wins.length >= 2, '前后两段短消息都应成窗');
  // 长消息 #5 绝对不出现在任何窗口里
  for (const w of wins) {
    assert.ok(!w.text.includes('技术架构说明'), '长消息不应被塞进短消息滑窗');
    assert.ok(w.startMsgId !== 5 && w.endMsgId !== 5);
    assert.ok(w.msgCount >= 2);
  }
  // 后半段短消息 (#6, #7) 独立成窗
  const last = wins[wins.length - 1];
  assert.equal(last.startMsgId, 6);
  assert.equal(last.endMsgId, 7);
  assert.match(last.text, /你：顺便晚上去吃了重庆火锅/);
  assert.match(last.text, /TA：辣不辣，点微辣了吗/);
});

test('buildSceneWindows：纯长文本对话生成 0 个窗口（完全保留 vec_msg/vec_chunk 泛用性）', () => {
  const longA = '第一段长文分析：'.repeat(60);
  const longB = '第二段详细回复：'.repeat(60);
  const msgs = [
    makeMsg(1, 1, 0, 'user', longA),
    makeMsg(2, 2, 60, 'assistant', longB),
  ];
  const wins = buildSceneWindows(msgs, { sceneId: 11, sessionId: 'sess-w' });
  assert.equal(wins.length, 0);
});

test('buildSceneWindows：excluded=1 消息不入窗且自动断窗，>10m 间隔也断窗', () => {
  const msgs = [
    makeMsg(1, 1, 0, 'user', '第一段第一句聊天气不错'),
    makeMsg(2, 2, 10, 'assistant', '是啊阳光特别暖和'),
    makeMsg(3, 3, 20, 'user', '这条是被排除的隐私内容', { excluded: 1 }),
    makeMsg(4, 4, 30, 'user', '被排除后只有孤立一句'),
    makeMsg(5, 5, 900, 'user', '十五分钟后聊新话题咖啡'),
    makeMsg(6, 6, 910, 'assistant', '我也想喝一杯手冲耶加雪菲'),
  ];
  const wins = buildSceneWindows(msgs, { sceneId: 12, sessionId: 'sess-w' });
  assert.equal(wins.length, 2);
  assert.equal(wins[0].startMsgId, 1);
  assert.equal(wins[0].endMsgId, 2);
  assert.equal(wins[1].startMsgId, 5);
  assert.equal(wins[1].endMsgId, 6);
  for (const w of wins) {
    assert.ok(!w.text.includes('隐私内容'));
  }
});

test('端到端：跨句多词关键词命中 + vec_window 语义命中 + 长消息 vec_msg 保留 + 上下文感知 Rerank', async () => {
  const handle = openDb({ dbPath: ':memory:' });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    const sid = 'sess-win-e2e';
    const longAnalysis = '关于分布式共识与 SQLite WAL 并发锁机制的深度排查记录：'.repeat(16); // > 400 字

    const rawMsgs = [
      { seq: 1, at: BASE + 0, speaker: 'user', text: '我昨天抱着橘猫出门' },
      { seq: 2, at: BASE + 15_000, speaker: 'assistant', text: '它有没有在包里一直叫？' },
      { seq: 3, at: BASE + 30_000, speaker: 'user', text: '结果楼下那家医院居然关门了' },
      { seq: 4, at: BASE + 45_000, speaker: 'assistant', text: '那你们白跑一趟啦，真折腾' },
      { seq: 5, at: BASE + 70_000, speaker: 'user', text: longAnalysis },
    ];
    for (const m of rawMsgs) {
      repo.insertMsg({ sessionId: sid, inSurface: 1, excluded: 0, ...m });
    }

    // 切场自动建 window
    const scRes = rebuildScenesForSession({ repo, extras, sessionId: sid, db: handle.db });
    assert.equal(scRes.scenes, 1);
    assert.ok(scRes.windowsBuilt >= 1, '应为前 4 条短消息建出滑动对话窗');
    assert.equal(extras.window.count({ sessionId: sid }), scRes.windowsBuilt);

    // 1) 跨句多词关键词检索（“橘猫”在 seq=1，“医院”在 seq=3，单条 msg 均不同时包含两词）
    const kwTool = createSearchTool({ repo, extras, handle, sessionId: sid, semantic: false, now: BASE + 3600_000 });
    const kwOut = await kwTool.handler({ query: '橘猫 医院' });
    assert.match(kwOut, /橘猫/);
    assert.match(kwOut, /医院/);

    // 2) 向量索引（同时建立 vec_msg + vec_window）
    //    - 模拟场景：单句向量的方向都偏离查询（轴 1），而对话窗向量精准对齐查询（轴 0）；
    //    - 长消息 seq=5 对齐轴 2（验证长消息依然走 vec_msg 正常召回）
    const provider = {
      id: 'mock-win@1024',
      dim: DEFAULT_DIM,
      maxBatch: 16,
      async embed(texts) {
        return texts.map((t) => {
          const s = String(t);
          if (s.includes('带猫看病跑空') || (s.includes('橘猫') && s.includes('医院'))) {
            return unitVec(0);
          }
          if (s.includes('WAL 并发锁') || s.includes('SQLite 锁机制')) {
            return unitVec(2);
          }
          return unitVec(1);
        });
      },
    };
    const store = createVectorStore(handle, { dim: DEFAULT_DIM });
    const indexer = createIndexer({ handle, provider, extras, store });
    await indexer.indexPending({ sessionId: sid });
    const winIdx = await indexer.indexPendingWindows({ sessionId: sid });
    assert.equal(winIdx.indexed, scRes.windowsBuilt);
    assert.equal(store.countWindowVec(), scRes.windowsBuilt);

    // 2a) vec_window 命中“带猫看病跑空”（单条 msg 均不在轴 0，只有合窗在轴 0！）
    const rerankCalls = [];
    const mockReranker = {
      model: 'mock-rerank',
      async rerank(q, docs) {
        rerankCalls.push({ q, docs });
        return docs.map((_, i) => ({ index: i, score: 0.9 - i * 0.05 }));
      },
    };
    const vecTool = createSearchTool({
      repo,
      extras,
      handle,
      sessionId: sid,
      provider,
      store,
      reranker: mockReranker,
      now: BASE + 3600_000,
    });
    const vecOut = await vecTool.handler({ query: '带猫看病跑空' });
    assert.match(vecOut, /橘猫/);
    assert.match(vecOut, /医院/);

    // 2b) 长消息依然走 vec_msg 精准召回（泛用性不受影响）
    const longOut = await vecTool.handler({ query: 'SQLite 锁机制' });
    assert.match(longOut, /WAL 并发锁/);

    // 2c) 验证上下文感知 Rerank：当有 >=2 条候选时，reranker 收到的是完整多句对话窗文本而非孤立短句
    await vecTool.handler({ query: '橘猫 医院' });
    if (rerankCalls.length > 0) {
      const joined = rerankCalls[rerankCalls.length - 1].docs.join('\n---\n');
      assert.match(joined, /你：.*橘猫/);
      assert.match(joined, /医院/);
    }

    // 3) 重建场景清理旧 window 与 vec_window，不留孤儿
    extras.sceneAssign.clear(sid);
    assert.equal(extras.window.count({ sessionId: sid }), 0);
    assert.equal(store.countWindowVec(), 0);
  } finally {
    handle.close();
  }
});

test('dedupeBySpan：重叠窗口去重 + 点落入窗吸收 + 跨路共振 + 同场不相交段保留', () => {
  const vecInput = [
    { id: 101, sceneId: 50, score: 0.82, window: { id: 1, startMsgId: 101, endMsgId: 105, msgCount: 5, text: 'A' } },
    { id: 103, sceneId: 50, score: 0.78, window: { id: 2, startMsgId: 103, endMsgId: 106, msgCount: 4, text: 'B' } },
    { id: 140, sceneId: 50, score: 0.75, window: { id: 3, startMsgId: 140, endMsgId: 144, msgCount: 5, text: 'C' } },
    { id: 103, sceneId: 50, score: 0.70 },
  ];

  // 1) 默认：合并重叠区间，但**保持主项原分数与次序**（394 题实测：抬分会让精确短句从 #1 掉到 #2）
  const vecOut = dedupeBySpan(vecInput, { mode: 'score' });
  assert.equal(vecOut.length, 2, '同一段的三条重叠命中应合并为 1 条，不相交段 #140..#144 应保留');
  assert.equal(vecOut[0].id, 101);
  assert.equal(vecOut[0].score, 0.82, '默认不抬分');
  assert.deepEqual(vecOut[0].matchedMsgIds.sort((a, b) => a - b), [101, 103]);
  assert.equal(vecOut[1].id, 140);

  // 1b) 显式 aggregate:true 才启用微幅聚合提权
  const boosted = dedupeBySpan(vecInput, { mode: 'score', aggregate: true });
  assert.equal(boosted.length, 2);
  assert.ok(boosted[0].score > 0.82, 'aggregate:true 时多条独立证据带来微幅提权');

  // 2) createSpanIndex：跨路重叠区间在**两路里是同一个 key**，让 RRF 组内求和而不是拆散
  const kwRow = { id: 103, sceneId: 50, sources: ['keyword'] };
  const vecWin = { id: 101, sceneId: 50, sources: ['vector'], score: 0.85, window: { id: 1, startMsgId: 101, endMsgId: 105, msgCount: 5, text: 'A' } };
  const idx = createSpanIndex([[kwRow], [vecWin]]);
  assert.equal(idx.groupCount, 1, '重叠区间应并成 1 组');
  assert.equal(idx.keyOf(kwRow), idx.keyOf(vecWin), '同一区间的两路命中必须同 key');

  // 3) 关键词多词合并：同时含两词的对话窗排在单字 OR 单句之前，并吸收区间内单句
  const kwMerged = mergeKeywordHits(
    [
      { id: 101, sceneId: 50, text: '我昨天抱着橘猫出门' },
      { id: 103, sceneId: 50, text: '楼下那家医院关门了' },
      { id: 201, sceneId: 60, text: '今天去医院体检' },
    ],
    [
      { id: 101, sceneId: 50, text: '我昨天抱着橘猫出门', window: { id: 1, startMsgId: 101, endMsgId: 104, msgCount: 4, text: '你：我昨天抱着橘猫出门\n你：楼下那家医院关门了' } },
    ],
    ['橘猫', '医院'],
  );
  assert.equal(kwMerged.length, 2, '窗口吸收 #101 和 #103，另一场 #201 保留');
  assert.equal(kwMerged[0].id, 101);
  assert.ok(kwMerged[0].window, '排第一的应是同时命中两词的对话窗');
  assert.equal(kwMerged[1].id, 201);
});

test('window.searchKeyword 已删除（与 vec_window 功能重叠）', () => {
  const handle = openDb({ dbPath: ':memory:' });
  try {
    const extras = createExtras(handle);
    assert.equal(
      typeof extras.window.searchKeyword,
      'undefined',
      'searchKeyword 应当已删除：它召回的窗口语义已被 vec_window 覆盖。',
    );
    // 其余窗口能力必须完好
    assert.equal(typeof extras.window.byScene, 'function');
    assert.equal(typeof extras.window.replaceForScene, 'function');
    assert.equal(typeof extras.window.pending, 'function');
  } finally {
    handle.close();
  }
});

test('hasWindowCoverage / buildShortContext：只有落单短句才补上下文', () => {
  const longText = '这是一段很长的技术过程记录。'.repeat(40); // > 400 字
  assert.ok(longText.length >= WINDOW_SKIP_MSG_CHARS);

  // 场景 A：短—长—短（短句被长消息隔开，各自落单）
  const sceneA = [
    makeMsg(11, 1, 0, 'user', '先把这版推上去'),
    makeMsg(12, 2, 30, 'assistant', longText),
    makeMsg(13, 3, 60, 'assistant', '已推送 ccf9c89'),
  ];
  assert.equal(hasWindowCoverage(sceneA[0], sceneA), false, '#11 后邻是长消息 → 落单');
  assert.equal(hasWindowCoverage(sceneA[2], sceneA), false, '#13 前邻是长消息 → 落单（R2-fact 惨案原型）');
  const ctx = buildShortContext(sceneA[2], sceneA);
  assert.ok(ctx, '落单短句要补出上下文');
  assert.ok(ctx.includes('已推送 ccf9c89'), '锚点自己必须全文在');
  assert.ok(ctx.includes('先把这版推上去') || ctx.includes('技术过程记录'), '邻居要带上（长邻居截断也算带上）');
  assert.ok(!ctx.includes(longText), '长邻居必须截断，不能全文塞进向量');

  // 场景 B：连续短串（深处有窗口覆盖，不补）
  const sceneB = [
    makeMsg(21, 1, 0, 'user', '想听妈妈唱摇篮曲'),
    makeMsg(22, 2, 15, 'assistant', '好呀，唱哪一首呢'),
    makeMsg(23, 3, 30, 'user', '就唱那首小星星吧'),
  ];
  assert.equal(hasWindowCoverage(sceneB[1], sceneB), true, '短串深处 → 有覆盖');
  assert.equal(buildShortContext(sceneB[1], sceneB), null, '有覆盖的不补（避免与窗口向量重复）');

  // 场景 C：单条孤立短句
  const sceneC = [makeMsg(31, 1, 0, 'user', '已推送 ccf9c89')];
  assert.equal(hasWindowCoverage(sceneC[0], sceneC), false, '孤立单条 → 落单');
  const ctxC = buildShortContext(sceneC[0], sceneC);
  assert.ok(ctxC && ctxC.includes('已推送 ccf9c89'), '孤立短句至少带上自己（加说话人前缀）');

  // 场景 D：被排除的邻居不算数
  const sceneD = [
    makeMsg(41, 1, 0, 'user', '上下文A', { excluded: 1 }),
    makeMsg(42, 2, 15, 'assistant', '落单句'),
  ];
  assert.equal(hasWindowCoverage(sceneD[1], sceneD), false, '被排除的邻居不能算覆盖');
  assert.ok(!String(buildShortContext(sceneD[1], sceneD)).includes('上下文A'), '上下文不能泄露被排除内容');

  // 场景 E：长消息自足
  assert.equal(hasWindowCoverage({ ...sceneA[1] }, sceneA), true, '≥400 字长消息自足（由 vec_msg/chunk 负责）');
});
