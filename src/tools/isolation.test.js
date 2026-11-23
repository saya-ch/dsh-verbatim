/**
 * 会话隔离（A1）—— **根因修复的回归测试**
 *
 * 修复前的 bug（硬编码全库检索，见 DECISIONS / ACCEPTANCE A1）：
 *   src/tools/memory-search.js    `{ sessionId: null, includeExcluded }`   ← 全库检索
 *   src/tools/time-route.js       `repo.scenesByTimeRange(null, ...)`      ← 全库检索
 * 后果：TA在 A 会话里查东西，会翻到 B、C 会话的记忆 —— 所有会话混在一起。
 *
 * 这个文件的做法（对齐 ACCEPTANCE A1 的判定方法）：
 *   造两个会话 A、B 的数据（各 3 条 msg、1 个 scene、1 条 note，而且**同一天**，
 *   不按会话过滤就必然混在一起），然后用绑定 `sessionId: 'sess-A'` 的工具实例查，
 *   断言结果里只有 A 的内容、一条 B 的都没有；再对称验一遍 B。
 *
 * 覆盖 3 个工具：
 *   memory_search（时间路 / 关键词路 / 笔记路）· memory_remember · memory_forget
 * 外加 createSessionToolSet（宿主入口）与「连接共享」。
 *
 * 时间固定注入（NOW），所有断言不依赖真实时钟。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import { saveSessionConfig } from '../config/session-config.js';
import { createSessionToolSet, createToolSet } from './index.js';
import { createSearchTool } from './memory-search.js';
import { createRememberTool } from './memory-remember.js';
import { createForgetTool } from './memory-forget.js';

/* ------------------------------- 测试脚手架 ------------------------------- */

/** 静默 logger，别让降级 warning 刷测试输出 */
const silent = { warn: () => {} };

/** 固定的「现在」：上海 2026-11-17 20:00 */
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

/** 上海时间 → epoch ms（D-172：纯日期不能交给 new Date，会被当 UTC） */
function sh(day, hour = 0, min = 0) {
  return Date.UTC(2026, 10, day, hour - 8, min);
}

/**
 * 造两个会话的数据，**故意放在同一天**：
 *
 *   sess-A  11-16 19:00  3 条（A-1/A-2/A-3）+ 1 场 + 1 条笔记
 *   sess-B  11-16 21:00  3 条（B-1/B-2/B-3）+ 1 场 + 1 条笔记
 *
 * 两条都是「怕黑」，查 `怕黑` / `11-16` 时如果不按会话过滤，必然两边混在一起。
 * 每条原文里带自己的编号，断言「结果里没有 B 的 seq」就是断言没有 B-1/B-2/B-3。
 *
 * @param {{repo: object, extras: object}} store
 */
function seedTwoSessions({ repo, extras }) {
  const build = (sessionId, tag, startAt) => {
    const texts = [`${tag}-1 我怕黑，不开灯也行`, `${tag}-2 那我陪你到睡着`, `${tag}-3 说好不换行`];
    const sceneId = repo.insertScene({
      sessionId,
      startAt,
      endAt: startAt + 2 * 60_000,
      msgCount: texts.length,
    });
    const ids = repo.insertMsgs(
      texts.map((text, i) => ({
        sessionId,
        seq: i + 1,
        at: startAt + i * 60_000,
        speaker: i % 2 === 0 ? 'user' : 'assistant',
        text,
        sceneId,
      })),
    );
    const noteId = extras.note.insert({
      sessionId,
      content: `我的笔记 ${tag}：怕黑这件事`,
      about: 'us',
      at: startAt + 30_000,
    });
    return { sessionId, sceneId, ids, noteId, texts };
  };

  return {
    A: build('sess-A', 'A', sh(16, 19, 0)),
    B: build('sess-B', 'B', sh(16, 21, 0)),
  };
}

/** 一个内存库 + 两个会话的数据 + 按会话绑定的 3 个工具 */
function setup() {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  const repo = createRepo(handle);
  const extras = createExtras(handle);
  const data = seedTwoSessions({ repo, extras });

  /**
   * 造一套「绑定了某个会话」的工具实例 —— 这就是宿主（index.js 的 registerFor）
   * 现在该做的事：每个会话一套，handler 用闭包捕获 sessionId。
   */
  const toolsFor = (sessionId) => {
    const deps = { handle, repo, extras, now: NOW, sessionId };
    return {
      search: createSearchTool(deps),
      remember: createRememberTool(deps),
      forget: createForgetTool(deps),
    };
  };

  return {
    handle,
    repo,
    extras,
    data,
    toolsA: toolsFor('sess-A'),
    toolsB: toolsFor('sess-B'),
    close: () => handle.close(),
  };
}

