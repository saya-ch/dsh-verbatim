/**
 * M1 合并检索的验收单测 —— 组合查询 / 语义路（spy）/ 降级 / RRF 去重
 *
 * 对齐 ACCEPTANCE.md 的 G1~G7：
 *   G1  只给标准化 when（单日 / A..B 区间 / Nd）→ 时间路（场景 + 摘录）
 *   G2  when + query → 只在该时间范围内匹配
 *   G3  关键词命中 < 5 时必须调 embedding；≥ 5 时必须不调（D-147 懒执行）
 *   G4  同一条被关键词 + 语义同时命中 → 只出现一次，RRF 分数累加
 *   G5  没有 embedding key → 返回里明说「语义搜索未启用」
 *   G6  工具瘦身：TOOL_CATALOG 不再包含 memory_timeline / memory_flag，memory_search 是唯一检索工具
 *
 * 跑法：node --test "src/tools/*.test.js"
 *
 * **安全**：全部用内存库或临时目录；不传 dshHome 时也不会写 $DSH_HOME
 * （openDb 只在 loadVec 时复制 dll，这里统一 loadVec:false）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import { mockEmbedding } from '../model/mock.js';
import { createVectorStore } from '../search/vector-store.js';
import { createIndexer } from '../search/indexer.js';
import { TOOL_CATALOG } from './index.js';
import { createSearchTool } from './memory-search.js';

const silent = { warn() {}, info() {} };

/** 固定的"现在"：上海 2026-11-17 20:00（周二） */
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const DIM = 1024;

/** 上海时间 → epoch ms（显式减 8 小时，见 D-172） */
function sh(day, hour = 0, min = 0) {
  return Date.UTC(2026, 10, day, hour - 8, min);
}

let seqCursor = 0;

