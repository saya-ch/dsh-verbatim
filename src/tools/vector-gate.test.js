/**
 * M2：向量索引「空跑」止血的单测 + 建索引入口的端到端验证（2026-11-18）
 *
 * 背景（实测证据，真实库 `~/.dsh/verbatim/memory.db`）：
 *   msg 7479 行 / vec_msg 0 行 / 已索引 0 条，但语义路照跑 ——
 *   TA查一次就白付一次 embedding 网络调用（100~500ms + 钱），最后什么也召回不到。
 *
 * 本文件验证：
 *   ① 索引 0 条 → embedding 调用 **0 次**，输出含 `vec:empty`
 *   ② 索引覆盖率低（< 50%）→ **0 次** embedding，输出含 `vec:partial` + 覆盖率数字
 *   ③ 索引满 → 正常跑，输出有 `kw+vec` 标记
 *   ④ `vec:off` / `vec:empty` / `vec:partial` 三种状态各说各的，不混成一句
 *   ⑤ `panel.rebuild({ scope: 'vector' })` 真能把 0 条建成 N 条（mock provider，不联网）
 *      且没有 key 时当场拒绝（可发现 / 可操作）。
 *
 * 安全：全部内存库 / os.tmpdir() 临时目录；**绝不写 $DSH_HOME、绝不碰真实 memory.db**。
 * （嵌入用的是 config.embedding.fetchImpl 注入的假 fetch，不发任何网络请求。）
 *
 * 跑法：node --test "src/tools/*.test.js"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import { mockEmbedding, textToVector } from '../model/mock.js';
import { createVectorStore } from '../search/vector-store.js';
import { createIndexer } from '../search/indexer.js';
import { createSearchTool } from './memory-search.js';
import { createPanelApi } from '../../index.js';

const silent = { warn() {}, info() {} };

/** 固定的「现在」：上海 2026-11-17 20:00（周二） */
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const DIM = 1024;

/** 上海时间 → epoch ms（显式减 8 小时，见 D-172） */
function sh(day, hour = 0, min = 0) {
  return Date.UTC(2026, 10, day, hour - 8, min);
}

let seqCursor = 0;

/** 内存库 + 真 repo/extras（不传 dshHome，也不写任何用户目录） */
function freshDb() {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  return { handle, repo: createRepo(handle), extras: createExtras(handle) };
}

/** 造一场对话（真 repo，不 mock 仓储） */
function addMsgs(repo, texts, { sessionId = 's-m2', startAt = sh(17, 9, 0) } = {}) {
  const msgs = texts.map((text, i) => {
    seqCursor += 1;
    return {
      sessionId,
      seq: seqCursor,
      at: startAt + i * 60_000,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      text,
      inSurface: 1,
    };
  });
  const sceneId = repo.insertScene({
    sessionId,
    startAt: msgs[0].at,
    endAt: msgs[msgs.length - 1].at,
    msgCount: msgs.length,
    leadIn: null,
  });
  const ids = repo.insertMsgs(msgs.map((m) => ({ ...m, sceneId })));
  return { sceneId, ids, msgs };
}

/** 该会话的全部消息行（索引器 indexMsgs 用） */
function allMsgs(repo, sessionId = 's-m2') {
  return repo.msgsByTimeRange(sessionId, 0, Number.MAX_SAFE_INTEGER, 1000);
}

function toolFor(env, deps = {}) {
  return createSearchTool({
    repo: env.repo,
    extras: env.extras,
    handle: env.handle,
    now: NOW,
    sessionId: 's-m2',
    ...deps,
  });
}

/* ══════════════════════════ ① 空索引：一次都不 embed ══════════════════════════ */

