import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { openDb, getVecTableDim, recreateVecTables } from './store/db.js';
import { createRepo, createExtras } from './store/repo.js';
import { createVectorStore } from './search/vector-store.js';
import { searchRankedNotes } from './search/note-rank.js';
import { createSearchTool } from './tools/memory-search.js';
import { forgetNote } from './tools/memory-forget.js';
import { parseWhen } from './tools/time-route.js';
import { createDbAdmin } from './host/db-admin.js';
import { createSceneOps } from './host/scene-ops.js';
import { decompressFrames } from './ingest/reader.js';
import { createPanelApi, createPanelHandler, PANEL_METHODS, PanelError, API_PREFIX } from '../index.js';

function unitVec(dim, axis, val = 1) {
  const v = new Float32Array(dim);
  v[axis] = val;
  return v;
}

test('vector-store：多会话偏斜大库下渐进扩池不漏召回（fallback 与 vec0 均生效）', () => {
  for (const loadVec of [false, true]) {
    const handle = openDb({ dbPath: ':memory:', loadVec, vecDim: 16 });
    try {
      if (loadVec && !handle.hasVec) continue;
      const repo = createRepo(handle);
      const store = createVectorStore(handle, { dim: 16, overFetch: 2 });

      // 构造 30 条大会话 A 的向量，全都在 axis 0 上更接近查询向量
      const msgsA = [];
      for (let i = 1; i <= 30; i += 1) {
        msgsA.push({
          sessionId: 'sess-large',
          seq: i,
          at: 1_700_000_000_000 + i * 1000,
          speaker: 'user',
          text: `大会话消息 ${i}`,
          inSurface: 1,
        });
      }
      const idsA = repo.insertMsgs(msgsA);

      // 小会话 B 只有 2 条，且在 axis 0 分量略小（排在 Top-30 之后），以前 overFetch=2 时会 0 命中
      const idsB = repo.insertMsgs([
        { sessionId: 'sess-small', seq: 1, at: 1_700_000_100_000, speaker: 'user', text: '小会话的目标消息', inSurface: 1 },
        { sessionId: 'sess-small', seq: 2, at: 1_700_000_101_000, speaker: 'assistant', text: '小会话回复', inSurface: 1 },
      ]);

      const entries = [];
      for (const id of idsA) {
        const v = new Float32Array(16);
        v[0] = 0.99;
        v[1] = 0.14;
        entries.push([id, v]);
      }
      for (const id of idsB) {
        const v = new Float32Array(16);
        v[0] = 0.85;
        v[2] = 0.52;
        entries.push([id, v]);
      }
      store.insertMsgVecs(entries);

      const query = unitVec(16, 0, 1);
      const hits = store.knnMsg(query, 2, { sessionId: 'sess-small', overFetch: 2 });
      assert.equal(hits.length, 2, `loadVec=${loadVec} 时小会话应召回全部 2 条`);
      assert.ok(hits.every((h) => h.sessionId === 'sess-small'));
    } finally {
      handle.close();
    }
  }
});

test('note 检索突破 500 条截断：第 1 条最老笔记在 600 条笔记中仍可被 searchRankedNotes 与 memory_search 找回', async () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    const sid = 'sess-notes-600';

    extras.note.insert({
      sessionId: sid,
      content: '他说自己很喜欢那家巷子口的桂花糕',
      about: 'him',
      at: 1_700_000_000_000,
    });

    for (let i = 1; i <= 599; i += 1) {
      extras.note.insert({
        sessionId: sid,
        content: `日常记录第 ${i} 条：今天一切顺利`,
        about: 'us',
        at: 1_700_000_000_000 + i * 60_000,
      });
    }

    const ranked = await searchRankedNotes({
      extras,
      sessionId: sid,
      query: '桂花糕',
      limit: 50,
    });
    assert.equal(ranked.hits.length, 1);
    assert.match(ranked.hits[0].content, /桂花糕/);

    const tool = createSearchTool({ handle, repo, extras, sessionId: sid, semantic: false });
    const out = await tool.handler({ query: '桂花糕', scope: 'note' });
    assert.match(out, /桂花糕/);
    assert.match(out, /你自己记的 — 1 条/);
  } finally {
    handle.close();
  }
});

test('time-route：默认保持 +08:00，同时支持通过 tzOffsetMs 覆盖时区', () => {
  const ts = Date.UTC(2026, 10, 10, 20, 0, 0); // UTC 20:00 = 上海次日 04:00
  const shanghai = parseWhen('2026-11-11', ts);
  const utc = parseWhen('2026-11-11', ts, { tzOffsetMs: 0 });
  assert.equal(shanghai.from, Date.UTC(2026, 10, 10, 16, 0, 0));
  assert.equal(utc.from, Date.UTC(2026, 10, 11, 0, 0, 0));
});