/** 造一场对话（真库 + 真 repo，不 mock 仓储） */
function addScene(repo, { startAt, texts, sessionId = 's-m1' }) {
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

/** 内存库 + 真 repo/extras */
function freshDb({ dshHome } = {}) {
  const handle = openDb({
    dbPath: ':memory:',
    loadVec: false,
    logger: silent,
    ...(dshHome ? { dshHome } : {}),
  });
  return { handle, repo: createRepo(handle), extras: createExtras(handle) };
}

/** 基础数据：11-09 与 11-15 各有一句「怕黑」；11-17 一场无关对话 */
function seedCombo(repo) {
  seqCursor = 0;
  const d9 = addScene(repo, {
    startAt: sh(9, 2, 0),
    texts: ['11-09 那天我说怕黑', '怕什么', '晚安'],
  });
  const d15 = addScene(repo, {
    startAt: sh(15, 23, 0),
    texts: ['11-15 我也怕黑', '嗯'],
  });
  const d17 = addScene(repo, {
    startAt: sh(17, 9, 0),
    texts: ['今天在忙别的事', '好'],
  });
  return { d9, d15, d17 };
}

function toolsFor(env, deps = {}) {
  const base = { repo: env.repo, extras: env.extras, handle: env.handle, now: NOW, ...deps };
  return {
    search: createSearchTool(base),
  };
}

/* ============================ G1 / G2：时间参数 ============================ */

test('G1：只给标准 when（单日）→ 时间路的场景 + 摘录', async () => {
  const env = freshDb();
  try {
    const { d9 } = seedCombo(env.repo);
    const { search } = toolsFor(env);

    const bySearch = await search.handler({ when: '11-09' });
    assert.match(bySearch, /11-09 02:00–02:02/, '要给场景头');
    assert.match(bySearch, /他：「11-09 那天我说怕黑」/, '要给原话');
    assert.ok(bySearch.includes('11-09 那天我说怕黑'));

    // 时间路不该只给「命中词」，整场都展开
    assert.ok(bySearch.includes('怕什么'), '时间路展开整场，不是只给命中句');
    assert.ok(d9.sceneId > 0);
  } finally {
    env.handle.close();
  }
});

test('G1：A..B 区间与 Nd 相对天数都能圈定时间', async () => {
  const env = freshDb();
  try {
    seedCombo(env.repo);
    const { search } = toolsFor(env);

    const byRange = await search.handler({ when: '2026-11-09..2026-11-10' });
    assert.match(byRange, /11-09 02:00–02:02/);
    assert.ok(!byRange.includes('11-15'), '2026-11-09..2026-11-10 只圈 11-09..11-10');

    const byDays = await search.handler({ when: '1d' });
    assert.match(byDays, /11-17 09:00–09:01/, 'when: "1d" = 今天');
    assert.ok(!byDays.includes('11-15'), 'when: "1d" 不该翻到两天前');
  } finally {
    env.handle.close();
  }
});

test('G2：when + query 只在候选里匹配（11-15 那条不能混进来）', async () => {
  const env = freshDb();
  try {
    seedCombo(env.repo);
    const { search } = toolsFor(env);

    const all = await search.handler({ query: '怕黑' });
    assert.ok(all.includes('11-09 那天我说怕黑'), '不加时间时两条都在');
    assert.ok(all.includes('11-15 我也怕黑'), '不加时间时两条都在');

    const combo = await search.handler({ when: '11-09', query: '怕黑' });
    assert.ok(combo.includes('11-09 那天我说怕黑'), '11-09 那条要在');
    assert.ok(!combo.includes('11-15 我也怕黑'), '11-15 那条**不能**出现在 11-09 的查询里（G2）');
    assert.match(combo, /「怕黑」— 1 处/, '总数只算候选里的');
    assert.match(combo, /只在 .*11-09.* 里找/, '要说清这次只在哪段时间里找');
  } finally {
    env.handle.close();
  }
});

test('G2：A..B 区间与 Nd 都能组合 query 查询', async () => {
  const env = freshDb();
  try {
    seedCombo(env.repo);
    const { search } = toolsFor(env);

    const rangeCombo = await search.handler({ when: '2026-11-09..2026-11-10', query: '怕黑' });
    assert.ok(rangeCombo.includes('11-09 那天我说怕黑'));
    assert.ok(!rangeCombo.includes('11-15 我也怕黑'), '2026-11-09..2026-11-10 只匹配 11-09');

    // NOW=11-17，3d 覆盖 11-15..11-17
    const recent = await search.handler({ when: '3d', query: '怕黑' });
    assert.ok(recent.includes('11-15 我也怕黑'));
    assert.ok(!recent.includes('11-09 那天我说怕黑'), '3d 不该包含 11-09');
  } finally {
    env.handle.close();
  }
});

test('G1：when 支持完整 ISO 日期写法', async () => {
  const env = freshDb();
  try {
    seedCombo(env.repo);
    const { search } = toolsFor(env);

    const iso = await search.handler({ when: '2026-11-15' });
    assert.match(iso, /11-15 23:00–23:01/);
    assert.ok(!iso.includes('11-09'), '2026-11-15 只圈 11-15');
  } finally {
    env.handle.close();
  }
});

test('A1 延伸：when + query 组合也按会话隔离（不串到别人的场次）', async () => {
  const env = freshDb();
  try {
    seqCursor = 0;
    addScene(env.repo, { startAt: sh(9, 2, 0), texts: ['A-1 我说怕黑'], sessionId: 'sess-A' });
    addScene(env.repo, { startAt: sh(9, 3, 0), texts: ['B-1 我也怕黑'], sessionId: 'sess-B' });
    const toolA = createSearchTool({ repo: env.repo, extras: env.extras, handle: env.handle, now: NOW, sessionId: 'sess-A' });

    const out = await toolA.handler({ when: '11-09', query: '怕黑' });
    assert.match(out, /A-1 我说怕黑/);
    assert.ok(!out.includes('B-1 我也怕黑'), 'A 会话的组合查询不能翻到 B 会话');
  } finally {
    env.handle.close();
  }
});

/* ============================ G3 / G4：语义路 ============================ */

/**
 * 造一个「关键词能命中 N 条 + 有一条语义上必然排第一」的库，并把向量索引建好。
 *
 * 关键：查询串直接用某条消息的原文，mock embedding 同文本同向量 → 余弦 = 1，
 * 所以那一条一定同时被关键词路和向量路命中（用来验证 G4 的去重与分数累加）。
 */
async function semanticEnv() {
  const env = freshDb();
  seqCursor = 0;
  const scene = addScene(env.repo, {
    startAt: sh(17, 9, 0),
    texts: [
      '第1句说到月见草',
      '第2句说到月见草',
      '第3句说到月见草',
      '第4句说到月见草',
      '第5句说到月见草',
      '第6句说到月见草',
      '我只在夜里说怕黑',
    ],
  });
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
  assert.equal(store.countMsgVec(), 7, '前置条件：7 条都已索引');
  return { ...env, scene, provider, store };
}

test('G3：始终混合检索 —— 无论关键词命中 1 条还是 6 条，都执行向量路', async () => {
  const env = await semanticEnv();
  try {
    const captured = [];
    const { search } = toolsFor(env, {
      provider: env.provider,
      store: env.store,
      onResult: (info) => captured.push(info),
    });

    // —— 6 条：依然跑向量路，不漏语义召回 ——
    const before = env.provider.calls.length;
    await search.handler({ query: '月见草' });
    const highKw = captured.at(-1);
    assert.equal(highKw.meta.counts.keyword, 6, '关键词应命中 6 条');
    assert.equal(highKw.meta.vectorSkipped, false, '始终混合检索：命中 ≥5 也照跑语义路');
    assert.equal(env.provider.calls.length, before + 1, '查询要 embed 一次');

    // —— 1 条：同样跑语义检索 ——
    const before2 = env.provider.calls.length;
    await search.handler({ query: '我只在夜里说怕黑' });
    const ran = captured.at(-1);
    assert.equal(ran.meta.counts.keyword, 1, '关键词应命中 1 条');
    assert.equal(ran.meta.vectorSkipped, false, '必须补语义路');
    assert.equal(env.provider.calls.length, before2 + 1, '查询要 embed 一次');
    assert.ok(ran.meta.counts.vector > 0, '向量路应该有结果');
  } finally {
    env.handle.close();
  }
});

test('G4：同一条被两路命中只出现一次，RRF 分数是累加的', async () => {
  const env = await semanticEnv();
  try {
    let captured = null;
    const { search } = toolsFor(env, {
      provider: env.provider,
      store: env.store,
      onResult: (info) => {
        captured = info;
      },
    });

    // 查询 = 某条消息原文 → 关键词命中它（1 条）+ 向量路也第一名命中它
    const out = await search.handler({ query: '我只在夜里说怕黑' });
    assert.ok(captured, '应当回调 onResult');

    const target = captured.keywordRows[0];
    assert.equal(target.text, '我只在夜里说怕黑');
    const same = captured.hits.filter((h) => Number(h.id) === Number(target.id));
    assert.equal(same.length, 1, '同一条被两路命中只能出现一次（去重）');
    assert.ok(same[0].sources.includes('keyword'), '来源要有 keyword');
    assert.ok(same[0].sources.includes('vector'), '来源要有 vector');
    assert.ok(
      Math.abs(same[0].rrfScore - 2 / 61) < 1e-12,
      `RRF 分数要累加：期望 2/61，实际 ${same[0].rrfScore}`,
    );
    assert.equal(same[0].rr.score || same[0].rr.keyword, 1);
    assert.equal(same[0].rr.vector, 1, '两路都是第一名');
    // 输出里也只出现一次（标题里回显的 query 不算命中块内的重复）
    // 2026-11-18：命中按场景块渲染，场景内消息缩进 6 空格（原来是 4）
    const bodyHits = out.match(/^ {6}我只在夜里说怕黑$/gm) ?? [];
    assert.equal(bodyHits.length, 1, '输出里该消息的原文只出现一次');
  } finally {
    env.handle.close();
  }
});

test('语义路抛错 → 用关键词结果继续，并说明原因（不静默少一路）', async () => {
  const env = freshDb();
  try {
    seqCursor = 0;
    addScene(env.repo, { startAt: sh(17, 9, 0), texts: ['我怕黑', '嗯'] });
    const brokenProvider = {
      id: 'mock:broken@1024',
      dim: DIM,
      maxBatch: 32,
      async embed() {
        throw new Error('网络超时');
      },
    };
    let captured = null;
    const { search } = toolsFor(env, {
      provider: brokenProvider,
      store: { knnMsg: () => [] },
      onResult: (info) => {
        captured = info;
      },
    });

    const out = await search.handler({ query: '怕黑' });
    assert.match(out, /比起|我怕黑/, '关键词结果照常给');
    assert.match(out, /vec:err/, '降级要在返回里说话');
    assert.match(out, /网络超时/, '原因要带上');
    assert.equal(captured.meta.degraded, true);
    assert.match(captured.meta.vectorError, /网络超时/, 'meta 里也要写清原因');
  } finally {
    env.handle.close();
  }
});

/* ============================ G5：降级文案 ============================ */

test('G5：没有 embedding key 时明说「语义搜索未启用」，不能静默', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-m1-'));
  const env = freshDb({ dshHome: dir });
  try {
    // 配置里指一个一定不存在的环境变量名（只写临时目录，绝不碰 $DSH_HOME）
    mkdirSync(join(dir, 'verbatim'), { recursive: true });
    writeFileSync(
      join(dir, 'verbatim', 'config.json'),
      JSON.stringify({
        embedding: { model: 'test/model', dim: DIM, apiKeyEnv: 'VERBATIM_M1_NO_SUCH_KEY' },
      }),
      'utf8',
    );
    delete process.env.VERBATIM_M1_NO_SUCH_KEY;

    seqCursor = 0;
    addScene(env.repo, { startAt: sh(17, 9, 0), texts: ['我怕黑', '嗯'] });

    const { search } = toolsFor(env);
    const out = await search.handler({ query: '怕黑' });

    assert.match(out, /怕黑/, '关键词结果照常给');
    assert.ok(out.includes('语义搜索未启用'), `返回里必须明说（G5），实际：\n${out}`);
    // 2026-11-18 起：不再逼人设环境变量，换成「去设置页填 key / 改成本地服务」
    assert.ok(/设置|本地/.test(out), `要给出可操作的出路，实际：\n${out}`);
  } finally {
    env.handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G5：语义不可用时空结果也要说明（不是空白）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-m1-'));
  const env = freshDb({ dshHome: dir });
  try {
    mkdirSync(join(dir, 'verbatim'), { recursive: true });
    writeFileSync(
      join(dir, 'verbatim', 'config.json'),
      JSON.stringify({
        embedding: { model: 'test/model', dim: DIM, apiKeyEnv: 'VERBATIM_M1_NO_SUCH_KEY2' },
      }),
      'utf8',
    );
    delete process.env.VERBATIM_M1_NO_SUCH_KEY2;

    seqCursor = 0;
    addScene(env.repo, { startAt: sh(17, 9, 0), texts: ['今天在忙别的事', '好'] });

    const { search } = toolsFor(env);
    const out = await search.handler({ query: '量子纠缠' });
    assert.match(out, /没有找到跟「量子纠缠」有关的记录/);
    assert.match(out, /库里有/);
    assert.ok(out.includes('语义搜索未启用'));
  } finally {
    env.handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================ G7：描述与工具瘦身 ============================ */

test('G7：描述里不写实现细节，参数收敛为标准化 when（含 2026-11-09 / .. / 7d，不含 from/to/days）', () => {
  const search = createSearchTool({ semantic: false });
  const text = `${search.description}\n${JSON.stringify(search.parameters)}`;
  assert.ok(
    !/trigram|LIKE|向量|RRF|bm25|FTS|embedding|余弦|sqlite-vec/i.test(text),
    'G7：不能把实现手段写进描述',
  );
  assert.ok(!/memory_timeline/i.test(text), '描述与参数不再提及已移除的 memory_timeline');

  const props = search.parameters.properties;
  for (const removed of ['from', 'to', 'days']) {
    assert.equal(props[removed], undefined, `不再有 ${removed} 参数`);
  }
  assert.equal(typeof props.when?.description, 'string', 'when 必须有参数说明');
  assert.match(props.when.description, /2026-11-09/);
  assert.match(props.when.description, /\.\./);
  assert.match(props.when.description, /7d/);
  assert.equal(typeof props.query?.description, 'string', 'query 必须有参数说明');
  assert.match(props.query.description, /when/);
  assert.match(search.description, /when/);
  assert.match(search.description, /query/);
});

test('G6：工具瘦身 —— TOOL_CATALOG 不再包含 memory_timeline 和 memory_flag，memory_search 是唯一检索工具', () => {
  const names = TOOL_CATALOG.map((t) => t.name);
  assert.ok(!names.includes('memory_timeline'), 'TOOL_CATALOG 不应再包含 memory_timeline');
  assert.ok(!names.includes('memory_flag'), 'TOOL_CATALOG 不应再包含 memory_flag');
  assert.deepEqual(names, ['memory_search', 'memory_remember', 'memory_forget']);
  const readTools = TOOL_CATALOG.filter((t) => t.kind === 'read').map((t) => t.name);
  assert.deepEqual(readTools, ['memory_search'], 'memory_search 必须是唯一的检索工具');
});
