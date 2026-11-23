/**
 * panel-ux.test.js —— 面板 UX 升级端到端回归测试
 *
 * 覆盖本次新增的 3 个面板 RPC 及其会话隔离、数据同步与参数校验：
 *   1. panel.search          关键词（2 字 LIKE / ≥3 字 FTS）+ 压缩内容 + when 组合 + excluded 过滤 + 混合检索/空索引跳过
 *   2. panel.deletedNotes    软删列表（deletedAt/expiresAt）+ 会话隔离 + restoreNote 恢复 + 超 30 天自动物理清理
 *   3. panel.setExcludeRanges 写回 sessions/<id>.json + 立即同步 msg.excluded / scene 计数 + 空数组恢复 + BAD_EXCLUDE_RANGE
 *
 * 安全：全部使用 `:memory:` 库与 `os.tmpdir()` 临时目录，绝不碰真实 `$DSH_HOME`。
 *
 * 跑法：
 *   node --test src/panel-ux.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from './store/db.js';
import { createRepo, createExtras } from './store/repo.js';
import { createVectorStore } from './search/vector-store.js';
import { createIndexer } from './search/indexer.js';
import { createSiliconFlowEmbedding } from './model/embedding.js';
import { textToVector } from './model/mock.js';
import { saveGlobalConfig, llmReady, rerankReady } from './config/global-config.js';
import { createDeepSeekLlm } from './model/llm.js';
import { createReranker } from './model/rerank.js';
import { loadSessionConfig } from './config/session-config.js';
import { createPanelApi, PanelError } from '../index.js';
import { buildExtractiveGist, gistHeadline } from './derive/gist.js';
import { createSearchTool } from './tools/memory-search.js';
import { NOTE_MIN_SCORE_DEFAULT, searchRankedNotes } from './search/note-rank.js';
import { rebuildScenesForSession } from './pipeline.js';
import { mediaBlocksOf } from './ingest/export.js';

const DIM = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const silent = { warn() {}, info() {}, error() {} };

/** 上海时间（UTC+8）转 epoch ms（D-172） */
function sh(year, month, day, hour = 0, min = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, min);
}

/** 构造模拟 OpenAI /embeddings 的 fetch 实现 */
function fakeFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    calls.push({ url: String(url), model: body.model, inputs: inputs.slice() });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: inputs.map((text, index) => ({
            index,
            embedding: Array.from(textToVector(String(text), DIM)),
          })),
        };
      },
    };
  };
}

/** 创建隔离的临时环境（:memory: 库 + tmpdir 配置目录） */
function setupEnv({ config, syncSession } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-panel-ux-'));
  const dbRoot = path.join(dir, 'verbatim');
  fs.mkdirSync(dbRoot, { recursive: true });

  const handle = openDb({ dbPath: ':memory:', dshHome: dir, loadVec: false, logger: silent });
  const repo = createRepo(handle);
  const extras = createExtras(handle);
  const api = createPanelApi({
    handle,
    repo,
    extras,
    dbPath: ':memory:',
    dshHome: dir,
    dbRoot,
    config,
    syncSession,
    logger: silent,
  });

  return {
    dir,
    dbRoot,
    handle,
    repo,
    extras,
    api,
    cleanup() {
      try { handle.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 插入一场对话并返回 sceneId 与 msgIds */
function seedScene(repo, { sessionId, startAt, items, startSeq = 1 }) {
  const rows = items.map((item, idx) => {
    const obj = typeof item === 'string' ? { text: item } : item;
    return {
      sessionId,
      seq: startSeq + idx,
      at: obj.at ?? (startAt + idx * 60_000),
      speaker: obj.speaker ?? (idx % 2 === 0 ? 'user' : 'assistant'),
      text: obj.text,
      inSurface: obj.inSurface ?? 1,
      excluded: obj.excluded ?? 0,
    };
  });
  const sceneId = repo.insertScene({
    sessionId,
    startAt: rows[0].at,
    endAt: rows[rows.length - 1].at,
    msgCount: rows.length,
    leadIn: null,
  });
  const msgIds = repo.insertMsgs(rows.map((r) => ({ ...r, sceneId })));
  return { sceneId, msgIds, rows };
}

function hitsOf(res) {
  return Array.isArray(res) ? res : (res?.hits ?? res?.results ?? []);
}

function sourceOf(hit) {
  if (typeof hit?.source === 'string') return hit.source;
  if (Array.isArray(hit?.sources)) {
    const hasKw = hit.sources.includes('keyword') || hit.sources.includes('kw');
    const hasVec = hit.sources.includes('vector') || hit.sources.includes('vec');
    if (hasKw && hasVec) return 'kw+vec';
    if (hasVec) return 'vec';
    if (hasKw) return 'kw';
  }
  return '';
}

/* ══════════════════════════ 1. panel.search ══════════════════════════ */

test('panel.search：必填 sessionId 与非空 query（缺了报 400）', async () => {
  const env = setupEnv();
  try {
    await assert.rejects(
      () => env.api.call('search', { query: '怕黑' }),
      (e) => e instanceof PanelError && e.status === 400,
    );
    await assert.rejects(
      () => env.api.call('search', { sessionId: 'sess-a' }),
      (e) => e instanceof PanelError && e.status === 400,
    );
    await assert.rejects(
      () => env.api.call('search', { sessionId: 'sess-a', query: '   ' }),
      (e) => e instanceof PanelError && e.status === 400,
    );
  } finally {
    env.cleanup();
  }
});


test('panel.search：2 字 LIKE 与 ≥3 字 FTS 命中当前会话（含 inSurface=0 压缩内容）且严格会话隔离', async () => {
  const env = setupEnv();
  try {
    const t0 = sh(2026, 11, 9, 21, 0);
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: t0,
      items: [
        { text: '其实我有点怕黑，但不想开灯', inSurface: 0 },
        { text: '明天一起去天文馆看星星吧', inSurface: 1 },
      ],
    });
    seedScene(env.repo, {
      sessionId: 'sess-b',
      startAt: t0,
      items: [
        { text: '另一个会话也提到了怕黑和天文馆', inSurface: 1 },
      ],
    });

    // 2 字关键词走 LIKE，命中 sess-a 的 inSurface=0 压缩消息
    const r2 = await env.api.call('search', { sessionId: 'sess-a', query: '怕黑' });
    const h2 = hitsOf(r2);
    assert.equal(h2.length, 1);
    assert.equal(h2[0].text, '其实我有点怕黑，但不想开灯');
    assert.equal(h2[0].inSurface, 0);
    assert.ok(h2.every((h) => (h.sessionId ?? 'sess-a') === 'sess-a' && !h.text.includes('另一个会话')));

    // ≥3 字关键词走 FTS，同样只命中 sess-a
    const r3 = await env.api.call('search', { sessionId: 'sess-a', query: '天文馆' });
    const h3 = hitsOf(r3);
    assert.equal(h3.length, 1);
    assert.equal(h3[0].text, '明天一起去天文馆看星星吧');
    assert.ok(h3.every((h) => !h.text.includes('另一个会话')));
  } finally {
    env.cleanup();
  }
});


test('panel.search：支持 when 组合过滤，非法 when 报 400 BAD_WHEN', async () => {
  const env = setupEnv();
  try {
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 9, 10, 0),
      startSeq: 1,
      items: ['11-09 那天说怕黑'],
    });
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 15, 10, 0),
      startSeq: 10,
      items: ['11-15 那天也说怕黑'],
    });

    const filtered = await env.api.call('search', {
      sessionId: 'sess-a',
      query: '怕黑',
      when: '2026-11-09',
    });
    const hits = hitsOf(filtered);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].text, '11-09 那天说怕黑');

    await assert.rejects(
      () => env.api.call('search', { sessionId: 'sess-a', query: '怕黑', when: '不是合法时间' }),
      (e) => e instanceof PanelError && e.status === 400 && e.code === 'BAD_WHEN',
    );
  } finally {
    env.cleanup();
  }
});