/* ============================ memory_search 时间路 ============================ */

test('A1/search-time：A 会话翻 11-16 只看到 A 的场次，B 的一条都不出现', async () => {
  const env = setup();
  try {
    const out = await env.toolsA.search.handler({ when: '11-16' });

    // 正例：A 的场次和原文都在
    assert.match(out, /11-16 19:00–19:02/, 'A 会话自己的场次要在');
    assert.match(out, /A-1 我怕黑，不开灯也行/);
    assert.match(out, /A-3 说好不换行/);

    // 反例：B 的一句话、一个场次都不能出现（这就是修复前会漏进来的东西）
    for (const tag of ['B-1', 'B-2', 'B-3']) {
      assert.ok(!out.includes(tag), `A 会话里不该出现 B 会话的 ${tag}（实际输出：\n${out}）`);
    }
    assert.ok(!out.includes('11-16 21:00'), 'B 会话的场景时间头不能出现在 A 的时间轴里');
    assert.match(out, /共 3 轮/, '只统计 A 会话的 3 条（全库会是 6 条）');
  } finally {
    env.close();
  }
});

test('A1/search-time：留空=最近一次聊天，不会翻到 B 会话更晚的那一场', async () => {
  const env = setup();
  try {
    // 不绑会话时「最近一场」是 B 的 21:00；绑定 A 之后必须是 A 自己的 19:00
    const out = await env.toolsA.search.handler({});

    assert.match(out, /11-16 19:00–19:02/, '绑定会话后「最近一次聊天」= 这个会话的最近一场');
    assert.ok(!out.includes('11-16 21:00'), '不能把 B 会话的场次当成 A 的最近一次聊天');
    assert.ok(!out.includes('B-1'));
  } finally {
    env.close();
  }
});

test('A1/search-time：空结果里的「库里有 …」也只算本会话', async () => {
  const env = setup();
  try {
    const out = await env.toolsA.search.handler({ when: '11-01' }); // 那天两边都没聊
    assert.match(out, /没有找到/);
    assert.match(out, /库里有/);
    // A 会话：3 条消息、1 个场景。全库会是 6 条 / 2 个场景（B 的存在被反推出来）
    assert.match(out, /3 条可检索的消息/);
    assert.match(out, /1 个场景/);
    assert.ok(!/6 条可检索的消息/.test(out), '不能把 B 会话的条数算进 A 的库范围');
  } finally {
    env.close();
  }
});

/* ============================= memory_search ============================= */

test('A1/search：A 会话查「怕黑」只命中 A 的 1 条（全库会是 2 条）', async () => {
  const env = setup();
  try {
    const out = await env.toolsA.search.handler({ query: '怕黑' });

    assert.match(out, /^「怕黑」— 1 处$/m, '只算本会话的命中数');
    assert.match(out, /A-1 我怕黑，不开灯也行/);
    // 2026-11-18：M2 之后「没 key」是 vec:off，「有 key 但没索引」是 vec:empty，
    // 两者都算「说明了语义路的状态」，放宽到三态之一
    assert.match(out, /vec:(off|empty|partial)|已显示/);
    assert.ok(!out.includes('B-1 我怕黑'), 'B 会话的原话不能出现在 A 的检索结果里');
  } finally {
    env.close();
  }
});

test('A1/search：scope=note 也只翻本会话的笔记（A1 的 note 路）', async () => {
  const env = setup();
  try {
    const out = await env.toolsA.search.handler({ query: '怕黑', scope: 'note' });

    assert.match(out, /你自己记的 — 1 条/);
    assert.match(
      out,
      new RegExp(`笔记 #${env.data.A.noteId}`),
      '要能看见 A 自己那条笔记的编号',
    );
    assert.ok(out.includes('我的笔记 A'), 'A 的笔记要在');
    assert.ok(!out.includes('我的笔记 B'), 'B 会话记的笔记不能出现在 A 里');
    assert.ok(!out.includes(`笔记 #${env.data.B.noteId}`), 'B 的笔记编号也不该泄露');
  } finally {
    env.close();
  }
});

test('A1/search：空结果的库范围按会话算（不泄露 B 的条数与日期跨度）', async () => {
  const env = setup();
  try {
    const out = await env.toolsA.search.handler({ query: '量子纠缠' });
    assert.match(out, /没有找到跟「量子纠缠」有关的记录/);
    assert.match(out, /3 条可检索的消息/);
    assert.ok(!/6 条可检索的消息/.test(out));
  } finally {
    env.close();
  }
});