test('M2-①：索引 0 条 → embedding 调用 0 次，输出写明 vec:empty', async () => {
  const env = freshDb();
  try {
    seqCursor = 0;
    addMsgs(env.repo, ['今天在忙别的事', '好']);
    const provider = mockEmbedding(DIM);
    const store = createVectorStore(env.handle, { dim: DIM, logger: silent });
    assert.equal(store.countMsgVec(), 0, '前置条件：索引是空的');

    let captured = null;
    const tool = toolFor(env, {
      provider,
      store,
      onResult: (info) => {
        captured = info;
      },
    });

    const out = await tool.handler({ query: '量子纠缠' });
    assert.equal(provider.calls.length, 0, '索引空时**一次 embedding 都不能调**（M2 止血）');
    assert.match(out, /vec:empty/, `输出必须写明 vec:empty，实际：\n${out}`);
    assert.match(out, /0 \/ 2/, '要带上「0 / 全库条数」');
    assert.equal(captured.meta, null, '根本没跑向量路，不该有融合 meta');
    assert.equal(captured.vectorIndex.usable, false);
    assert.equal(captured.vectorIndex.tag, 'vec:empty');

    // 关键词有命中的情况下也照样说明（非空结果走 footer）
    const withHits = await tool.handler({ query: '今天' });
    assert.ok(withHits.includes('今天在忙别的事'), '关键词结果照常给');
    assert.match(withHits, /vec:empty/, '非空结果里也要说清语义路没跑');
    assert.equal(provider.calls.length, 0, '有关键词命中也不能偷偷补 embed');
  } finally {
    env.handle.close();
  }
});

/* ══════════════════════ ② 部分索引：不跑 + 写出覆盖率 ══════════════════════ */

