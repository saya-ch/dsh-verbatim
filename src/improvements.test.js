/**
 * improvements.test.js —— 针对架构审查发现的集成裂缝的回归测试
 *
 * 覆盖：
 *   1. createSiliconFlowEmbedding 兼容 config.embedding 的 baseUrl（小写）与 mode:'local'
 *   2. memory_search 的 semanticCache 随 config.json 更改自动失效重装，且 minKeywordHits 生效
 *   3. assessVectorIndex 与面板 vectorStatus 一样按 sessionId 口径计算索引覆盖率
 *   4. apply() 多会话 ensureFresh 按各自会话文件独立增量同步 + autoIndex 轻量后台补索引
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';

import { openDb } from './store/db.js';
import { createRepo, createExtras } from './store/repo.js';
import { createSiliconFlowEmbedding } from './model/embedding.js';
import { textToVector } from './model/mock.js';
import { createVectorStore } from './search/vector-store.js';
import { createIndexer } from './search/indexer.js';
import { createSearchTool } from './tools/memory-search.js';
import { saveGlobalConfig } from './config/global-config.js';
import { apply } from '../index.js';

const DIM = 1024;
const silent = { warn() {}, info() {}, error() {} };
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function makeTempHome(prefix = 'verbatim-imp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeZstdSession(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const jsonl = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  fs.writeFileSync(filePath, zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')));
}

function fakeFetch(calls, { status = 200 } = {}) {
  return async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    calls.push({ url: String(url), model: body.model, headers: init?.headers, count: inputs.length });
    if (status !== 200) {
      return { ok: false, status, text: async () => 'mock error' };
    }
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

function seedSessionMsgs(repo, sessionId, texts, startSeq = 1) {
  const startAt = Date.UTC(2026, 10, 17, 4, 0, 0);
  const rows = texts.map((text, i) => ({
    sessionId,
    seq: startSeq + i,
    at: startAt + i * 60_000,
    speaker: i % 2 === 0 ? 'user' : 'assistant',
    text,
    inSurface: 1,
  }));
  const sceneId = repo.insertScene({
    sessionId,
    startAt: rows[0].at,
    endAt: rows[rows.length - 1].at,
    msgCount: rows.length,
    leadIn: null,
  });
  return repo.insertMsgs(rows.map((m) => ({ ...m, sceneId })));
}

test('1. createSiliconFlowEmbedding 兼容 config.embedding 的 baseUrl 与 mode:local', async () => {
  const calls = [];
  const p = createSiliconFlowEmbedding({
    mode: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1/',
    model: 'qwen3-embedding-local:latest',
    dim: 1024,
    apiKeyEnv: '',
    fetchImpl: fakeFetch(calls),
  });

  assert.equal(p.id, 'sf:qwen3-embedding-local@1024');
  const vecs = await p.embed(['测试本地服务']);
  assert.equal(vecs.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/embeddings');
  assert.equal(calls[0].model, 'qwen3-embedding-local:latest');
});

test('2. memory_search 读 config.json 自动装配本地模型，且改配置后 semanticCache 自动失效', async () => {
  const dir = makeTempHome();
  const handle = openDb({ dbPath: ':memory:', dshHome: dir, loadVec: false, logger: silent });
  const origFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = fakeFetch(fetchCalls);

  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    seedSessionMsgs(repo, 's-cache', ['今天下雨不想出门', '那就在家喝热茶']);

    // ① 初始：remote 且没 key → vec:off
    saveGlobalConfig({
      embedding: { mode: 'remote', model: 'qwen-a', dim: DIM, apiKey: '', apiKeyEnv: '' },
    }, { dshHome: dir });

    const tool = createSearchTool({ handle, repo, extras, sessionId: 's-cache', now: NOW });
    const offOut = await tool.handler({ query: '不存在的词' });
    assert.match(offOut, /vec:off/, '无 key 时应报 vec:off');
    assert.equal(fetchCalls.length, 0);

    // ② 切到本地服务并建索引（库里指纹 = sf:qwen-local@1024）
    saveGlobalConfig({
      embedding: {
        mode: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen-local',
        dim: DIM,
        apiKey: '',
        apiKeyEnv: '',
      },
    }, { dshHome: dir });

    const localProv = createSiliconFlowEmbedding({
      mode: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen-local',
      dim: DIM,
      fetchImpl: fakeFetch([]),
    });
    const store = createVectorStore(handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({ handle, provider: localProv, extras, store, logger: silent });
    await indexer.indexPending();

    // 同一 handle / 工具实例立即能跑本地语义路（不再命中旧的 off 状态）
    const okOut = await tool.handler({ query: '今天下雨不想出门' });
    assert.equal(fetchCalls.length, 1, '应该发起一次本地 embedding 查询');
    assert.equal(fetchCalls[0].url, 'http://127.0.0.1:11434/v1/embeddings');
    assert.match(okOut, /kw\+vec/);

    // ③ 再改 config.json 换模型，缓存必须失效并报模型不一致（vec:err），而不是继续用旧模型
    saveGlobalConfig({
      embedding: { model: 'qwen-other' },
    }, { dshHome: dir });

    const mismatchOut = await tool.handler({ query: '不存在的词' });
    assert.match(mismatchOut, /vec:err.*不一致/, `改模型后必须检测到不一致，实际：\n${mismatchOut}`);
  } finally {
    globalThis.fetch = origFetch;
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3. assessVectorIndex 按当前会话口径判定覆盖率（与面板一致）', async () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    // A 会话 2 条，B 会话 8 条（全库 10 条）
    seedSessionMsgs(repo, 'sess-a', ['苹果很好吃', '我也喜欢苹果'], 1);
    seedSessionMsgs(repo, 'sess-b', Array.from({ length: 8 }, (_, i) => `香蕉第${i}句`), 1);

    const callsA = [];
    const provider = {
      id: `sf:test@${DIM}`,
      dim: DIM,
      maxBatch: 32,
      async embed(texts) {
        callsA.push(texts);
        return texts.map((t) => textToVector(t, DIM));
      },
    };
    const store = createVectorStore(handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({ handle, provider, extras, store, logger: silent });
    // 只索引 sess-a 的 2 条（sess-a 100%，sess-b 0%，全库仅 20%）
    await indexer.indexMsgs(repo.msgsByTimeRange('sess-a', 0, Number.MAX_SAFE_INTEGER, 100));
    callsA.length = 0;

    // 查 sess-a：覆盖率 100%，应该跑语义路（不能因为全库才 20% 而被判 vec:partial）
    let infoA = null;
    const toolA = createSearchTool({
      handle,
      repo,
      extras,
      sessionId: 'sess-a',
      provider,
      store,
      now: NOW,
      onResult: (i) => { infoA = i; },
    });
    const outA = await toolA.handler({ query: '水果好吃' });
    assert.equal(infoA.vectorIndex.usable, true);
    assert.equal(infoA.vectorIndex.vectors, 2);
    assert.equal(infoA.vectorIndex.total, 2);
    assert.equal(callsA.length, 1, 'sess-a 自身 100% 覆盖时应调用 embedding');
    assert.ok(!/vec:(empty|partial)/.test(outA));

    // 查 sess-b：覆盖率 0%，应该被拦住报 vec:empty（不能因为 sess-a 有向量而空跑）
    let infoB = null;
    const toolB = createSearchTool({
      handle,
      repo,
      extras,
      sessionId: 'sess-b',
      provider,
      store,
      now: NOW,
      onResult: (i) => { infoB = i; },
    });
    const outB = await toolB.handler({ query: '水果好吃' });
    assert.equal(infoB.vectorIndex.usable, false);
    assert.equal(infoB.vectorIndex.tag, 'vec:empty');
    assert.equal(callsA.length, 1, 'sess-b 空索引时不能调用 embedding');
    assert.match(outB, /vec:empty.*0 \/ 8/);
  } finally {
    handle.close();
  }
});

test('4. 多会话 ensureFresh 按会话文件独立同步 + autoIndex 后台轻量补全', async () => {
  const dir = makeTempHome();
  const wsDir = path.join(dir, 'sessions', 'ws-1');
  const fileA = path.join(wsDir, 'session-aaa', 'session.v4.jsonl.zstd');
  const fileB = path.join(wsDir, 'session-bbb', 'session.v4.jsonl.zstd');

  const t0 = Date.UTC(2026, 10, 18, 2, 0, 0);
  writeZstdSession(fileA, [
    { type: 'user/message', seq: 1, time: t0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '会话A第一句' }] } },
  ]);
  writeZstdSession(fileB, [
    { type: 'user/message', seq: 1, time: t0 + 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '会话B第一句' }] } },
  ]);
  // 确保 fileB 的 mtime 更新，模拟 B 是全局最新、A 是稍早但刚切回查看的场景
  fs.utimesSync(fileA, new Date(t0), new Date(t0));
  fs.utimesSync(fileB, new Date(t0 + 10_000), new Date(t0 + 10_000));

  const embedCalls = [];
  saveGlobalConfig({
    index: { autoIndex: true },
    embedding: {
      mode: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'auto-test',
      dim: DIM,
    },
  }, { dshHome: dir });

  let mountedHandler = null;
  const ctx = new EventEmitter();
  ctx.logger = silent;
  ctx.get = () => ({ list: () => [] });
  ctx.effect = (fn) => fn();
  ctx.webServer = {
    register(opts) {
      mountedHandler = opts.handler;
      return () => {};
    },
  };

  const cleanup = apply(ctx, {
    dshHome: dir,
    dbPath: path.join(dir, 'verbatim', 'memory.db'),
    embedding: {
      fetchImpl: fakeFetch(embedCalls),
    },
  });

  try {
    const invokePanel = async (method, queryObj = {}) => {
      const qs = new URLSearchParams(queryObj).toString();
      const req = { method: 'GET', url: `/verbatim-api/panel.${method}?${qs}`, on() {} };
      let statusCode = 0;
      let raw = '';
      const res = {
        writeHead(code) { statusCode = code; },
        end(chunk) { raw = String(chunk ?? ''); },
      };
      await mountedHandler(req, res);
      return { statusCode, body: JSON.parse(raw) };
    };

    // 先用面板打开两个会话的记录开关（默认关 —— D-230）
    await invokePanel('set', { sessionId: 'session-aaa', key: 'record', value: true });
    await invokePanel('set', { sessionId: 'session-bbb', key: 'record', value: true });

    // 先查 session-aaa（虽然文件 B 的 mtime 更大，按会话同步必须把 A 同步进来）
    const resA = await invokePanel('status', { sessionId: 'session-aaa' });
    assert.equal(resA.statusCode, 200);
    assert.equal(resA.body.stats.totalMsgs, 1, 'session-aaa 应该被精确同步');

    // 再查 session-bbb（不会因为之前同步过 A 而跳过 B）
    const resB = await invokePanel('status', { sessionId: 'session-bbb' });
    assert.equal(resB.statusCode, 200);
    assert.equal(resB.body.stats.totalMsgs, 1, 'session-bbb 也应该独立同步');

    // 等后台轻量 autoIndex 跑完
    const deadline = Date.now() + 3000;
    while (embedCalls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(embedCalls.length >= 1, '开启 autoIndex 后同步新消息应自动在后台补索引');

    // 再等一小会儿让 SQLite 写完指纹
    let indexed = 0;
    const deadline2 = Date.now() + 3000;
    while (Date.now() < deadline2) {
      const check = await invokePanel('status', { sessionId: 'session-aaa' });
      indexed = check.body.vector.indexed;
      if (indexed === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(indexed, 1, 'session-aaa 的新增消息应已自动写入向量索引');
  } finally {
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
