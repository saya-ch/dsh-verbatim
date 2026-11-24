import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

import { openDb, SCHEMA_VERSION } from './store/db.js';
import { createRepo, createExtras } from './store/repo.js';
import { readSessionFile, readSessionFileIncremental } from './ingest/reader.js';
import { importSession } from './pipeline.js';
import { createVectorStore } from './search/vector-store.js';
import { createPanelApi, createPanelHandler } from './host/panel-api.js';

function frameOf(lines) {
  return zlib.zstdCompressSync(Buffer.from(lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8'));
}

function makeReq({ method = 'GET', url = '/verbatim-api/panel.status', headers = {}, body = '' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  let status = 0;
  let headers = {};
  let raw = '';
  return {
    writeHead(code, h) {
      status = code;
      headers = h ?? {};
    },
    end(chunk) {
      if (chunk) raw += String(chunk);
    },
    result() {
      return { status, headers, body: raw ? JSON.parse(raw) : null };
    },
  };
}

test('readSessionFileIncremental + importSession：尾部增量解压、快速入库与 rewind 自动回退', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-inc-'));
  const sessionDir = path.join(dir, 'sessions', 'ws', 'sess-inc');
  fs.mkdirSync(sessionDir, { recursive: true });
  const logFile = path.join(sessionDir, 'session.v4.jsonl.zstd');
  const dbRoot = path.join(dir, 'verbatim');
  const sessCfgDir = path.join(dbRoot, 'sessions');
  fs.mkdirSync(sessCfgDir, { recursive: true });
  fs.writeFileSync(path.join(sessCfgDir, 'sess-inc.json'), JSON.stringify({ record: true, tools: true }));

  const t0 = 1_763_000_000_000;
  const f1 = frameOf([
    { type: 'session', id: 'sess-inc', time: t0 },
    { seq: 1, time: t0 + 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句你好' }] } },
    { seq: 2, time: t0 + 2000, type: 'assistant/message', data: { content: [{ type: 'text', text: '你好呀' }] } },
  ]);
  fs.writeFileSync(logFile, f1);

  const handle = openDb({ dbPath: path.join(dbRoot, 'memory.db'), dshHome: dir, loadVec: false });
  try {
    const readerCache = new Map();
    const r1 = await importSession(logFile, { handle, dbRoot, readerCache, quiet: true });
    assert.equal(r1.ingest.inserted, 2);
    assert.equal(r1.ingest.incremental, false);

    // 命中缓存（未改文件）
    const cached = readSessionFileIncremental(logFile, readerCache.get(path.resolve(logFile)));
    assert.equal(cached.incremental, 'hit');
    assert.equal(cached.events.length, 2);

    // 追加一帧普通对话 → 走尾部增量解压与增量入库
    const f2 = frameOf([
      { seq: 3, time: t0 + 3000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二句晚安' }] } },
      { seq: 4, time: t0 + 4000, type: 'assistant/message', data: { content: [{ type: 'text', text: '晚安好梦' }] } },
    ]);
    fs.appendFileSync(logFile, f2);
    const r2 = await importSession(logFile, { handle, dbRoot, readerCache, quiet: true });
    assert.equal(r2.ingest.incremental, true);
    assert.equal(r2.ingest.inserted, 2);

    const repo = createRepo(handle);
    const allMsgs = repo.msgsByTimeRange('sess-inc', 0, Number.MAX_SAFE_INTEGER, 100, true);
    assert.equal(allMsgs.length, 4);
    assert.equal(allMsgs[3].text, '晚安好梦');

    // 追加一帧 rewind → 自动退出快路径，走全量导出并物理删除被撤回消息
    const f3 = frameOf([
      { seq: 5, time: t0 + 5000, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, data: { source: { kind: 'dsh-rewind' } } },
    ]);
    fs.appendFileSync(logFile, f3);
    const r3 = await importSession(logFile, { handle, dbRoot, readerCache, quiet: true });
    assert.equal(r3.ingest.incremental, false);
    assert.equal(r3.ingest.deleted, 2);

    const afterRewind = repo.msgsByTimeRange('sess-inc', 0, Number.MAX_SAFE_INTEGER, 100, true);
    assert.deepEqual(afterRewind.map((m) => m.seq), [1, 2]);
    assert.equal(readSessionFile(logFile).events.length, afterRewind.length + 3);
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vector-store：降级模式多会话预过滤与大批量 hydrate 分片不超变量上限', () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false });
  try {
    const repo = createRepo(handle);
    const dim = 8;
    const store = createVectorStore(handle, { dim, hasVec: false });

    // sess-big 写入 220 条，sess-small 写入 5 条（确保触发 >200 的预过滤分支）
    const bigMsgs = [];
    for (let i = 1; i <= 220; i += 1) {
      bigMsgs.push({
        sessionId: 'sess-big',
        seq: i,
        at: 1_700_000_000_000 + i * 1000,
        speaker: 'user',
        text: `大会话消息 ${i}`,
        inSurface: 1,
      });
    }
    repo.insertMsgs(bigMsgs);
    repo.insertMsgs([
      { sessionId: 'sess-small', seq: 1, at: 1_700_100_001_000, speaker: 'user', text: '小会话唯一目标', inSurface: 1 },
      { sessionId: 'sess-small', seq: 2, at: 1_700_100_002_000, speaker: 'assistant', text: '小会话回复', inSurface: 1 },
    ]);

    const bigRows = repo.msgsByTimeRange('sess-big', 0, Number.MAX_SAFE_INTEGER, 1000, true);
    const smallRows = repo.msgsByTimeRange('sess-small', 0, Number.MAX_SAFE_INTEGER, 100, true);

    const vBig = [1, 0, 0, 0, 0, 0, 0, 0];
    const vSmall = [0, 1, 0, 0, 0, 0, 0, 0];
    store.insertMsgVecs([
      ...bigRows.map((r) => [r.id, vBig]),
      ...smallRows.map((r) => [r.id, vSmall]),
    ]);

    // sess-small 查询必须只命中 sess-small
    const hits = store.knnMsg(vSmall, 5, { sessionId: 'sess-small', minScore: 0.5 });
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.sessionId === 'sess-small'));

    // 大批量 hydrate（> 400 个 ID）不得报 SQLITE_MAX_VARIABLE_NUMBER 错误
    const many = store.knnMsg(vBig, 500, { sessionId: 'sess-big', minScore: -1 });
    assert.equal(many.length, 220);
  } finally {
    handle.close();
  }
});

test('dbQuery：setAuthorizer 拦截 WITH RECURSIVE 防单线程卡死，且不破坏内存库后续写入', async () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    repo.insertMsgs([
      { sessionId: 's1', seq: 1, at: 1_700_000_000_000, speaker: 'user', text: 'hello', inSurface: 1 },
    ]);
    const api = createPanelApi({ handle, repo, extras, dbPath: ':memory:' });

    // 非递归 CTE 与只读查询正常放行
    const ok = await api.call('dbQuery', { sql: 'WITH cte AS (SELECT id, text FROM msg) SELECT * FROM cte', limit: 5 });
    assert.equal(ok.rowCount, 1);

    // 无限递归 CTE 必须被 SQLite Authorizer 拦截
    await assert.rejects(
      () => api.call('dbQuery', { sql: 'WITH RECURSIVE inf(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM inf) SELECT * FROM inf' }),
      (e) => e.code === 'READONLY_SQL',
    );

    // 拦截后，主连接的 authorizer 必须被清理，后续正常写库不得失败
    const noteId = extras.note.insert({ sessionId: 's1', content: '正常笔记', about: 'me', at: 1_700_000_001_000 });
    assert.ok(noteId > 0);
  } finally {
    handle.close();
  }
});

test('createPanelHandler：校验 Origin / sec-fetch-site 防跨站请求，放行同源与本地回环别名', async () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false });
  try {
    const api = createPanelApi({ handle, dbPath: ':memory:' });
    const handler = createPanelHandler(api);

    // 无 Origin 头（CLI / 测试环境）放行
    const resNoOrigin = makeRes();
    await handler(makeReq({ url: '/verbatim-api/panel.dbOverview' }), resNoOrigin);
    assert.equal(resNoOrigin.result().status, 200);

    // 同源 Origin 放行
    const resSame = makeRes();
    await handler(makeReq({
      url: '/verbatim-api/panel.dbOverview',
      headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' },
    }), resSame);
    assert.equal(resSame.result().status, 200);

    // 本机回环别名（localhost vs 127.0.0.1 同端口）放行
    const resLoopback = makeRes();
    await handler(makeReq({
      url: '/verbatim-api/panel.dbOverview',
      headers: { host: '127.0.0.1:4321', origin: 'http://localhost:4321' },
    }), resLoopback);
    assert.equal(resLoopback.result().status, 200);

    // 跨站 Origin 拦截 403
    const resEvilOrigin = makeRes();
    await handler(makeReq({
      method: 'POST',
      url: '/verbatim-api/panel.dbQuery',
      headers: { host: '127.0.0.1:4321', origin: 'https://evil.example' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    }), resEvilOrigin);
    assert.equal(resEvilOrigin.result().status, 403);
    assert.equal(resEvilOrigin.result().body.code, 'FORBIDDEN_ORIGIN');

    // sec-fetch-site: cross-site 拦截 403
    const resCrossSite = makeRes();
    await handler(makeReq({
      url: '/verbatim-api/panel.dbOverview',
      headers: { 'sec-fetch-site': 'cross-site' },
    }), resCrossSite);
    assert.equal(resCrossSite.result().status, 403);

    // 不支持的 HTTP 方法返回 405
    const resMethod = makeRes();
    await handler(makeReq({ method: 'DELETE', url: '/verbatim-api/panel.dbOverview' }), resMethod);
    assert.equal(resMethod.result().status, 405);
  } finally {
    handle.close();
  }
});