test('panel.search：默认跳过 excluded=1，includeExcluded=true 时能搜到', async () => {
  const env = setupEnv();
  try {
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 8, 12, 0),
      items: [
        { text: '常规聊天记录', excluded: 0 },
        { text: '被排除的调试暗号', excluded: 1 },
      ],
    });

    const hidden = await env.api.call('search', { sessionId: 'sess-a', query: '调试暗号' });
    assert.equal(hitsOf(hidden).length, 0);

    const shown = await env.api.call('search', {
      sessionId: 'sess-a',
      query: '调试暗号',
      includeExcluded: true,
    });
    const hits = hitsOf(shown);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].text, '被排除的调试暗号');
    assert.equal(hits[0].excluded, 1);
  } finally {
    env.cleanup();
  }
});


test('panel.search：空索引跳过 embedding 返回 semantic.used=false；建索引 + mock embedding 走混合检索返回 semantic.used=true 与 kw+vec', async () => {
  const embedCalls = [];
  const fetchMock = fakeFetch(embedCalls);
  const env = setupEnv({
    config: {
      embedding: {
        mode: 'local',
        model: 'test-emb',
        dim: DIM,
        baseUrl: 'http://127.0.0.1:11434/v1',
        fetchImpl: fetchMock,
      },
    },
  });
  saveGlobalConfig({
    embedding: {
      mode: 'local',
      model: 'test-emb',
      dim: DIM,
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      apiKeyEnv: '',
    },
  }, { dshHome: env.dir });

  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 12, 14, 0),
      items: ['今天下雨不想出门', '晴天去公园散步'],
    });

    // ① 索引为空：必须跳过 embedding，返回 semantic.used = false
    const emptyRes = await env.api.call('search', {
      sessionId: 'sess-a',
      query: '今天下雨不想出门',
    });
    assert.equal(emptyRes.semantic?.used, false);
    assert.equal(embedCalls.length, 0, '空索引时绝不能发起 embedding 调用');
    assert.equal(hitsOf(emptyRes).length, 1);

    // ② 建好向量索引后：走混合检索，返回 semantic.used = true 与 kw+vec 来源
    const provider = createSiliconFlowEmbedding({
      mode: 'local',
      model: 'test-emb',
      dim: DIM,
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: '',
      fetchImpl: fakeFetch([]),
    });
    const store = createVectorStore(env.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({
      handle: env.handle,
      provider,
      extras: env.extras,
      store,
      logger: silent,
    });
    await indexer.indexMsgs(env.repo.msgsByTimeRange('sess-a', 0, Number.MAX_SAFE_INTEGER, 100));

    const hybridRes = await env.api.call('search', {
      sessionId: 'sess-a',
      query: '今天下雨不想出门',
    });
    assert.equal(hybridRes.semantic?.used, true);
    assert.ok(embedCalls.length >= 1, '有索引时应调用一次 embedding');
    const hit = hitsOf(hybridRes).find((h) => h.text === '今天下雨不想出门');
    assert.ok(hit, '应命中目标消息');
    assert.equal(sourceOf(hit), 'kw+vec');
  } finally {
    globalThis.fetch = origFetch;
    env.cleanup();
  }
});

/* ══════════════════ 2. panel.deletedNotes + restoreNote ══════════════════ */

test('panel.deletedNotes 与 restoreNote：会话隔离、deletedNotesCount、deletedAt/expiresAt、恢复清零', async () => {
  const env = setupEnv();
  try {
    const idA = env.extras.note.insert({
      sessionId: 'sess-a',
      content: '会话 A 的待删笔记',
      about: 'him',
      at: sh(2026, 11, 10, 9, 0),
    });
    const idB = env.extras.note.insert({
      sessionId: 'sess-b',
      content: '会话 B 的待删笔记',
      about: 'me',
      at: sh(2026, 11, 10, 9, 5),
    });

    // 软删 A 和 B 各一条
    const delA = await env.api.call('deleteNote', { id: idA, sessionId: 'sess-a', reason: '测试软删' });
    assert.equal(delA.ok, true);
    const delB = await env.api.call('deleteNote', { id: idB, sessionId: 'sess-b' });
    assert.equal(delB.ok, true);

    // panel.status.stats.deletedNotesCount 变为 1；panel.notes 看不到它
    const stA = await env.api.call('status', { sessionId: 'sess-a' });
    assert.equal(stA.stats.deletedNotesCount, 1);
    const liveA = await env.api.call('notes', { sessionId: 'sess-a' });
    assert.equal(liveA.length, 0);

    // panel.deletedNotes 列出且仅列出本会话的软删笔记，并带 deletedAt / expiresAt
    const trashA = await env.api.call('deletedNotes', { sessionId: 'sess-a' });
    assert.equal(trashA.total, 1);
    assert.equal(trashA.items.length, 1);
    assert.equal(trashA.items[0].id, idA);
    assert.equal(trashA.items[0].content, '会话 A 的待删笔记');
    assert.equal(typeof trashA.items[0].deletedAt, 'number');
    assert.equal(typeof trashA.items[0].expiresAt, 'number');
    assert.ok(trashA.items[0].expiresAt > trashA.items[0].deletedAt);
    assert.ok(trashA.items.every((n) => n.id !== idB), 'A 会话回收站绝不能看到 B 会话的已删笔记');

    // 跨会话恢复必须被拒绝
    await assert.rejects(
      () => env.api.call('restoreNote', { id: idB, sessionId: 'sess-a' }),
      (e) => e instanceof PanelError && e.status === 404,
    );

    // 恢复 A 的笔记：回到 panel.notes，回收站与计数清零
    const restored = await env.api.call('restoreNote', { id: idA, sessionId: 'sess-a' });
    assert.equal(restored.ok, true);

    const liveAfter = await env.api.call('notes', { sessionId: 'sess-a' });
    assert.equal(liveAfter.length, 1);
    assert.equal(liveAfter[0].id, idA);

    const trashAfter = await env.api.call('deletedNotes', { sessionId: 'sess-a' });
    assert.equal(trashAfter.total, 0);
    assert.equal(trashAfter.items.length, 0);

    const stAfter = await env.api.call('status', { sessionId: 'sess-a' });
    assert.equal(stAfter.stats.deletedNotesCount, 0);
  } finally {
    env.cleanup();
  }
});