test('M2-②：索引只覆盖 3/10（30%）→ 不跑语义路，输出写明 vec:partial + 覆盖率', async () => {
  const env = freshDb();
  try {
    seqCursor = 0;
    addMsgs(
      env.repo,
      Array.from({ length: 10 }, (_, i) => `第${i + 1}句说到月见草`),
    );
    const provider = mockEmbedding(DIM);
    const store = createVectorStore(env.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({
      handle: env.handle,
      provider,
      extras: env.extras,
      store,
      logger: silent,
    });
    // 只索引前 3 条 —— 模拟「建到一半 / 只建了老消息」的库
    const indexed = await indexer.indexMsgs(allMsgs(env.repo).slice(0, 3));
    assert.equal(indexed, 3);
    assert.equal(store.countMsgVec(), 3);

    let captured = null;
    const tool = toolFor(env, {
      provider,
      store,
      onResult: (info) => {
        captured = info;
      },
    });
    const before = provider.calls.length; // indexMsgs 自己调过一次

    // 命中 1 条（< 阈值 5）：没有闸门的话这里会补一次 embedding
    const out = await tool.handler({ query: '第7句' });

    assert.equal(provider.calls.length, before, '覆盖率不足时**不能**再花一次 embedding');
    assert.match(out, /vec:partial/, `输出必须写明 vec:partial，实际：\n${out}`);
    assert.match(out, /3\/10/, '要写出 已索引/全库');
    assert.match(out, /30\.0%/, '要写出覆盖率百分比');
    assert.match(out, /不是全库检索/, '必须让TA知道这不是全库检索');
    assert.equal(captured.vectorIndex.usable, false);
    assert.equal(captured.vectorIndex.tag, 'vec:partial');
    assert.ok(Math.abs(captured.vectorIndex.ratio - 0.3) < 1e-9);
    assert.equal(captured.meta, null);
  } finally {
    env.handle.close();
  }
});

/* ══════════════════════════ ③ 索引满：正常跑 + 标记 ══════════════════════════ */

test('M2-③：索引满（100%）→ 正常补语义路，输出有 kw+vec 标记', async () => {
  const env = freshDb();
  try {
    seqCursor = 0;
    addMsgs(env.repo, [
      '第1句说到月见草',
      '第2句说到月见草',
      '第3句说到月见草',
      '第4句说到月见草',
      '第5句说到月见草',
      '第6句说到月见草',
      '我只在夜里说怕黑',
    ]);
    const provider = mockEmbedding(DIM);
    const store = createVectorStore(env.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({
      handle: env.handle,
      provider,
      extras: env.extras,
      store,
      logger: silent,
    });
    await indexer.indexPending();
    assert.equal(store.countMsgVec(), 7, '前置条件：满索引');

    let captured = null;
    const tool = toolFor(env, {
      provider,
      store,
      onResult: (info) => {
        captured = info;
      },
    });
    const before = provider.calls.length;
    const out = await tool.handler({ query: '我只在夜里说怕黑' });

    assert.equal(provider.calls.length, before + 1, '满索引时该补一次 embedding');
    assert.equal(captured.meta.vectorSkipped, false);
    assert.ok(captured.meta.counts.vector > 0, '向量路应有结果');
    assert.equal(captured.vectorIndex.usable, true);
    assert.match(out, /kw\+vec|vec [\d.]+/, '两路都命中的条目要带 kw+vec 标记');
    assert.ok(!/vec:(empty|partial)/.test(out), '满索引不该出现空/部分标记');
  } finally {
    env.handle.close();
  }
});

/* ══════════════════ ④ off / empty / partial 三种状态不混 ══════════════════ */

test('M2-④：vec:off / vec:empty / vec:partial 各说各的，不混成一句「语义不可用」', async () => {
  const partialEnv = freshDb();
  const emptyEnv = freshDb();
  try {
    // —— off：调用方关掉语义路 ——
    seqCursor = 0;
    addMsgs(partialEnv.repo, Array.from({ length: 4 }, (_, i) => `第${i + 1}句说到月见草`));
    const provider = mockEmbedding(DIM);
    const store = createVectorStore(partialEnv.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({
      handle: partialEnv.handle,
      provider,
      extras: partialEnv.extras,
      store,
      logger: silent,
    });
    await indexer.indexMsgs(allMsgs(partialEnv.repo).slice(0, 1)); // 1/4 = 25% → partial

    const offOut = await toolFor(partialEnv, { semantic: false }).handler({ query: '第9句' });
    assert.match(offOut, /vec:off/);
    assert.ok(!/vec:empty|vec:partial/.test(offOut), 'off 不能混进 empty/partial');

    const partialOut = await toolFor(partialEnv, { provider, store }).handler({ query: '第9句' });
    assert.match(partialOut, /vec:partial/);
    assert.ok(!/vec:off|vec:empty/.test(partialOut), 'partial 不能混进 off/empty');

    // —— empty：有 key 有 store，但索引是空的 ——
    seqCursor = 0;
    addMsgs(emptyEnv.repo, ['今天在忙别的事']);
    const emptyStore = createVectorStore(emptyEnv.handle, { dim: DIM, logger: silent });
    const emptyOut = await toolFor(emptyEnv, {
      provider: mockEmbedding(DIM),
      store: emptyStore,
    }).handler({ query: '第9句' });
    assert.match(emptyOut, /vec:empty/);
    assert.ok(!/vec:off|vec:partial/.test(emptyOut), 'empty 不能混进 off/partial');
  } finally {
    partialEnv.handle.close();
    emptyEnv.handle.close();
  }
});

/* ═════════════ ⑤ panel.rebuild({scope:'vector'})：0 条 → N 条 ═════════════ */

const KEY_ENV = 'VERBATIM_M2_TEST_EMBED_KEY';

/**
 * 造一个「假 fetch」当 embedding 提供方：不发网络请求，返回确定性的 1024 维向量。
 * 走的是 panel 自己的装配路径（config.embedding.fetchImpl → createSiliconFlowEmbedding），
 * 所以验证的是**真的 panel.rebuild**，不是绕过它直接调 indexer。
 */
function fakeEmbeddingFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    calls.push({ url: String(url), count: inputs.length });
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

/** 轮询重建任务直到结束（走 api.call，和前端同一条路径） */
async function waitTask(api, taskId, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const task = await api.call('task', { taskId });
    if (task.state !== 'running') return task;
    if (Date.now() - started > timeoutMs) throw new Error(`重建任务超时：${JSON.stringify(task)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('M2-③入口：panel.rebuild({scope:"vector"}) 把 0 条建成 N 条（mock provider）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-m2-'));
  const previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'test-key-not-a-real-one';
  const handle = openDb({ dbPath: ':memory:', dshHome: dir, loadVec: false, logger: silent });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    seqCursor = 0;
    const seeded = addMsgs(repo, ['十一月初我说怕黑', '我记得', '后来开了灯', '嗯', '晚安'], {
      sessionId: 's-m2',
    });
    const N = seeded.ids.length;

    const embedCalls = [];
    const api = createPanelApi({
      handle,
      repo,
      extras,
      dbPath: ':memory:',
      dshHome: dir,
      logger: silent,
      config: {
        embeddingKeyEnv: KEY_ENV,
        embedding: {
          model: 'test/m2-mock',
          dim: DIM,
          apiKeyEnv: KEY_ENV,
          baseURL: 'http://mock.invalid/v1',
          fetchImpl: fakeEmbeddingFetch(embedCalls),
        },
      },
    });

    // —— 重建前：面板显示 0 / N（B6 的那个数字） ——
    const before = await api.call('status', { sessionId: 's-m2' });
    assert.equal(before.vector.indexed, 0);
    assert.equal(before.vector.total, N);
    assert.equal(before.vector.hasKey, true);

    // —— 真的走 panel.rebuild({scope:'vector'}) ——
    const { taskId } = await api.call('rebuild', { sessionId: 's-m2', scope: 'vector' });
    const task = await waitTask(api, taskId);
    assert.equal(task.state, 'done', `重建应该成功，实际：${JSON.stringify(task)}`);
    assert.equal(task.result.msgs, N, `索引条数应为 ${N}，实际 ${task.result.msgs}`);
    assert.ok(embedCalls.length > 0, '应该真的调了 embedding（假 fetch）');

    // —— 重建后：0 → N，而且向量表里真的有 ——
    const after = await api.call('status', { sessionId: 's-m2' });
    assert.equal(after.vector.indexed, N, `面板索引数应该从 0 变成 ${N}`);
    assert.equal(after.vector.total, N);
    assert.equal(after.vector.model, `sf:test/m2-mock@${DIM}`);

    const store = createVectorStore(handle, { dim: DIM, logger: silent });
    assert.equal(store.countMsgVec(), N, 'vec 表里应该是 N 条');

    // —— 建完之后语义路真的能跑（不再是 vec:empty） ——
    const searchProvider = {
      id: `sf:test/m2-mock@${DIM}`,
      dim: DIM,
      maxBatch: 32,
      calls: [],
      async embed(texts) {
        this.calls.push(texts.slice());
        return texts.map((t) => textToVector(t, DIM));
      },
    };
    let captured = null;
    const tool = createSearchTool({
      handle,
      repo,
      extras,
      now: NOW,
      sessionId: 's-m2',
      provider: searchProvider,
      store,
      onResult: (info) => {
        captured = info;
      },
    });
    const out = await tool.handler({ query: '十一月初我说怕黑' });
    assert.equal(captured.vectorIndex.usable, true, '建完之后不该再被闸门拦');
    assert.match(out, /kw\+vec|vec [\d.]+/, '两路命中要带标记');
    assert.ok(!/vec:(empty|partial|off)/.test(out), `不该再报不可用：\n${out}`);

    // —— 没有 key 时当场拒绝（可发现 / 可操作，E4） ——
    delete process.env[KEY_ENV];
    await assert.rejects(
      api.call('rebuild', { sessionId: 's-m2', scope: 'vector' }),
      (error) => {
        assert.equal(error.code, 'NO_EMBEDDING');
        // 2026-11-18 起：不再只说「环境变量没配」，而是给出可操作的两条路（设置页填 key / 改本地）
        assert.match(error.message, /设置|本地/);
        assert.match(error.message, /语义搜索未启用/);
        return true;
      },
      '没有 embedding key 时应立刻明确拒绝，而不是先返回 taskId 再后台失败',
    );
  } finally {
    handle.close();
    if (previousKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Qwen3-Embedding 查询自动补 Instruct 前缀，非 Qwen3 模型保持原样', async () => {
  const env = freshDb();
  try {
    seqCursor = 0;
    addMsgs(env.repo, ['第1句说到月见草', '我只在夜里说怕黑']);
    const base = mockEmbedding(DIM);
    const qwenProvider = {
      ...base,
      id: 'sf:Qwen/Qwen3-Embedding-0.6B@8',
      model: 'Qwen/Qwen3-Embedding-0.6B',
    };
    const store = createVectorStore(env.handle, { dim: DIM, logger: silent });
    const indexer = createIndexer({
      handle: env.handle,
      provider: qwenProvider,
      extras: env.extras,
      store,
      logger: silent,
    });
    await indexer.indexPending();

    const tool = toolFor(env, { provider: qwenProvider, store });
    const before = base.calls.length;
    await tool.handler({ query: '夜里怕黑' });
    const queryTexts = base.calls.slice(before).flatMap((c) => c.texts);
    assert.equal(queryTexts.length, 1);
    assert.match(queryTexts[0], /^Instruct: .+\nQuery: 夜里怕黑$/);
  } finally {
    env.handle.close();
  }
});

test('weakEvidenceHint：Qwen3-Reranker 使用 0.45 地板，默认 Reranker 保持 0.15', async () => {
  const { weakEvidenceHint } = await import('./memory-search.js');
  const hits = [{ rerankScore: 0.30, score: 0.90 }];
  assert.equal(weakEvidenceHint(hits, 1, 'BAAI/bge-reranker-v2-m3'), null);
  assert.match(String(weakEvidenceHint(hits, 1, 'Qwen/Qwen3-Reranker-4B')), /相关度偏低/);
});
