import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './store/db.js';
import { createExtras, createRepo } from './store/repo.js';
import { createPanelApi } from '../index.js';
import { rebuildScenesForSession } from './pipeline.js';

const MIN = 60_000;
const T0 = 1_760_000_000_000;

function makeEnv(extraOpts = {}) {
  const handle = openDb({ dbPath: ':memory:' });
  const repo = createRepo(handle);
  const extras = createExtras(handle);
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verbatim-feat-'));
  const api = createPanelApi({
    handle,
    repo,
    extras,
    dbPath: ':memory:',
    dshHome,
    logger: { info() {}, warn() {}, error() {} },
    ...extraOpts,
  });
  return {
    handle,
    repo,
    extras,
    dshHome,
    api,
    cleanup() {
      handle.close();
      fs.rmSync(dshHome, { recursive: true, force: true });
    },
  };
}

test('模块 2+1：mergeScene / splitScene / refineOneScene + llmGistRatio + pendingMsgs + recallLog', async () => {
  const recallLog = [{ id: 'rc-1', at: T0, sessionId: 's1', query: '测试', elapsedMs: 12, resultChars: 100, counts: { keyword: 2, vector: 1 }, reranked: true, hitScenes: [] }];
  const mockHostLlm = {
    listProviders: async () => [{ id: 'mock', name: 'Mock' }],
    listModels: async () => [{ id: 'mock-llm', name: 'Mock LLM' }],
    async *stream() {
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          gist: '【发生了什么】讨论了场景合并与拆分方案并锁定边界【原话】「第二场消息一，隔了一个小时开始新话题」【不懂的】无',
        }),
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const env = makeEnv({
    recallLog,
    getHostLlm: () => mockHostLlm,
    config: { llm: { enabled: true, provider: 'mock', model: 'mock-llm' } },
  });
  try {
    const sid = 's1';
    env.repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '第一场消息一，准备测试场景合并与拆分' },
      { sessionId: sid, seq: 2, at: T0 + 2 * MIN, speaker: 'assistant', text: '好的，第一场消息二' },
      { sessionId: sid, seq: 3, at: T0 + 60 * MIN, speaker: 'user', text: '第二场消息一，隔了一个小时开始新话题' },
      { sessionId: sid, seq: 4, at: T0 + 62 * MIN, speaker: 'assistant', text: '第二场消息二，准备一会儿切分' },
    ]);
    rebuildScenesForSession({ repo: env.repo, extras: env.extras, sessionId: sid, db: env.handle.db });
    // 再插入一条未归场消息，验证 timeline.pendingMsgs
    env.repo.insertMsgs([
      { sessionId: sid, seq: 5, at: T0 + 120 * MIN, speaker: 'user', text: '刚发的一条进行中消息' },
    ]);

    const tl1 = await env.api.call('timeline', { sessionId: sid });
    assert.equal(tl1[0].scenes.length, 2);
    assert.equal(tl1[0].pendingMsgs, 1);

    const sc2Id = tl1[0].scenes[1].id;
    // ① 单场 LLM 重摘 + status.llmGistScenes/Ratio
    const refined = await env.api.call('refineOneScene', { sessionId: sid, sceneId: sc2Id });
    assert.equal(refined.ok, true);
    assert.equal(refined.gistSource, 'llm');
    const st = await env.api.call('status', { sessionId: sid });
    assert.equal(st.stats.llmGistScenes, 1);
    assert.equal(st.stats.llmGistRatio, 50);

    // ② 合并第 2 场到第 1 场
    const merged = await env.api.call('mergeScene', { sessionId: sid, sceneId: sc2Id });
    assert.equal(merged.ok, true);
    assert.equal(merged.msgCount, 4);
    const detail = await env.api.call('sceneDetail', { sceneId: merged.mergedSceneId });
    assert.equal(detail.locked, true);
    assert.equal(detail.msgs.length, 4);

    // ③ 在第 3 条消息处拆分回 2 场
    const splitRes = await env.api.call('splitScene', {
      sessionId: sid,
      sceneId: merged.mergedSceneId,
      atMsgId: detail.msgs[2].id,
    });
    assert.equal(splitRes.ok, true);
    assert.equal(splitRes.leftCount, 2);
    assert.equal(splitRes.rightCount, 2);

    // ④ 召回轨迹 recallLog
    const rc = await env.api.call('recallLog', { sessionId: sid });
    assert.equal(rc.items.length, 1);
    assert.equal(rc.items[0].reranked, true);

    // ⑤ 手动改摘要（manual）+ 锁定钉子经受全量重切保护 + 单条消息屏蔽 + 编辑笔记
    const manualRes = await env.api.call('setSceneGist', {
      sessionId: sid,
      sceneId: splitRes.leftSceneId,
      gist: '人工定稿的珍贵摘要',
    });
    assert.equal(manualRes.gistSource, 'manual');

    // 全量重切：锁定场景边界和 manual 摘要均保持不动
    rebuildScenesForSession({ repo: env.repo, extras: env.extras, sessionId: sid, db: env.handle.db });
    const afterRebuild = env.repo.scenesByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 50);
    assert.equal(afterRebuild[0].locked, 1);
    assert.equal(afterRebuild[0].gist, '人工定稿的珍贵摘要');
    assert.equal(afterRebuild[0].gistSource, 'manual');

    // 单条消息屏蔽并同步 scene.excludedCount
    const firstMsgId = detail.msgs[0].id;
    const muteRes = await env.api.call('setMsgExcluded', { sessionId: sid, msgId: firstMsgId, excluded: true });
    assert.equal(muteRes.excluded, 1);
    const scAfterMute = env.repo.scenesByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 50)[0];
    assert.equal(scAfterMute.excludedCount, 1);

    // 直接编辑笔记
    const nid = env.extras.note.insert({ sessionId: sid, content: '旧笔记内容', about: 'him', at: T0 });
    const updNote = await env.api.call('updateNote', { sessionId: sid, id: nid, content: '新笔记内容' });
    assert.equal(updNote.content, '新笔记内容');
    assert.equal(env.extras.note.byId(nid, { sessionId: sid }).content, '新笔记内容');
  } finally {
    env.cleanup();
  }
});