test('panel.deletedNotes：超过 30 天的软删笔记在查询时自动物理清理', async () => {
  const env = setupEnv();
  try {
    const expiredId = env.extras.note.insert({
      sessionId: 'sess-a',
      content: '31 天前删掉的笔记',
      at: Date.now() - 40 * DAY_MS,
    });
    const freshId = env.extras.note.insert({
      sessionId: 'sess-a',
      content: '今天刚删的笔记',
      at: Date.now() - 2 * DAY_MS,
    });

    const now = Date.now();
    assert.equal(env.extras.note.softDelete(expiredId, now - 31 * DAY_MS, { sessionId: 'sess-a' }), true);
    assert.equal(env.extras.note.softDelete(freshId, now - 1000, { sessionId: 'sess-a' }), true);

    const trash = await env.api.call('deletedNotes', { sessionId: 'sess-a' });
    assert.equal(trash.total, 1);
    assert.equal(trash.items.length, 1);
    assert.equal(trash.items[0].id, freshId);
    assert.equal(env.extras.note.byId(expiredId), null, '超过 30 天的软删笔记应被自动物理清理');
    assert.ok(env.extras.note.byId(freshId), '30 天内的软删笔记应保留');
  } finally {
    env.cleanup();
  }
});


/* ══════════════════════ 3. panel.setExcludeRanges ══════════════════════ */

test('panel.setExcludeRanges：写回 sessions/<id>.json 并同步 msg.excluded 与 scene 排除计数，传 [] 立即恢复', async () => {
  const env = setupEnv();
  try {
    const s1 = seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 8, 10, 0),
      startSeq: 1,
      items: ['11-08 第一句', '11-08 第二句'],
    });
    const s2 = seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 10, 0),
      startSeq: 10,
      items: ['11-10 正常对话'],
    });
    const sOther = seedScene(env.repo, {
      sessionId: 'sess-b',
      startAt: sh(2026, 11, 8, 10, 0),
      startSeq: 1,
      items: ['另一个会话 11-08 的话'],
    });

    const setRes = await env.api.call('setExcludeRanges', {
      sessionId: 'sess-a',
      ranges: [{ from: '2026-11-08', to: '2026-11-09', reason: '调试期' }],
    });
    assert.equal(setRes.ok, true);

    // ① 配置文件已落盘
    const cfg = loadSessionConfig('sess-a', { dbRoot: env.dbRoot });
    assert.equal(cfg.excludeRanges.length, 1);
    assert.equal(cfg.excludeRanges[0].from, '2026-11-08');
    assert.equal(cfg.excludeRanges[0].to, '2026-11-09');
    assert.equal(cfg.excludeRanges[0].reason, '调试期');

    // ② 库里的 msg.excluded 与 scene.has_excluded / excluded_count 立刻同步
    const msgsA = env.repo.msgsByTimeRange('sess-a', 0, Number.MAX_SAFE_INTEGER, 100, true);
    assert.deepEqual(msgsA.map((m) => [m.seq, m.excluded]), [[1, 1], [2, 1], [10, 0]]);
    const scene1After = env.repo.sceneById(s1.sceneId);
    const scene2After = env.repo.sceneById(s2.sceneId);
    assert.equal(scene1After.hasExcluded, 1);
    assert.equal(scene1After.excludedCount, 2);
    assert.equal(scene2After.hasExcluded, 0);
    assert.equal(scene2After.excludedCount, 0);

    // ③ panel.status 的 excludeRanges 与 stats.excludedMsgs 立刻更新
    const stA = await env.api.call('status', { sessionId: 'sess-a' });
    assert.equal(stA.excludeRanges.length, 1);
    assert.equal(stA.stats.excludedMsgs, 2);

    // ④ 不影响其他会话
    const msgsB = env.repo.msgsByTimeRange('sess-b', 0, Number.MAX_SAFE_INTEGER, 100, true);
    assert.equal(msgsB[0].excluded, 0);
    assert.equal(env.repo.sceneById(sOther.sceneId).hasExcluded, 0);
    const stB = await env.api.call('status', { sessionId: 'sess-b' });
    assert.deepEqual(stB.excludeRanges, []);
    assert.equal(stB.stats.excludedMsgs, 0);

    // ⑤ 传空数组 [] 取消排除后，msg.excluded 与场景计数立刻恢复为 0
    const clearRes = await env.api.call('setExcludeRanges', {
      sessionId: 'sess-a',
      ranges: [],
    });
    assert.equal(clearRes.ok, true);

    const cfgCleared = loadSessionConfig('sess-a', { dbRoot: env.dbRoot });
    assert.deepEqual(cfgCleared.excludeRanges, []);
    const msgsCleared = env.repo.msgsByTimeRange('sess-a', 0, Number.MAX_SAFE_INTEGER, 100, true);
    assert.ok(msgsCleared.every((m) => m.excluded === 0));
    const scene1Cleared = env.repo.sceneById(s1.sceneId);
    assert.equal(scene1Cleared.hasExcluded, 0);
    assert.equal(scene1Cleared.excludedCount, 0);

    const stCleared = await env.api.call('status', { sessionId: 'sess-a' });
    assert.deepEqual(stCleared.excludeRanges, []);
    assert.equal(stCleared.stats.excludedMsgs, 0);
  } finally {
    env.cleanup();
  }
});


test('panel.setExcludeRanges：非法区间（非数组、to <= from）抛 400 BAD_EXCLUDE_RANGE', async () => {
  const env = setupEnv();
  try {
    await assert.rejects(
      () => env.api.call('setExcludeRanges', { ranges: [] }),
      (e) => e instanceof PanelError && e.status === 400,
    );
    await assert.rejects(
      () => env.api.call('setExcludeRanges', { sessionId: 'sess-a', ranges: 'not-an-array' }),
      (e) => e instanceof PanelError && e.status === 400 && e.code === 'BAD_EXCLUDE_RANGE',
    );
    await assert.rejects(
      () => env.api.call('setExcludeRanges', {
        sessionId: 'sess-a',
        ranges: [{ from: '2026-11-10', to: '2026-11-09' }],
      }),
      (e) => e instanceof PanelError && e.status === 400 && e.code === 'BAD_EXCLUDE_RANGE',
    );
    await assert.rejects(
      () => env.api.call('setExcludeRanges', {
        sessionId: 'sess-a',
        ranges: [{ from: '2026-11-09', to: '2026-11-09' }],
      }),
      (e) => e instanceof PanelError && e.status === 400 && e.code === 'BAD_EXCLUDE_RANGE',
    );
  } finally {
    env.cleanup();
  }
});

/* ══════════════════ 4. 实时增量索引（incremental）与任务进度 ══════════════════ */

test('extras.vecMeta.pending / countPending 支持 sessionId 隔离与 excluded 过滤', () => {
  const env = setupEnv();
  try {
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 9, 0),
      startSeq: 1,
      items: ['A1', 'A2'],
    });
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 9, 10),
      startSeq: 3,
      items: [{ text: 'A-excluded', excluded: 1 }],
    });
    seedScene(env.repo, {
      sessionId: 'sess-b',
      startAt: sh(2026, 11, 10, 9, 20),
      startSeq: 1,
      items: ['B1'],
    });

    assert.equal(env.extras.vecMeta.countPending({ sessionId: 'sess-a' }), 2);
    assert.equal(env.extras.vecMeta.countPending({ sessionId: 'sess-b' }), 1);
    assert.equal(env.extras.vecMeta.countPending({ sessionId: 'sess-a', includeExcluded: true }), 3);

    const aPending = env.extras.vecMeta.pending({ sessionId: 'sess-a' });
    assert.deepEqual(aPending.map((m) => m.text), ['A1', 'A2']);
  } finally {
    env.cleanup();
  }
});

