import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './store/db.js';
import { createExtras, createRepo } from './store/repo.js';
import { syncScenesForSession } from './pipeline.js';

const MIN = 60_000;
const T0 = 1_760_000_000_000;

function makeStore() {
  const handle = openDb({ dbPath: ':memory:' });
  const repo = createRepo(handle);
  const extras = createExtras(handle);
  return { handle, repo, extras };
}

test('syncScenesForSession：稳定时间窗（<30m 暂不封场）→ 沉淀后自动成场且旧场 id/gist 不变', () => {
  const { handle, repo, extras } = makeStore();
  try {
    const sid = 'sess-inc-1';
    repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '早安，今天天气不错' },
      { sessionId: sid, seq: 2, at: T0 + 2 * MIN, speaker: 'assistant', text: '早安！今天打算做什么呢？' },
      // 隔了 60 分钟的新活跃对话，距 now 仅 5 分钟
      { sessionId: sid, seq: 3, at: T0 + 62 * MIN, speaker: 'user', text: '刚打开电脑准备写代码' },
      { sessionId: sid, seq: 4, at: T0 + 64 * MIN, speaker: 'assistant', text: '好，我们先理一下模块' },
    ]);

    const now1 = T0 + 69 * MIN;
    const r1 = syncScenesForSession({ repo, extras, sessionId: sid, db: handle.db, now: now1 });
    assert.equal(r1.scenes, 1, '只有前一场已沉淀，末尾活跃 2 条暂不封场');
    assert.equal(r1.pendingMsgs, 2);

    const scBefore = repo.scenesByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 100);
    assert.equal(scBefore.length, 1);
    const oldSceneId = scBefore[0].id;
    repo.setSceneGist(oldSceneId, '自定义 LLM 精炼摘要');

    // 时间推进 35 分钟，第二场也沉淀了
    const now2 = T0 + 100 * MIN;
    const r2 = syncScenesForSession({ repo, extras, sessionId: sid, db: handle.db, now: now2 });
    assert.equal(r2.scenes, 2);
    assert.equal(r2.pendingMsgs, 0);
    assert.equal(r2.scenesAdded, 1);

    const scAfter = repo.scenesByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 100);
    assert.equal(scAfter[0].id, oldSceneId, '旧稳定场景 id 必须完全不变');
    assert.equal(scAfter[0].gist, '自定义 LLM 精炼摘要', '旧稳定场景 gist 绝不被覆盖');
    assert.equal(scAfter[1].precededBy, oldSceneId, '新场应正确链接到前一场');
  } finally {
    handle.close();
  }
});

test('syncScenesForSession：compaction 原地刷新派生列 + rewind 只重整受影响场景', () => {
  const { handle, repo, extras } = makeStore();
  try {
    const sid = 'sess-inc-2';
    repo.insertMsgs([
      // 场 1：seq 1..2
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '第一场开头，聊点别的' },
      { sessionId: sid, seq: 2, at: T0 + 2 * MIN, speaker: 'assistant', text: '好的，第一场回应' },
      // 场 2（隔 60m）：seq 3..5
      { sessionId: sid, seq: 3, at: T0 + 62 * MIN, speaker: 'user', text: '第二场开始了，我们继续讨论今天的任务安排吧' },
      { sessionId: sid, seq: 4, at: T0 + 64 * MIN, speaker: 'assistant', text: '第二场中间这句待会儿会被撤回' },
      { sessionId: sid, seq: 5, at: T0 + 66 * MIN, speaker: 'user', text: '第二场末尾' },
      // 场 3（再隔 60m）：seq 6..7
      { sessionId: sid, seq: 6, at: T0 + 126 * MIN, speaker: 'user', text: '第三场，这是一个完全独立的新话题讨论' },
      { sessionId: sid, seq: 7, at: T0 + 128 * MIN, speaker: 'assistant', text: '第三场回复' },
    ]);

    const now = T0 + 200 * MIN;
    const r1 = syncScenesForSession({ repo, extras, sessionId: sid, db: handle.db, now });
    assert.equal(r1.scenes, 3);
    const sc1 = repo.scenesByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 100);
    const id1 = sc1[0].id;
    const id2 = sc1[1].id;
    const id3 = sc1[2].id;
    repo.setSceneGist(id1, '第一场 LLM 摘要');

    // ① 模拟上下文压缩：场 1 的 seq 1 被压出上下文
    repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '第一场开头，聊点别的', inSurface: 0, compactedAt: T0 + 150 * MIN },
    ]);
    const rComp = syncScenesForSession({ repo, extras, sessionId: sid, db: handle.db, now });
    assert.equal(rComp.derivedUpdated, 1, '应原地刷新场 1 的压缩派生列');
    assert.equal(rComp.scenesAdded, 0);
    const scAfterComp = repo.scenesByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 100);
    assert.equal(scAfterComp[0].id, id1);
    assert.equal(scAfterComp[0].gist, '第一场 LLM 摘要');
    assert.equal(scAfterComp[0].outOfSurfaceCount, 1);
    assert.equal(scAfterComp[0].crossesCompaction, 1);

    // ② 模拟 rewind：撤回场 2 中的 seq 4
    repo.deleteMsgsBySeqs(sid, [4]);
    const rRewind = syncScenesForSession({ repo, extras, sessionId: sid, db: handle.db, now });
    assert.equal(rRewind.scenes, 3);
    const scAfterRewind = repo.scenesByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 100);
    // 场 2 被重切（新 id，msgCount 变为 2），场 3 也在其后被连带重切
    assert.equal(scAfterRewind[1].msgCount, 2);
    assert.notEqual(scAfterRewind[1].id, id2);
    assert.notEqual(scAfterRewind[2].id, id3);
    // 而场 1 只是被重新检查/链接，若 cutFromIdx = 0 也有快照复用保留其 LLM 摘要
    assert.equal(scAfterRewind[0].gist, '第一场 LLM 摘要');
  } finally {
    handle.close();
  }
});