test('db.js：recreateVecTables 可按新维度重建 vec0 虚表并清理旧维度标记', () => {
  const handle = openDb({ dbPath: ':memory:', vecDim: 1024 });
  try {
    if (!handle.hasVec) return;
    assert.equal(getVecTableDim(handle.db), 1024);

    const repo = createRepo(handle);
    const [id] = repo.insertMsgs([
      { sessionId: 's1', seq: 1, at: 1_700_000_000_000, speaker: 'user', text: '测试维度重建', inSurface: 1 },
    ]);
    handle.db.prepare("UPDATE msg SET vec_model = 'old-model', vec_dim = 1024 WHERE id = ?").run(id);

    const changed = recreateVecTables(handle.db, 768, { hasVec: handle.hasVec });
    assert.equal(changed, true);
    assert.equal(getVecTableDim(handle.db), 768);

    const row = handle.db.prepare('SELECT vec_model, vec_dim FROM msg WHERE id = ?').get(id);
    assert.equal(row.vec_model, null);
    assert.equal(row.vec_dim, null);
  } finally {
    handle.close();
  }
});

test('dbQuery：使用有界迭代截断大结果集并拦截方括号绕过关键字', () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    const msgs = [];
    for (let i = 1; i <= 15; i += 1) {
      msgs.push({ sessionId: 's1', seq: i, at: 1_700_000_000_000 + i * 1000, speaker: 'user', text: `msg ${i}`, inSurface: 1 });
    }
    repo.insertMsgs(msgs);

    class FakeErr extends Error {
      constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
    }
    const admin = createDbAdmin({
      handle,
      db: handle.db,
      repo,
      extras,
      dbPath: ':memory:',
      dbRoot: '',
      stmt: (sql) => handle.db.prepare(sql),
      noteHasSessionColumn: () => true,
      requireSession: (_m, p) => p.sessionId,
      optionalSession: (_m, p) => p.sessionId ?? null,
      readSessionConfig: () => ({}),
      intParam: (v, _n, { def, min, max }) => {
        const n = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def;
        return Math.min(max, Math.max(min, n));
      },
      PanelError: FakeErr,
      logger: { info() {}, warn() {} },
    });

    const res = admin.dbQuery({ sql: 'SELECT id, text FROM msg ORDER BY id', limit: 5 });
    assert.equal(res.rows.length, 5);
    assert.equal(res.rowCount, 5);
    assert.equal(res.truncated, true);

    assert.throws(
      () => admin.dbQuery({ sql: 'SELECT [a] FROM msg; DELETE FROM msg' }),
      /禁止多语句|写入或结构变更/,
    );
  } finally {
    handle.close();
  }
});