test('panel.rebuild(scope=incremental)：主动触发实时入库 + 增量补建 + 逐批真实进度（不清空旧向量）', async () => {
  const fetchCalls = [];
  let syncCount = 0;
  let env;

  const syncSession = async (sid) => {
    syncCount += 1;
    if (sid !== 'sess-a') return { skipped: false, inserted: 0 };
    // 模拟实时同步新进来的 3 条对话（原本还没入库）
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 11, 11, 0),
      startSeq: 10,
      items: ['刚发的新消息 1', '刚发的新消息 2', '刚发的新消息 3'],
    });
    return { skipped: false, inserted: 3 };
  };

  env = setupEnv({
    syncSession,
    config: {
      embedding: {
        mode: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen3-embedding-0.6b',
        dim: DIM,
        maxBatch: 2,
        fetchImpl: fakeFetch(fetchCalls),
      },
    },
  });

  try {
    // sess-a 先有一条已索引、两条未索引
    const s1 = seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 10, 0),
      startSeq: 1,
      items: ['早已索引的消息', '旧的待索引消息 1', '旧的待索引消息 2'],
    });
    // sess-b 有一条未索引（不应被 sess-a 的增量按钮误跑）
    seedScene(env.repo, {
      sessionId: 'sess-b',
      startAt: sh(2026, 11, 10, 10, 5),
      startSeq: 1,
      items: ['另一个会话的消息'],
    });

    const provider = createSiliconFlowEmbedding({
      mode: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-embedding-0.6b',
      dim: DIM,
      maxBatch: 2,
      fetchImpl: fakeFetch(fetchCalls),
    });
    const store = createVectorStore(env.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({ handle: env.handle, provider, extras: env.extras, store, logger: silent });
    const firstMsg = env.repo.msgsByTimeRange('sess-a', 0, Number.MAX_SAFE_INTEGER, 10).find((m) => m.seq === 1);
    assert.ok(s1.sceneId && firstMsg);
    await indexer.indexMsgs([firstMsg]);
    fetchCalls.length = 0; // 清空前置计数

    const stBefore = await env.api.call('status', { sessionId: 'sess-a' });
    assert.equal(stBefore.vector.indexed, 1);
    assert.equal(stBefore.vector.total, 3);
    assert.equal(stBefore.vector.pending, 2);

    // 主动点击「同步并索引」
    const started = await env.api.call('rebuild', { sessionId: 'sess-a', scope: 'incremental' });
    assert.ok(started.taskId);
    assert.equal(started.scope, 'incremental');

    // 轮询直到完成，期间应看到 progress
    let info;
    const seenProgress = [];
    for (let i = 0; i < 60; i += 1) {
      info = await env.api.call('task', { taskId: started.taskId });
      if (info.progress) seenProgress.push({ ...info.progress });
      if (info.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(info.state, 'done', `任务应成功完成，实际 error=${info.error}`);
    assert.equal(syncCount, 1, '应触发了一次实时同步入库');
    assert.equal(info.result.synced, 3, '应报告新增入库 3 条');
    assert.equal(info.result.msgs, 5, '只应补建 sess-a 原本 2 条 + 新同步 3 条 = 5 条（不重算旧 1 条）');
    assert.ok(seenProgress.some((p) => p.phase === 'done' && p.pct === 100));

    // fetch 调用里不应出现「早已索引的消息」或 sess-b 的消息
    const embeddedTexts = fetchCalls.flatMap((c) => c.inputs);
    assert.ok(!embeddedTexts.includes('早已索引的消息'), '增量索引绝不重算已建好的向量');
    assert.ok(!embeddedTexts.includes('另一个会话的消息'), 'sess-a 增量索引不应顺便跑 sess-b');
    assert.equal(embeddedTexts.length, 5 + Number(info.result.windowVectors ?? 0));

    const stAfter = await env.api.call('status', { sessionId: 'sess-a' });
    assert.equal(stAfter.vector.indexed, 6);
    assert.equal(stAfter.vector.total, 6);
    assert.equal(stAfter.vector.pending, 0);
    assert.equal(env.extras.vecMeta.countPending({ sessionId: 'sess-b' }), 1, 'sess-b 保持原样待索引');
  } finally {
    env.cleanup();
  }
});

test('createIndexer.indexPending：按 maxBatch 逐批上报实时 done/total 进度', async () => {
  const fetchCalls = [];
  const env = setupEnv();
  try {
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 10, 0),
      startSeq: 1,
      items: ['m1', 'm2', 'm3', 'm4', 'm5'],
    });
    const provider = createSiliconFlowEmbedding({
      mode: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-embedding-0.6b',
      dim: DIM,
      maxBatch: 2,
      fetchImpl: fakeFetch(fetchCalls),
    });
    const store = createVectorStore(env.handle, { dim: DIM, logger: silent });
    const events = [];
    const indexer = createIndexer({
      handle: env.handle,
      provider,
      extras: env.extras,
      store,
      logger: silent,
      onProgress: (info) => events.push({ ...info }),
    });
    const r = await indexer.indexPending({ sessionId: 'sess-a' });
    assert.equal(r.indexed, 5);
    assert.equal(r.totalPending, 5);

    const msgEvents = events.filter((e) => e.phase === 'msg').map((e) => `${e.done}/${e.total}`);
    assert.ok(msgEvents.includes('0/5'));
    assert.ok(msgEvents.includes('2/5'));
    assert.ok(msgEvents.includes('4/5'));
    assert.ok(msgEvents.includes('5/5'));
  } finally {
    env.cleanup();
  }
});

/* ══════════════════ 5. 数据库管理台（dbOverview / dbRows / dbQuery / dbMaintain） ══════════════════ */

test('panel.dbOverview 与 panel.dbRows：全库总览 + 跨会话切换视图 + 关键字与分页', async () => {
  const env = setupEnv();
  try {
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 9, 0),
      startSeq: 1,
      items: ['A 的早安', 'A 的咖啡'],
    });
    seedScene(env.repo, {
      sessionId: 'sess-b',
      startAt: sh(2026, 11, 11, 10, 0),
      startSeq: 1,
      items: ['B 的晚安', 'B 的电影', 'B 的咖啡'],
    });
    env.extras.note.insert({ sessionId: 'sess-a', content: 'A 的笔记', about: 'him', at: sh(2026, 11, 10, 9, 5) });
    const delId = env.extras.note.insert({ sessionId: 'sess-b', content: 'B 的已删笔记', about: 'me', at: sh(2026, 11, 11, 10, 5) });
    env.extras.note.softDelete(delId, Date.now() - 1000, { sessionId: 'sess-b' });

    const ov = await env.api.call('dbOverview', {});
    assert.equal(ov.totals.sessions, 2);
    assert.equal(ov.totals.msgs, 5);
    assert.equal(ov.totals.pendingMsgs, 5);
    assert.equal(ov.totals.notes, 1);
    assert.equal(ov.totals.deletedNotes, 1);
    assert.equal(ov.sessions.length, 2);
    // 最近活跃的 sess-b 排在前面
    assert.equal(ov.sessions[0].sessionId, 'sess-b');
    assert.equal(ov.sessions[0].totalMsgs, 3);
    assert.equal(ov.sessions[1].sessionId, 'sess-a');
    assert.equal(ov.sessions[1].totalMsgs, 2);
    assert.equal(ov.sessions[1].noteCount, 1);

    // 切换不同会话视图浏览 msg 表
    const allMsgs = await env.api.call('dbRows', { table: 'msg', limit: 10 });
    assert.equal(allMsgs.total, 5);
    const aMsgs = await env.api.call('dbRows', { table: 'msg', sessionId: 'sess-a' });
    assert.equal(aMsgs.total, 2);
    assert.ok(aMsgs.rows.every((r) => r.session_id === 'sess-a'));
    const bCoffee = await env.api.call('dbRows', { table: 'msg', sessionId: 'sess-b', query: '咖啡' });
    assert.equal(bCoffee.total, 1);
    assert.equal(bCoffee.rows[0].text, 'B 的咖啡');

    // 切换 note 表 + 过滤非白名单表
    const aNotes = await env.api.call('dbRows', { table: 'note', sessionId: 'sess-a' });
    assert.equal(aNotes.total, 1);
    assert.equal(aNotes.rows[0].content, 'A 的笔记');
    await assert.rejects(
      () => env.api.call('dbRows', { table: 'sqlite_master' }),
      (e) => e instanceof PanelError && e.status === 400 && e.code === 'BAD_TABLE',
    );
  } finally {
    env.cleanup();
  }
});