/* ============================ memory_remember ============================ */

test('A1/remember：记下的笔记带 A 的归属，B 会话搜不到', async () => {
  const env = setup();
  try {
    const text = await env.toolsA.remember.handler({ content: '只有 A 该看见的一句', about: 'us' });
    assert.match(text, /记下了/);

    // ① 落库时带上 session_id（note 表 v6 新增列）
    const mine = env.extras.note
      .list({ sessionId: 'sess-A' })
      .find((n) => n.content === '只有 A 该看见的一句');
    assert.ok(mine, 'A 会话记的笔记应能按 sessionId 查到');
    assert.equal(env.extras.note.byId(mine.id).sessionId, 'sess-A', 'note.session_id 必须是 A');

    // ② A 自己搜得到，B 搜不到（修复前两边都能搜到）
    const inA = await env.toolsA.search.handler({ query: '只有 A 该看见', scope: 'note' });
    assert.match(inA, /只有 A 该看见的一句/);
    const inB = await env.toolsB.search.handler({ query: '只有 A 该看见', scope: 'note' });
    assert.ok(!inB.includes('只有 A 该看见的一句'), 'B 会话不能搜到 A 会话记的笔记');
  } finally {
    env.close();
  }
});

/* ============================= memory_forget ============================= */

test('A1/forget：B 会话不能删 A 会话的笔记；A 自己删得掉', async () => {
  const env = setup();
  try {
    // B 拿着 A 的笔记编号：必须当"没有"，不能跨会话软删
    const refused = await env.toolsB.forget.handler({ id: env.data.A.noteId });
    assert.match(refused, /没找到编号/);
    assert.equal(env.extras.note.byId(env.data.A.noteId).deletedAt, null, 'A 的笔记不能被 B 删掉');

    // 恢复模式同理：B 也不能把 A 的笔记"恢复"（那同样是在改别人的数据）
    const restore = await env.toolsB.forget.handler({ id: env.data.A.noteId, restore: true });
    assert.match(restore, /没找到编号/);

    // A 自己删得掉（隔离不是把功能关上）
    const done = await env.toolsA.forget.handler({ id: env.data.A.noteId });
    assert.match(done, /忘了/);
    assert.notEqual(env.extras.note.byId(env.data.A.noteId).deletedAt, null);
  } finally {
    env.close();
  }
});

/* ========================== createSessionToolSet ========================== */

test('A1/createSessionToolSet：两个会话各一套工具、共用一条连接，各查各的', async () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    seedTwoSessions({ repo, extras });
    const config = { record: true, tools: true, autoRecall: false, excludeRanges: [] };

    const setA = createSessionToolSet({ handle, repo, extras, sessionId: 'sess-A', config, now: NOW });
    const setB = createSessionToolSet({ handle, repo, extras, sessionId: 'sess-B', config, now: NOW });
    assert.equal(setA.sessionId, 'sess-A');
    assert.equal(setB.sessionId, 'sess-B');

    const searchOf = (set) => set.tools.find((t) => t.name === 'memory_search');
    const outA = await searchOf(setA).handler({ query: '怕黑' });
    const outB = await searchOf(setB).handler({ query: '怕黑' });
    assert.match(outA, /A-1 我怕黑/);
    assert.ok(!outA.includes('B-1'), 'A 的工具实例不能返回 B 的内容');
    assert.match(outB, /B-1 我怕黑/);
    assert.ok(!outB.includes('A-1'), 'B 的工具实例不能返回 A 的内容');

    // 宿主自己持有 handle 时，工具集的 close() 不关别人的连接（谁开的谁关）
    setA.close();
    setB.close();
    const stillOpen = await searchOf(setB).handler({ query: '怕黑' });
    assert.match(stillOpen, /B-1 我怕黑/, '宿主传进来的 handle 归宿主所有，工具集 close() 不该关它');
  } finally {
    handle.close();
  }
});