test('模块 4+5：mediaPreview + findDuplicateNotes/mergeNotes + dbMaintain(importSession/clearSession)', async () => {
  const env = makeEnv();
  try {
    const sid = 's2';
    // 准备一个临时 1x1 PNG 验证 mediaPreview
    const imgPath = path.join(env.dshHome, 'dot.png');
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    env.repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '[图片]' },
    ]);
    env.extras.media.replaceForSession(sid, [{ seq: 1, at: T0, path: imgPath, width: 1, height: 1 }]);
    const msgRow = env.repo.msgsByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 10, true)[0];
    const md = env.extras.media.byMsgIds([msgRow.id]).get(msgRow.id)[0];

    const pv = await env.api.call('mediaPreview', { id: md.id });
    assert.equal(pv.ok, true);
    assert.ok(pv.dataUrl.startsWith('data:image/png;base64,'));

    // 笔记去重与合并
    env.extras.note.insert({ sessionId: sid, content: '他非常喜欢喝冰美式咖啡，不加糖不加奶', about: 'him', at: T0 });
    env.extras.note.insert({ sessionId: sid, content: '他非常喜欢喝冰美式咖啡，不加糖也不加奶', about: 'him', at: T0 + 1000 });
    env.extras.note.insert({ sessionId: sid, content: '周末要去公园散步拍照', about: 'us', at: T0 + 2000 });

    const dups = await env.api.call('findDuplicateNotes', { sessionId: sid });
    assert.equal(dups.groups.length, 1);
    const merged = await env.api.call('mergeNotes', {
      sessionId: sid,
      keepId: dups.groups[0].keep.id,
      dropIds: dups.groups[0].duplicates.map((d) => d.id),
    });
    assert.equal(merged.ok, true);
    assert.equal(merged.dropped, 1);
    assert.equal(env.extras.note.list({ sessionId: sid }).length, 2);

    // 导出 -> 清空 -> 从 JSON 恢复闭环
    const exported = await env.api.call('dbMaintain', { action: 'exportSession', sessionId: sid });
    assert.equal(exported.counts.msgs, 1);
    assert.equal(exported.counts.notes, 2);

    const cleared = await env.api.call('dbMaintain', { action: 'clearSession', sessionId: sid });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.deleted.msgs, 1);
    assert.equal(env.repo.msgsByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 10, true).length, 0);

    const imported = await env.api.call('dbMaintain', { action: 'importSession', payload: exported });
    assert.equal(imported.ok, true);
    assert.equal(imported.imported.msgs, 1);
    assert.equal(imported.imported.notes, 2);
    assert.equal(env.repo.msgsByTimeRange(sid, 0, Number.MAX_SAFE_INTEGER, 10, true).length, 1);
  } finally {
    env.cleanup();
  }
});