test('panel.dbQuery：仅放行单条只读 SQL，严格拦截一切写入与多语句', async () => {
  const env = setupEnv();
  try {
    seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 9, 0),
      startSeq: 1,
      items: ['测试 1', '测试 2', '测试 3'],
    });

    const okRes = await env.api.call('dbQuery', {
      sql: 'SELECT session_id, COUNT(*) AS n FROM msg GROUP BY session_id;',
      limit: 2,
    });
    assert.equal(okRes.rowCount, 1);
    assert.equal(okRes.truncated, false);
    assert.deepEqual(okRes.columns, ['session_id', 'n']);
    assert.equal(okRes.rows[0].n, 3);

    for (const badSql of [
      'DELETE FROM msg',
      'DROP TABLE msg',
      'UPDATE msg SET text = \'x\'',
      'INSERT INTO note (content, at, created_at) VALUES (\'x\', 1, 1)',
      'PRAGMA user_version = 99',
      'SELECT 1; DELETE FROM msg',
    ]) {
      await assert.rejects(
        () => env.api.call('dbQuery', { sql: badSql }),
        (e) => e instanceof PanelError && e.status === 400 && e.code === 'READONLY_SQL',
        `应拦截危险 SQL：${badSql}`,
      );
    }
  } finally {
    env.cleanup();
  }
});