test('A1/createSessionToolSet：按 dbPath 创建的多个会话共用一条连接（引用计数）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-isolation-pool-'));
  const dbPath = join(dir, 'memory.db');
  try {
    // 先播种（播种用的连接用完就关）
    const seedHandle = openDb({ dbPath, loadVec: false, logger: silent });
    const seedRepo = createRepo(seedHandle);
    const seedExtras = createExtras(seedHandle);
    seedTwoSessions({ repo: seedRepo, extras: seedExtras });
    seedHandle.close();

    const config = { record: true, tools: true, autoRecall: false, excludeRanges: [] };
    const setA = createSessionToolSet({ dbPath, sessionId: 'sess-A', config, now: NOW, loadVec: false });
    const setB = createSessionToolSet({ dbPath, sessionId: 'sess-B', config, now: NOW, loadVec: false });
    const searchOf = (set) => set.tools.find((t) => t.name === 'memory_search');

    assert.match(await searchOf(setA).handler({ query: '怕黑' }), /A-1 我怕黑/);
    assert.match(await searchOf(setB).handler({ query: '怕黑' }), /B-1 我怕黑/);

    // 关掉 A：B 还在用，连接不能被关（否则 B 开始报"库读不到"）
    setA.close();
    assert.match(await searchOf(setB).handler({ query: '怕黑' }), /B-1 我怕黑/, 'A 关闭后 B 必须还能查');

    // 最后一个关掉才真的释放连接
    setB.close();
    const after = await searchOf(setB).handler({ query: '怕黑' });
    assert.match(after, /记忆库现在读不到/, '引用计数归零后连接应已关闭（不是静默返回旧数据）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A1/createSessionToolSet：没给 sessionId 直接抛错（忘绑会话 = 硬闸门）', () => {
  assert.throws(() => createSessionToolSet({}), /必须给 sessionId/);
  assert.throws(() => createSessionToolSet({ sessionId: '   ' }), /必须给 sessionId/);
});

test('A3（工具层）：会话配置按会话读 —— A 关掉 record 不影响 B，也影响不到 A 的读工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-isolation-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'verbatim-isolation-home-'));
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  try {
    // A 把「记录」关了（record=false），B 显式打开 —— 这样才能验证「按会话读」：
    // 如果两个都用默认值（D-230 起默认关），差异测不出来。
    saveSessionConfig('sess-A', { record: false, tools: true }, { dbRoot: dir });
    saveSessionConfig('sess-B', { record: true, tools: true }, { dbRoot: dir });

    const setA = createSessionToolSet({ handle, sessionId: 'sess-A', dbRoot: dir, logger: silent });
    const setB = createSessionToolSet({ handle, sessionId: 'sess-B', dbRoot: dir, logger: silent });

    const namesA = setA.tools.map((t) => t.name);
    const namesB = setB.tools.map((t) => t.name);

    assert.equal(setA.config.record, false, 'A 的配置来自 sessions/sess-A.json');
    assert.equal(setB.config.record, true, 'B 的配置来自 sessions/sess-B.json（与 A 不同）');
    assert.deepEqual(
      namesA,
      ['memory_search', 'memory_forget'],
      'A 关掉 record 后只留 memory_search 和 memory_forget',
    );
    assert.ok(!namesA.includes('memory_remember'), 'A 关掉记录后不该注册写入侧工具');
    assert.ok(!namesA.includes('memory_timeline'), 'memory_timeline 已移除');
    assert.ok(!namesA.includes('memory_flag'), 'memory_flag 已移除');
    assert.deepEqual(
      namesB,
      ['memory_search', 'memory_remember', 'memory_forget'],
      'B 不受 A 的开关影响，全开时注册 3 个工具',
    );

    // 也支持直接给 $DSH_HOME（配置在 <dshHome>/verbatim/sessions/）—— 宿主侧就是这么传的
    saveSessionConfig('sess-A', { tools: false }, { dshHome: home });
    const viaHome = createSessionToolSet({ handle, sessionId: 'sess-A', dshHome: home, logger: silent });
    assert.deepEqual(viaHome.tools, [], 'tools=false → 一个工具都不注册（D-096 省 schema token）');
    assert.equal(viaHome.config.tools, false);
  } finally {
    try {
      handle.close();
    } catch {
      /* 已经关了 */
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/* --------------------- 未绑定会话：历史行为，不许悄悄变成默认 --------------------- */

test('未绑定会话 = 单库模式（历史行为；宿主必须用 createSessionToolSet 绑定）', async () => {
  const env = setup();
  try {
    // 这条不是在"接受"跨会话，而是把兜底行为钉死并显式化：
    // 只有没绑 sessionId 的单库模式（MCP 单会话 / 验收脚本）才不过滤。
    // 宿主（index.js 的 registerFor）必须按会话创建工具 —— 见 A1/createSessionToolSet。
    const unbound = createSearchTool({ repo: env.repo, extras: env.extras, now: NOW });
    const out = await unbound.handler({ query: '怕黑' });
    assert.match(out, /^「怕黑」— 2 处$/m, '未绑会话时是单库视角（A+B 都算）');
  } finally {
    env.close();
  }
});