test('fact 表 v16 迁移与 session_id 隔离：不同会话同名 key 互不覆盖、互不可见', () => {
  assert.equal(SCHEMA_VERSION, 16);
  const handle = openDb({ dbPath: ':memory:', loadVec: false });
  try {
    const repo = createRepo(handle);
    repo.upsertFact({ sessionId: 'sess-a', subject: 'me', key: '称呼', value: '阿止', sourceSeq: 1, origin: 'extracted_from_user', createdAt: 100 });
    repo.upsertFact({ sessionId: 'sess-b', subject: 'me', key: '称呼', value: '小林', sourceSeq: 1, origin: 'extracted_from_user', createdAt: 200 });

    const a = repo.factsBySubject('me', 50, 'sess-a');
    const b = repo.factsBySubject('me', 50, 'sess-b');
    assert.equal(a.length, 1);
    assert.equal(a[0].value, '阿止');
    assert.equal(b.length, 1);
    assert.equal(b[0].value, '小林');
  } finally {
    handle.close();
  }
});

test('bin/mcp-memory.mjs：同会话下切换配置热重载 tools/list 无需重启', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-mcp-hot-'));
  const sessionDir = path.join(dir, 'sessions', 'ws', 'sess-mcp');
  const cfgDir = path.join(dir, 'verbatim', 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  const t0 = 1_763_000_000_000;
  fs.writeFileSync(
    path.join(sessionDir, 'session.v4.jsonl.zstd'),
    frameOf([
      { type: 'session', id: 'sess-mcp', time: t0 },
      { seq: 1, time: t0 + 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '测试 MCP' }] } },
    ]),
  );
  const cfgFile = path.join(cfgDir, 'sess-mcp.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ record: false, tools: false }));

  const child = spawn(process.execPath, [path.resolve('bin/mcp-memory.mjs')], {
    env: { ...process.env, DSH_HOME: dir, VERBATIM_SESSION_ID: 'sess-mcp' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const callRpc = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 5000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    await callRpc(1, 'initialize');
    const r1 = await callRpc(2, 'tools/list');
    assert.equal(r1.result.tools.length, 0);

    // 同一会话把 tools 改成 true（确保 mtime 发生变化）
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(cfgFile, JSON.stringify({ record: true, tools: true }));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(cfgFile, future, future);

    const r2 = await callRpc(3, 'tools/list');
    assert.deepEqual(r2.result.tools.map((t) => t.name), ['memory_search', 'memory_remember', 'memory_forget']);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