test('panel.dbMaintain：exportSession / purgeTrash / vacuum / backup（含文件库热备份）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-db-maint-'));
  const dbRoot = path.join(dir, 'verbatim');
  fs.mkdirSync(dbRoot, { recursive: true });
  const dbFile = path.join(dbRoot, 'memory.db');
  const handle = openDb({ dbPath: dbFile, dshHome: dir, loadVec: false, logger: silent });
  const repo = createRepo(handle);
  const extras = createExtras(handle);
  const api = createPanelApi({ handle, repo, extras, dbPath: dbFile, dshHome: dir, dbRoot, logger: silent });

  try {
    seedScene(repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 9, 0),
      startSeq: 1,
      items: ['导出测试 1', '导出测试 2'],
    });
    const expNote = extras.note.insert({ sessionId: 'sess-a', content: '过期笔记', at: sh(2026, 10, 1, 9, 0) });
    extras.note.softDelete(expNote, Date.now() - 35 * DAY_MS, { sessionId: 'sess-a' });
    extras.note.insert({ sessionId: 'sess-a', content: '保留笔记', at: sh(2026, 11, 10, 9, 5) });

    // exportSession
    const exp = await api.call('dbMaintain', { action: 'exportSession', sessionId: 'sess-a' });
    assert.equal(exp.ok, true);
    assert.equal(exp.counts.msgs, 2);
    assert.equal(exp.counts.notes, 1);

    // purgeTrash
    const purged = await api.call('dbMaintain', { action: 'purgeTrash' });
    assert.equal(purged.ok, true);
    assert.equal(purged.purged, 1);

    // vacuum
    const vac = await api.call('dbMaintain', { action: 'vacuum' });
    assert.equal(vac.ok, true);
    assert.ok(vac.afterBytes > 0);

    // backup（热备 VACUUM INTO）
    const bak = await api.call('dbMaintain', { action: 'backup' });
    assert.equal(bak.ok, true);
    assert.ok(fs.existsSync(bak.backupPath), '热备份文件应真实存在');
    assert.ok(bak.bytes > 0);
  } finally {
    try { handle.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('panel.addNote：用户在面板主动补记笔记，严格按会话隔离并校验 about', async () => {
  const env = setupEnv();
  try {
    const added = await env.api.call('addNote', {
      sessionId: 'sess-a',
      content: '下周三提醒他带伞',
      about: 'him',
    });
    assert.equal(added.ok, true);
    assert.ok(added.id > 0);
    assert.equal(added.note.about, 'him');

    const notesA = await env.api.call('notes', { sessionId: 'sess-a' });
    const notesB = await env.api.call('notes', { sessionId: 'sess-b' });
    assert.equal(notesA.length, 1);
    assert.equal(notesA[0].content, '下周三提醒他带伞');
    assert.equal(notesB.length, 0, 'sess-b 不能看到 sess-a 手动记的笔记');

    await assert.rejects(
      () => env.api.call('addNote', { sessionId: 'sess-a', content: '   ' }),
      (e) => e instanceof PanelError && e.status === 400,
    );
    await assert.rejects(
      () => env.api.call('addNote', { sessionId: 'sess-a', content: '测试', about: 'invalid' }),
      (e) => e instanceof PanelError && e.status === 400,
    );
  } finally {
    env.cleanup();
  }
});

/* ══════════════════ 6. scene 派生列回填 + Tier-1 gist + media + vec_scene ══════════════════ */

test('buildExtractiveGist / gistHeadline：零 LLM 抽取遵循三段式且跳过纯寒暄', () => {
  const msgs = [
    { id: 1, speaker: 'user', text: '嗯' },
    { id: 2, speaker: 'user', text: '我们今天把数据库管理台和场景切分一起优化掉吧' },
    { id: 3, speaker: 'assistant', text: '好的，先处理场景派生列回填，再把 gist 和 media 接上。' },
  ];
  const gist = buildExtractiveGist(msgs);
  assert.ok(gist.includes('【发生了什么】'));
  assert.ok(gist.includes('【原话】'));
  assert.ok(gist.includes('【不懂的】无'));
  assert.ok(gist.includes('数据库管理台'), '应选中实质句而非「嗯」');

  const hl = gistHeadline(gist, 20);
  assert.ok(hl && !hl.includes('【发生了什么】'));
  assert.ok([...hl].length <= 20);
});

test('rebuildScenesForSession 回填 6 个派生列 + gist，且 panel.timeline 返回 gist', async () => {
  const env = setupEnv();
  try {
    env.repo.insertMsgs([
      {
        sessionId: 'sess-a',
        seq: 1,
        at: sh(2026, 11, 10, 9, 0),
        speaker: 'user',
        text: '这是一条已经被压缩的历史消息，讨论咖啡配方',
        inSurface: 0,
        compactedAt: sh(2026, 11, 10, 12, 0),
        excluded: 0,
      },
      {
        sessionId: 'sess-a',
        seq: 2,
        at: sh(2026, 11, 10, 9, 1),
        speaker: 'assistant',
        text: '手冲水温建议 92 度，研磨度中细。',
        inSurface: 0,
        compactedAt: sh(2026, 11, 10, 12, 0),
        excluded: 1,
      },
    ]);

    const r = rebuildScenesForSession({ repo: env.repo, extras: env.extras, sessionId: 'sess-a', db: env.handle.db });
    assert.equal(r.scenes, 1);

    const sc = env.repo.sceneById(r.sceneIds[0]);
    assert.equal(sc.hasOutOfSurface, 1);
    assert.equal(sc.outOfSurfaceCount, 2);
    assert.equal(sc.compactedCount, 2);
    assert.equal(sc.hasExcluded, 1);
    assert.equal(sc.excludedCount, 1);
    assert.ok(sc.gist && sc.gist.includes('【发生了什么】'));

    const days = await env.api.call('timeline', { sessionId: 'sess-a' });
    assert.equal(days.length, 1);
    assert.ok(days[0].scenes[0].gist && days[0].scenes[0].gist.includes('咖啡配方'));
  } finally {
    env.cleanup();
  }
});

test('mediaBlocksOf + extras.media + panel.sceneDetail + panel.dbRows(media) 完整贯通', async () => {
  const blocks = mediaBlocksOf({
    data: {
      content: [
        { type: 'text', text: '看这张截图' },
        { type: 'image', path: 'C:/tmp/screen.png', width: 1280, height: 720, sha256: 'abc123' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, 'C:/tmp/screen.png');
  assert.equal(blocks[0].width, 1280);
  assert.equal(blocks[1].path, 'inline:image/png');

  const env = setupEnv();
  try {
    const s = seedScene(env.repo, {
      sessionId: 'sess-a',
      startAt: sh(2026, 11, 10, 9, 0),
      startSeq: 1,
      items: ['看这张截图'],
    });
    const written = env.extras.media.replaceForSession('sess-a', [
      { seq: 1, path: 'C:/tmp/screen.png', width: 1280, height: 720, sha256: 'abc123' },
    ]);
    assert.equal(written, 1);

    const detail = await env.api.call('sceneDetail', { sceneId: s.sceneId });
    assert.equal(detail.msgs[0].media.length, 1);
    assert.equal(detail.msgs[0].media[0].path, 'C:/tmp/screen.png');

    const dbMedia = await env.api.call('dbRows', { table: 'media', sessionId: 'sess-a' });
    assert.equal(dbMedia.total, 1);
    assert.equal(dbMedia.rows[0].path, 'C:/tmp/screen.png');
  } finally {
    env.cleanup();
  }
});

test('LLM 入口：llmReady + DSH hostLlm(ctx.llm) + globalConfig + panel.rebuild(scene) Tier-2 精炼与回退', async () => {
  // 1. llmReady 状态矩阵（直接使用 DSH 模型列表，不单独维护 API）
  assert.equal(llmReady({ llm: { enabled: false, provider: 'deepseek-official', model: 'deepseek-chat' } }, true).ready, false);
  assert.equal(llmReady({ llm: { enabled: true, provider: 'deepseek-official', model: '' } }, true).ready, false);
  assert.equal(llmReady({ llm: { enabled: true, provider: 'deepseek-official', model: 'deepseek-chat' } }, false).ready, false);
  assert.equal(llmReady({ llm: { enabled: true, provider: 'deepseek-official', model: 'deepseek-chat' } }, true).ready, true);

  // 2. globalConfig / setGlobalConfig 配置 DSH 模型（无需 apiKey/baseUrl）
  const mockHostLlm = (replyText) => ({
    listProviders: async () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      yield { type: 'text-delta', index: 0, text: typeof replyText === 'function' ? replyText() : replyText };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const env = setupEnv();
  try {
    const g0 = await env.api.call('globalConfig', {});
    assert.equal(g0.config.llm.enabled, false);
    assert.equal(g0.llm.ready, false);

    const saved = await env.api.call('setGlobalConfig', {
      patch: {
        llm: {
          enabled: true,
          provider: 'deepseek-official',
          model: 'deepseek-chat',
        },
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.llm.enabled, true);
    assert.equal(saved.llm.hasHostLlm, false);
    assert.equal(saved.llm.ready, false);
    assert.equal(saved.llm.provider, 'deepseek-official');
    assert.equal(saved.llm.model, 'deepseek-chat');

    const g1 = await env.api.call('globalConfig', {});
    assert.equal(g1.llm.enabled, true);
    assert.equal(g1.config.llm.model, 'deepseek-chat');
  } finally {
    env.cleanup();
  }

  // 3. panel.rebuild(scope: 'scene') 启用 DSH hostLlm 时精炼 gist；失败时保留 Tier-1 抽取式摘要
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-llm-rebuild-'));
  const handle = openDb(':memory:');
  try {
    const repo = createRepo(handle.db);
    const extras = createExtras(handle.db);
    repo.insertMsgs([
      { sessionId: 'sess-llm', seq: 1, at: sh(2026, 11, 10, 10, 0), speaker: 'user', text: '周末一起整理一下项目文档吧，把接口说明补齐。', inSurface: 1 },
      { sessionId: 'sess-llm', seq: 2, at: sh(2026, 11, 10, 10, 2), speaker: 'assistant', text: '好，我先按模块列个目录，再补齐示例和错误码。', inSurface: 1 },
    ]);

    const apiOk = createPanelApi({
      handle,
      repo,
      extras,
      dshHome: tmpDir,
      dbPath: ':memory:',
      getHostLlm: () => mockHostLlm(JSON.stringify({
        gist: '【发生了什么】商量周末整理项目文档并按模块补齐接口说明【原话】「周末一起整理一下项目文档吧」【不懂的】无',
        unresolved: [],
      })),
      config: {
        llm: { enabled: true, provider: 'deepseek-official', model: 'deepseek-chat' },
      },
    });

    const job = await apiOk.call('rebuild', { sessionId: 'sess-llm', scope: 'scene' });
    let info = await apiOk.call('task', { taskId: job.taskId });
    for (let i = 0; i < 40 && info.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 15));
      info = await apiOk.call('task', { taskId: job.taskId });
    }
    assert.equal(info.state, 'done');
    assert.equal(info.result.llmGists, 1);
    const scList = repo.scenesByTimeRange('sess-llm', 0, Number.MAX_SAFE_INTEGER, 100);
    assert.equal(scList.length, 1);
    assert.ok(scList[0].gist.includes('商量周末整理项目文档'));

    // 失败回退：DSH LLM 返回异常时保留 Tier-1 抽取式摘要
    const apiFail = createPanelApi({
      handle,
      repo,
      extras,
      dshHome: tmpDir,
      dbPath: ':memory:',
      getHostLlm: () => ({
        listProviders: async () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
        listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        async *stream() {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad request' } } };
        },
      }),
      config: {
        llm: { enabled: true, provider: 'deepseek-official', model: 'deepseek-chat' },
      },
    });
    const job2 = await apiFail.call('rebuild', { sessionId: 'sess-llm', scope: 'scene' });
    let info2 = await apiFail.call('task', { taskId: job2.taskId });
    for (let i = 0; i < 40 && info2.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 15));
      info2 = await apiFail.call('task', { taskId: job2.taskId });
    }
    assert.equal(info2.state, 'done');
    assert.equal(info2.result.llmGists, 0);
    const scList2 = repo.scenesByTimeRange('sess-llm', 0, Number.MAX_SAFE_INTEGER, 100);
    assert.ok(scList2[0].gist && scList2[0].gist.includes('【发生了什么】'), 'LLM 失败时应自动保留 Tier-1 抽取式摘要');

    // 5. scope='scene' + useLlm=false 绝不调用 LLM；scope='gist' 独立精炼摘要；panel.search 返回 matchedScenes
    let llmCalls = 0;
    const apiBoundary = createPanelApi({
      handle,
      repo,
      extras,
      dshHome: tmpDir,
      dbPath: ':memory:',
      getHostLlm: () => mockHostLlm(() => {
        llmCalls += 1;
        return JSON.stringify({
          gist: '【发生了什么】约定周末整理接口文档与错误码清单【原话】「周末一起整理一下项目文档吧」【不懂的】无',
          unresolved: [],
        });
      }),
      config: {
        llm: { enabled: true, provider: 'deepseek-official', model: 'deepseek-chat' },
      },
    });

    const jobNoLlm = await apiBoundary.call('rebuild', { sessionId: 'sess-llm', scope: 'scene', useLlm: false });
    let stNoLlm = await apiBoundary.call('task', { taskId: jobNoLlm.taskId });
    for (let i = 0; i < 40 && stNoLlm.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 15));
      stNoLlm = await apiBoundary.call('task', { taskId: jobNoLlm.taskId });
    }
    assert.equal(stNoLlm.state, 'done');
    assert.equal(llmCalls, 0, 'useLlm: false 重切场景绝不应调用 LLM');

    const jobGist = await apiBoundary.call('rebuild', { sessionId: 'sess-llm', scope: 'gist' });
    let stGist = await apiBoundary.call('task', { taskId: jobGist.taskId });
    for (let i = 0; i < 40 && stGist.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 15));
      stGist = await apiBoundary.call('task', { taskId: jobGist.taskId });
    }
    assert.equal(stGist.state, 'done');
    assert.equal(llmCalls, 1);
    assert.equal(stGist.result.llmGists, 1);

    const stNow = await apiBoundary.call('status', { sessionId: 'sess-llm' });
    assert.equal(stNow.stats.scenesWithGist, 1);
    assert.equal(stNow.llm.ready, true);

    const searchRes = await apiBoundary.call('search', { sessionId: 'sess-llm', query: '错误码清单' });
    assert.equal(searchRes.matchedScenes.length, 1);
    assert.ok(searchRes.matchedScenes[0].gist.includes('错误码清单'));
  } finally {
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('note 高权重置顶 + vec_note 语义检索 + 分数门槛过滤（memory_search 与 panel.search）', async () => {
  const handle = openDb(':memory:');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-note-vec-'));
  try {
    const repo = createRepo(handle.db);
    const extras = createExtras(handle.db);

    // 准备 4 条相同关键词笔记 + 1 条仅语义相似笔记 + 1 条低相关噪声笔记
    const n1 = extras.note.insert({ sessionId: 'sess-n', content: '约定：接口鉴权统一走 Bearer Token', about: 'us', at: sh(2026, 11, 10, 10, 0) });
    const n2 = extras.note.insert({ sessionId: 'sess-n', content: '约定：错误码必须带中文提示', about: 'us', at: sh(2026, 11, 10, 10, 5) });
    const n3 = extras.note.insert({ sessionId: 'sess-n', content: '约定：分页参数统一用 limit 和 offset', about: 'us', at: sh(2026, 11, 10, 10, 10) });
    const n4 = extras.note.insert({ sessionId: 'sess-n', content: '约定：时间统一用上海时区', about: 'us', at: sh(2026, 11, 10, 10, 15) });
    const nSem = extras.note.insert({ sessionId: 'sess-n', content: '乳糖不耐受，不能喝冰牛奶', about: 'him', at: sh(2026, 11, 10, 11, 0) });
    const nNoise = extras.note.insert({ sessionId: 'sess-n', content: '周末去公园散步', about: 'us', at: sh(2026, 11, 10, 12, 0) });

    repo.insertMsgs([
      { sessionId: 'sess-n', seq: 1, at: sh(2026, 11, 10, 13, 0), speaker: 'user', text: '今天我们把约定再确认一下。', inSurface: 1 },
    ]);

    // 构造可控 embedding provider：query「喝牛奶肚子疼」只与 nSem 高度相似，与 nNoise 低相似
    const unit = (idx) => {
      const v = new Float32Array(1024);
      v[idx] = 1;
      return v;
    };
    const mix = (aIdx, bIdx, wA) => {
      const v = new Float32Array(1024);
      v[aIdx] = wA;
      v[bIdx] = Math.sqrt(Math.max(0, 1 - wA * wA));
      return v;
    };
    const mockProvider = {
      id: 'mock:note-vec@1024',
      dim: 1024,
      maxBatch: 32,
      async embed(texts) {
        return texts.map((t) => {
          if (t.includes('乳糖不耐受') || t.includes('喝牛奶肚子疼')) return unit(10);
          if (t.includes('公园散步')) return mix(10, 11, 0.30); // cos = 0.30 < 0.58，应被分数门槛拦截
          return unit(20);
        });
      },
    };
    const store = createVectorStore(handle, { dim: 1024, logger: { warn: () => {} } });

    // 1. 分数门槛测试：nSem 命中 (>= 0.58)，nNoise 被过滤
    const semRes = await searchRankedNotes({
      extras,
      sessionId: 'sess-n',
      query: '喝牛奶肚子疼',
      provider: mockProvider,
      store,
      minScore: NOTE_MIN_SCORE_DEFAULT,
      limit: 3,
    });
    assert.equal(semRes.semanticUsed, true);
    assert.equal(semRes.hits.length, 1);
    assert.equal(semRes.hits[0].id, nSem);
    assert.deepEqual(semRes.hits[0].sources, ['vector']);
    assert.ok(semRes.hits[0].score >= NOTE_MIN_SCORE_DEFAULT);

    // 2. 默认置顶上限 3 条（4 条都命中「约定」，置顶只取前 3 条）+ 保留原话标题行
    const searchTool = createSearchTool({
      handle,
      repo,
      extras,
      sessionId: 'sess-n',
      provider: mockProvider,
      store,
      semantic: false,
    });
    const outDefault = await searchTool.handler({ query: '约定' });
    assert.match(outDefault, /^「约定」— 1 处/m);
    assert.ok(outDefault.includes('你自己记的（高权重置顶） — 3 条'));
    assert.ok(outDefault.includes('你们说过的话 — 1 处'));

    // 3. scope=note 走 vec_note 语义检索召回 nSem，且不返回低分噪声 nNoise
    const searchToolSem = createSearchTool({
      handle,
      repo,
      extras,
      sessionId: 'sess-n',
      provider: mockProvider,
      store,
    });
    const outNoteSem = await searchToolSem.handler({ query: '喝牛奶肚子疼', scope: 'note' });
    assert.ok(outNoteSem.includes(`笔记 #${nSem}`));
    assert.ok(!outNoteSem.includes(`笔记 #${nNoise}`), '低于分数门槛的噪声笔记不应返回');

    // 4. panel.search 返回高权重置顶 matchedNotes（含关键词与语义）
    saveGlobalConfig({
      embedding: {
        mode: 'local',
        model: 'mock-embed',
        dim: 1024,
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
    }, { dshHome: tmpDir });
    const api = createPanelApi({
      handle,
      repo,
      extras,
      dshHome: tmpDir,
      dbPath: ':memory:',
      config: {
        embedding: {
          mode: 'local',
          model: 'mock-embed',
          dim: 1024,
          baseUrl: 'http://127.0.0.1:11434/v1',
          fetchImpl: async (_url, init) => {
            const body = JSON.parse(init.body);
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            const data = await mockProvider.embed(inputs);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                data: data.map((embedding, index) => ({ index, embedding: Array.from(embedding) })),
              }),
            };
          },
        },
      },
    });
    const pRes = await api.call('search', { sessionId: 'sess-n', query: '喝牛奶肚子疼' });
    assert.equal(pRes.matchedNotes.length, 1);
    assert.equal(pRes.matchedNotes[0].id, nSem);
    assert.deepEqual(pRes.matchedNotes[0].sources, ['vector']);
    assert.ok(pRes.matchedNotes[0].score >= NOTE_MIN_SCORE_DEFAULT);
    assert.ok(n1 && n2 && n3 && n4);

    // 5. probeLocal({ test }) 在线测试连通性（embedding + llm）
    const testEmbOk = await api.call('probeLocal', {
      test: { kind: 'embedding', mode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'mock-embed' },
    });
    assert.equal(testEmbOk.ok, true);
    assert.equal(testEmbOk.nativeDim, 1024);

    const apiLlmTest = createPanelApi({
      handle,
      repo,
      extras,
      dshHome: tmpDir,
      dbPath: ':memory:',
      getHostLlm: () => ({
        listProviders: async () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
        listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        async *stream() {
          yield { type: 'text-delta', index: 0, text: 'pong' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      }),
      config: {
        llm: { enabled: true, provider: 'deepseek-official', model: 'deepseek-chat' },
      },
    });
    const listLlm = await apiLlmTest.call('probeLocal', { listModels: { kind: 'llm' } });
    assert.equal(listLlm.ok, true);
    assert.equal(listLlm.models[0].model, 'deepseek-chat');
    const testLlmOk = await apiLlmTest.call('probeLocal', {
      test: { kind: 'llm', provider: 'deepseek-official', model: 'deepseek-chat' },
    });
    assert.equal(testLlmOk.ok, true);
    assert.equal(testLlmOk.model, 'deepseek-chat');
  } finally {
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Rerank 精排 + vecExt 状态 + globalConfig 脱敏 + probeLocal(rerank) + memory_search 降级', async () => {
  // 1. rerankReady 状态矩阵
  assert.equal(rerankReady({ rerank: { enabled: false, mode: 'remote', model: 'BAAI/bge-reranker-v2-m3', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-123' } }).ready, false);
  assert.equal(rerankReady({ rerank: { enabled: true, mode: 'local', model: 'bge-reranker-v2-m3', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '' } }).ready, true);
  assert.equal(rerankReady({ rerank: { enabled: true, mode: 'remote', model: 'BAAI/bge-reranker-v2-m3', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '' } }, {}).ready, false);
  assert.equal(rerankReady({ rerank: { enabled: true, mode: 'remote', model: 'BAAI/bge-reranker-v2-m3', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-123' } }, {}).ready, true);

  // 2. createReranker local 模式不发送 Authorization，且按 relevance_score 降序重排
  let seenAuth = 'unset';
  const reranker = createReranker({
    local: true,
    model: 'bge-reranker-v2-m3',
    baseURL: 'http://127.0.0.1:8000/v1',
    fetchImpl: async (_url, init) => {
      seenAuth = init.headers?.Authorization ?? null;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.94 },
            { index: 0, relevance_score: 0.31 },
          ],
        }),
      };
    },
  });
  const ranked = await reranker.rerank('怕黑', ['无关的一句', '其实我有点怕黑']);
  assert.equal(seenAuth, null);
  assert.deepEqual(ranked.map((r) => r.index), [1, 0]);
  assert.equal(ranked[0].score, 0.94);

  // 3. globalConfig / setGlobalConfig 配置 rerank + 脱敏 + vecExt + probeLocal({ test: { kind: 'rerank' } })
  const env = setupEnv();
  try {
    const g0 = await env.api.call('globalConfig', {});
    assert.equal(g0.config.rerank.enabled, false);
    assert.equal(g0.rerank.ready, false);
    assert.equal(typeof g0.vecExt.loaded, 'boolean');

    const saved = await env.api.call('setGlobalConfig', {
      patch: {
        rerank: {
          enabled: true,
          mode: 'remote',
          model: 'BAAI/bge-reranker-v2-m3',
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-rerank-secret-1234',
          topN: 15,
        },
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.rerank.apiKey, '');
    assert.equal(saved.rerank.ready, true);
    assert.equal(saved.rerank.hasApiKey, true);
    assert.equal(saved.config.rerank.topN, 15);

    const apiRerankTest = createPanelApi({
      handle: env.handle,
      repo: env.repo,
      extras: env.extras,
      dshHome: env.tmpDir,
      dbPath: ':memory:',
      config: {
        rerank: {
          enabled: true,
          mode: 'local',
          baseUrl: 'http://127.0.0.1:8000/v1',
          model: 'bge-reranker-v2-m3',
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ results: [{ index: 0, relevance_score: 0.99 }] }),
            text: async () => JSON.stringify({ results: [{ index: 0, relevance_score: 0.99 }] }),
          }),
        },
      },
    });
    const testRr = await apiRerankTest.call('probeLocal', {
      test: { kind: 'rerank', mode: 'local', baseUrl: 'http://127.0.0.1:8000/v1', model: 'bge-reranker-v2-m3' },
    });
    assert.equal(testRr.ok, true);
    assert.equal(testRr.model, 'bge-reranker-v2-m3');

    // 4. memory_search 集成 rerank 失败时优雅降级（不抛错、照常返回结果）
    seedScene(env.repo, {
      sessionId: 'sess-rr',
      startAt: sh(2026, 11, 10, 9, 0),
      startSeq: 1,
      items: ['今天聊了怕黑的事', '我也怕黑，但不说'],
    });
    let capturedMeta = null;
    const toolFail = createSearchTool({
      repo: env.repo,
      extras: env.extras,
      handle: env.handle,
      sessionId: 'sess-rr',
      semantic: false,
      reranker: {
        model: 'broken-reranker',
        rerank: async () => { throw new Error('rerank 服务挂了'); },
      },
      onResult: (info) => { capturedMeta = info.meta; },
    });
    const out = await toolFail.handler({ query: '怕黑' });
    assert.match(out, /怕黑/);
    assert.equal(capturedMeta.reranked, false);
    assert.match(capturedMeta.rerankError, /rerank 服务挂了/);
  } finally {
    env.cleanup();
  }
});