test('mediaPreview / setMediaCaption：强会话归属校验与允许目录边界（防越权与任意路径读取）', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-media-sec-'));
  const dshHome = path.join(tmpRoot, 'dsh');
  const outsideDir = path.join(tmpRoot, 'outside');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const insideImg = path.join(dshHome, 'inside.png');
  const outsideImg = path.join(outsideDir, 'secret.png');
  fs.writeFileSync(insideImg, pngBytes);
  fs.writeFileSync(outsideImg, pngBytes);

  const handle = openDb({ dbPath: ':memory:', loadVec: false, dshHome });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    repo.insertMsgs([
      { sessionId: 'sess-a', seq: 1, at: 1_700_000_000_000, speaker: 'user', text: '[img1]', inSurface: 1 },
      { sessionId: 'sess-a', seq: 2, at: 1_700_000_001_000, speaker: 'user', text: '[img2]', inSurface: 1 },
    ]);
    extras.media.replaceForSession('sess-a', [
      { seq: 1, at: 1_700_000_000_000, path: insideImg, width: 1, height: 1 },
      { seq: 2, at: 1_700_000_001_000, path: outsideImg, width: 1, height: 1 },
    ]);
    const msgs = repo.msgsByTimeRange('sess-a', 0, Number.MAX_SAFE_INTEGER, 10, true);
    const mdMap = extras.media.byMsgIds(msgs.map((m) => m.id));
    const mdInside = mdMap.get(msgs[0].id)[0];
    const mdOutside = mdMap.get(msgs[1].id)[0];

    class FakeErr extends Error {
      constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
    }
    const ops = createSceneOps({
      handle,
      db: handle.db,
      repo,
      extras,
      stmt: (sql) => handle.db.prepare(sql),
      requireSession: (_m, p) => p.sessionId,
      intParam: (v, _n, { def, min, max }) => {
        const n = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def;
        return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
      },
      PanelError: FakeErr,
      llmCfg: () => ({ enabled: false }),
      getHostLlm: () => null,
      hasEmbeddingKey: () => false,
      makeEmbeddingProvider: async () => null,
      noteHasSessionColumn: () => true,
      dshHome,
      dbRoot: path.join(dshHome, 'verbatim'),
    });

    // 同会话且在 dshHome 内允许预览
    const okPv = ops.mediaPreview({ id: mdInside.id, sessionId: 'sess-a' });
    assert.equal(okPv.ok, true);

    // 跨会话访问必须拒绝
    assert.throws(
      () => ops.mediaPreview({ id: mdInside.id, sessionId: 'sess-b' }),
      (e) => e instanceof FakeErr && e.code === 'MEDIA_NOT_FOUND' && e.status === 404,
    );
    assert.throws(
      () => ops.setMediaCaption({ id: mdInside.id, sessionId: 'sess-b', caption: 'hijack' }),
      (e) => e instanceof FakeErr && e.code === 'MEDIA_NOT_FOUND' && e.status === 404,
    );

    // 目录外路径必须被拦截，不得读盘
    const blocked = ops.mediaPreview({ id: mdOutside.id, sessionId: 'sess-a' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.kind, 'forbidden');
  } finally {
    handle.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findDuplicateNotes & memory_forget：超过 500 条笔记时准确计数与扫描去重', async () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    const sid = 'sess-560';

    extras.note.insert({ sessionId: sid, content: '周六约好去植物园看郁金香展', about: 'us', at: 1_700_000_000_000 });
    extras.note.insert({ sessionId: sid, content: '周六约好一起去植物园看郁金香展览', about: 'us', at: 1_700_000_001_000 });
    for (let i = 1; i <= 558; i += 1) {
      extras.note.insert({ sessionId: sid, content: `普通流水账编号#${i}：今天一切正常`, about: 'me', at: 1_700_000_002_000 + i * 1000 });
    }

    // 1. memory_forget 找不到编号时，noteInventory 必须报真实总数 560，而不是 500
    const forgetRes = await forgetNote({ id: 999999 }, { handle, repo, extras, sessionId: sid });
    assert.equal(forgetRes.ok, false);
    assert.match(forgetRes.text, /560 条笔记/);

    // 2. findDuplicateNotes 必须扫描全部 560 条并找到最老的那组重复笔记
    class FakeErr extends Error {
      constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
    }
    const ops = createSceneOps({
      handle,
      db: handle.db,
      repo,
      extras,
      stmt: (sql) => handle.db.prepare(sql),
      requireSession: (_m, p) => p.sessionId,
      intParam: (v) => Number(v),
      PanelError: FakeErr,
      llmCfg: () => ({ enabled: false }),
      getHostLlm: () => null,
      hasEmbeddingKey: () => false,
      makeEmbeddingProvider: async () => null,
      noteHasSessionColumn: () => true,
    });
    const dups = ops.findDuplicateNotes({ sessionId: sid });
    assert.equal(dups.scanned, 560);
    assert.ok(dups.groups.some((g) => /植物园/.test(g.keep.content)));
  } finally {
    handle.close();
  }
});

test('decompressFrames：面对连续损坏 magic 帧保持线性有界探测，并仍可恢复后续合法帧', () => {
  const validFrame = zlib.zstdCompressSync(
    Buffer.from(`{"seq":1,"type":"msg","text":"${'x'.repeat(120)}"}\n`, 'utf8'),
  );
  // 构造必败的损坏 zstd 帧：合法 magic + FHD(0x20) + FCS(0x00) + Reserved 块类型(type=3, 0x07 0x00 0x00)
  const badFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x07, 0x00, 0x00]);
  const corruptChunks = [];
  for (let i = 0; i < 40; i += 1) {
    corruptChunks.push(badFrame);
  }
  const combined = Buffer.concat([...corruptChunks, validFrame]);

  const res = decompressFrames(combined);
  assert.match(res.text, /"seq":1/);
  assert.equal(res.stats.ok, 1);
  assert.equal(res.stats.failed, 40);
});

test('index.js 重导出 panel-api 契约符号保持完整', () => {
  assert.equal(typeof createPanelApi, 'function');
  assert.equal(typeof createPanelHandler, 'function');
  assert.equal(typeof PanelError, 'function');
  assert.equal(typeof API_PREFIX, 'string');
  assert.ok(Array.isArray(PANEL_METHODS) && PANEL_METHODS.length >= 20);
});

