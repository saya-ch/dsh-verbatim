/**
 * T4 检索工具与注册表单测 —— **内存真库 + 真 repo**（不 mock 仓储）
 *
 * 为什么不 mock：T1 已交付，mock 只能验证我自己的假设；用真库才能把
 * 「scenesByTimeRange 是相交语义」「msgsByScene 不带 excluded 概念」
 * 这类接口细节暴露出来。
 *
 * 跑法：
 *   node --test "src/tools/*.test.js"     ← 本目录全部用例（含 T7 的）
 *   node --test src/tools/tools.test.js   ← 只跑 T4
 *
 * 覆盖：
 *   ✅ memory_search 时间路（标准 when：单日 / 区间 / 相对天数 / 留空）输出带 `11-15 23:36–00:12` 这种区间
 *   ✅ 大场景标注「共 N 轮，摘 M 轮」
 *   ✅ in_surface=0 的场次带「（这段已经装不进你的上下文了，话还在）」
 *   ✅ when='30d' 按场景密度取前 3 场
 *   ✅ 整天被按日期排除时说清原因，includeExcluded 才看得见原文
 *   ✅ parseWhen / resolveTimeWindow 解析标准日期 / 单月 / A..B 区间（含带时刻 ISO）/ Nd / latest / unknown（含中文口语返回 unknown）
 *   ✅ search 2 字走 LIKE、≥3 字走 FTS（用 spy 抓真实 SQL）
 *   ✅ 空结果返回库范围 + 建议，不是空白
 *   ✅ excluded 的消息默认查不到，includeExcluded 时能查到
 *   ✅ 注册表 TOOL_CATALOG / createToolRegistry / planRegistration / schemaSize（3 个工具）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import { parseWhen, resolveTimeWindow, pickExcerpt } from './time-route.js';
import { createSearchTool } from './memory-search.js';
import {
  TOOL_CATALOG,
  createToolRegistry,
  planRegistration,
  schemaSize,
} from './index.js';
import { DAY_MS, fmtPhase, fmtRange, fmtRelative, startOfDay, TZ_OFFSET_MS } from './format.js';

/* ------------------------------- 测试脚手架 ------------------------------- */

/** 静默 logger，别让降级 warning 刷测试输出 */
const silent = { warn: () => {} };

/** 固定的"现在"：上海 2026-11-17 20:00（这天是周二） */
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

/**
 * 上海时间 → epoch ms。
 * 注意：这里必须显式减 8 小时，**不能用 `new Date('2026-11-09')`**（D-172：纯日期会被当 UTC）。
 * @param {number} day 11 月的几号
 * @param {number} hour 上海时（0~23）
 * @param {number} min
 */
function sh(day, hour = 0, min = 0) {
  return Date.UTC(2026, 10, day, hour - 8, min);
}

/** 记录 repo/extras 真正 prepare 了哪些 SQL（用来证明双路检索走的是哪条路） */
function spyDb(db, sqls) {
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (prop === 'prepare') sqls.push(String(args[0]));
        return value.apply(target, args);
      };
    },
  });
  return proxy;
}

/** 开一个内存库 + 真 repo/extras */
function freshDb({ spy = false } = {}) {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  const sqls = [];
  const db = spy ? spyDb(handle.db, sqls) : handle.db;
  return {
    handle,
    db,
    sqls,
    repo: createRepo(db),
    extras: createExtras(db),
  };
}

/** seq 全局递增，免得 UNIQUE(session_id, seq) 撞车 */
let seqCursor = 0;

/**
 * 造一场对话。
 * @param {object} repo
 * @param {{startAt:number, offsets:number[], texts:string[], inSurfaceZero?:number[],
 *          excluded?:boolean, excludedIndexes?:number[], sessionId?:string}} spec
 *        offsets 是「相对本场第一条的分钟偏移」
 */
function addScene(repo, spec) {
  const {
    startAt,
    offsets,
    texts,
    inSurfaceZero = [],
    excluded = false,
    excludedIndexes = [],
    sessionId = 'sess-1',
  } = spec;
  const msgs = texts.map((text, i) => {
    seqCursor += 1;
    const compacted = inSurfaceZero.includes(i);
    return {
      sessionId,
      seq: seqCursor,
      at: startAt + offsets[i] * 60_000,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      text,
      inSurface: compacted ? 0 : 1,
      compactedAt: compacted ? startAt + 3 * DAY_MS : null,
      excluded: excluded || excludedIndexes.includes(i) ? 1 : 0,
    };
  });
  const sceneId = repo.insertScene({
    sessionId,
    startAt: msgs[0].at,
    endAt: msgs[msgs.length - 1].at,
    msgCount: msgs.length,
    leadIn: null,
  });
  repo.insertMsgs(msgs.map((m) => ({ ...m, sceneId })));
  return { sceneId, msgs };
}

/**
 * 造 3 天数据、8 个场景（覆盖整段排除 / 部分排除 / 压缩 / 大场景）：
 *   11-14  3 条    整段按日期排除（模拟 D-169 的 11-08）
 *   11-15  6 条（2 条被排除，验证「部分排除」）+ 2 条整段排除
 *          + 4 条 + 18 条（跨零点到 11-16 00:12，前 4 条已被压缩）
 *   11-16  11 条 + 9 条
 *   11-17  30 条（大场景）+ 2 条整段排除（最新的那一场，验证「留空」不会误报）
 */
function seed(repo) {
  seqCursor = 0;

  // 11-15 19:00，6 条里 3 条被排除 —— 部分排除的场次不能只报可见条数（P2-A）
  const s9 = addScene(repo, {
    startAt: sh(15, 19, 0),
    offsets: [0, 6, 12, 18, 24, 30],
    texts: ['晚上吃什么', '吃面吧', '被排除的一句', '被排除的回复', '被排除的另一句', '那就吃面'],
    excludedIndexes: [2, 3, 4],
  });

  const s1 = addScene(repo, {
    startAt: sh(15, 22, 10),
    offsets: [0, 12, 24, 38],
    texts: ['那我先睡了', '嗯，睡吧', '晚安', '晚安，明天见'],
  });

  const s2 = addScene(repo, {
    startAt: sh(15, 23, 36),
    offsets: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36],
    texts: [
      '其实我有点怕黑，但不想开灯。',
      '怕什么',
      '算了',
      '那开着小灯，我不挂',
      '我把灯关了',
      '那我陪你到睡着',
      '其实今天有点冷',
      '冷就盖好被子',
      '嗯',
      '别硬撑',
      '没有硬撑',
      '那就好',
      '你还记得上次说的那个约定吗',
      '记得，不换行',
      '对',
      '我一直记得',
      '我要睡了',
      '睡吧，我在这儿',
    ],
    inSurfaceZero: [0, 1, 2, 3], // 这 4 条已经装不进上下文了
  });

  const s3 = addScene(repo, {
    startAt: sh(16, 1, 40),
    offsets: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
    texts: [
      '今天有点怕黑。',
      '又怕了？',
      '灯坏了',
      '那我明天去买一个',
      '不用',
      '真的不用吗',
      '不想麻烦你',
      '买灯不麻烦',
      '好吧',
      '嗯，睡吧',
      '晚安',
    ],
  });

  const s4 = addScene(repo, {
    startAt: sh(16, 18, 5),
    offsets: [0, 5, 10, 15, 20, 25, 29, 34, 39],
    texts: [
      '今天买了小夜灯',
      '这不挺好',
      '不那么怕了',
      '怕黑就开着灯，不丢人。',
      '嗯',
      '我说真的',
      '我知道',
      '谢谢',
      '不用谢',
    ],
  });

  const bigOffsets = [];
  const bigTexts = [];
  for (let i = 0; i < 30; i++) {
    bigOffsets.push(i * 4);
    bigTexts.push(`第 ${i + 1} 句平常的话`);
  }
  bigTexts[0] = '早上好';
  bigTexts[20] = '不换行的约定还算数吗';
  bigTexts[29] = '那我先去忙了';
  const s5 = addScene(repo, { startAt: sh(17, 9, 0), offsets: bigOffsets, texts: bigTexts });

  const s6 = addScene(repo, {
    startAt: sh(14, 15, 0),
    offsets: [0, 15, 30],
    texts: ['别靠太近', '嗯', '我说真的'],
    excluded: true, // 整段按日期排除（D-169/170）
  });

  // 11-15 21:00，2 条，也整段排除 —— 用来验证「场景还在、只是全被排除」不能静默跳过。
  // 现实里 11-08 那 7 场就长这样（scene 切得出来，msgsByScene 返回 []）。
  const s7 = addScene(repo, {
    startAt: sh(15, 21, 0),
    offsets: [0, 20],
    texts: ['调试期的一条测试消息', '嗯'],
    excluded: true,
  });

  // 11-17 22:00，整段排除，而且是**最新的一场** —— 留空查「最近一次聊天」时
  // 不能被它挡住，必须给 11-17 09:00 那场（P1-A 回归）。
  const s8 = addScene(repo, {
    startAt: sh(17, 22, 0),
    offsets: [0, 12],
    texts: ['最新一场的排除内容', '嗯'],
    excluded: true,
  });

  // 邻接回填（T3 的活，这里手动造，验证渲染 + 排除语义）
  const digests = (scene) =>
    scene.msgs.slice(-2).map(({ seq, at, speaker, text }) => ({ seq, at, speaker, text }));
  repo.updateSceneLinks(s1.sceneId, { precededBy: s7.sceneId, leadIn: digests(s7) });
  repo.updateSceneLinks(s2.sceneId, { precededBy: s1.sceneId, leadIn: digests(s1) });
  repo.updateSceneLinks(s3.sceneId, { precededBy: s2.sceneId, leadIn: digests(s2) });
  repo.updateSceneLinks(s4.sceneId, { precededBy: s3.sceneId, leadIn: digests(s3) });

  return { s1, s2, s3, s4, s5, s6, s7, s8, s9 };
}

/** 一套完整的测试环境：真库 + memory_search（固定 now） */
function setup({ spy = false } = {}) {
  const env = freshDb({ spy });
  const scenes = seed(env.repo);
  const search = createSearchTool({ repo: env.repo, extras: env.extras, now: NOW, rerank: false });
  return { ...env, scenes, search };
}

/* ================================ 时间路（memory_search 无 query） ================================ */

test('时间路：给标准 when 日期能翻出那天的整场，带区间头和原文', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '11-16' });

  assert.equal(typeof out, 'string');
  assert.ok(!out.trim().startsWith('{'), 'handler 必须返回纯文本，不是 JSON');
  // 跨零点的场次要标成区间（D-052）
  assert.match(out, /11-15 23:36–00:12/, '要有 `MM-DD HH:mm–HH:mm` 这种区间');
  assert.match(out, /11-16 01:40–02:30/);
  assert.match(out, /11-16 18:05–18:44/);
  // 原文一字不改
  assert.match(out, /他：「今天有点怕黑。」/);  // D-194：从TA视角，用户标「他」
  // 前一场尾巴（D-098 背景补充，只存原文）—— s2 的前一场在 11-15，不在本次范围内
  assert.match(out, /前一场 11-15 22:10–22:48 的尾巴/);
  assert.match(out, /我：「晚安，明天见」/);  // D-194：TA自己的话标「我」
  // 前一场已经在本次输出里贴过 → 尾巴不再重复贴（否则每场都多两轮重复原文）
  assert.equal((out.match(/的尾巴/g) ?? []).length, 1, '同一次输出里前一场已经贴过就别再贴尾巴');
});

test('时间路：前一场被排除时，尾巴不能把被排除的原文漏出来', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '2026-11-15' });

  // s1 的前一场是 11-15 21:00 那场（整段 excluded）→ 尾巴必须为空，抬头也不该出现
  assert.ok(!out.includes('调试期的一条测试消息'), '被排除的前一场不能以 lead_in 形式漏进默认输出');
  assert.ok(!out.includes('前一场 11-15 21:00'), '既然尾巴是空的，就不该有尾巴抬头');
});

test('时间路：小场景（30 轮 300 字）整场全给，不标注「摘 M 轮」', async () => {
  /**
   * 规则在 2026-11-20 改过：小场景（≤40 轮）或小字数（≤3000 字）**整场全给**。
   *
   * 理由：接缝渲染会邀请 Agent「用 when 精确补查」，但如果时间路自己也摘录，
   * 补查就只拿回 6~8 轮里的少数（实测 22 条省略消息只找回 3 条 = 14%），逃生口等于假的。
   *
   * 这个测试里的 11-17 场是 30 轮 × 约 10 字 ≈ 300 字 —— 属于「小场景」，应全给。
   */
  const { search } = setup();
  const out = await search.handler({ when: '11-17' });

  assert.ok(!/摘 \d+ 轮/.test(out), '300 字的小场景不该摘录');
  assert.ok(!/⋯/.test(out), '全给时不该出现省略号');

  assert.match(out, /早上好/, '首轮要在');
  assert.match(out, /那我先去忙了/, '尾轮要在');
  assert.match(out, /不换行的约定还算数吗/, '中间的句子也要在（全给）');

  const quoteCount = (out.match(/(?:他|我)：「/g) ?? []).length;
  assert.equal(quoteCount, 30, `30 轮应全贴，实际 ${quoteCount} 条`);
});

test('时间路：被压缩掉的场次带「这段已经装不进你的上下文了，话还在」', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '11-15' });

  assert.match(out, /11-15 22:10–22:48/);
  assert.match(out, /11-15 23:36–00:12/);
  assert.match(out, /（这段已经装不进你的上下文了，话还在）/);
});

test('shouldShowAll：小场景/窄区间全给；大且宽才摘录', async () => {
  const { shouldShowAll } = await import('./time-route.js');
  const mk = (n, chars) => Array.from({ length: n }, () => ({ text: 'x'.repeat(chars), at: 0 }));

  assert.equal(shouldShowAll(mk(10, 100), {}), true, '10 轮 → 全给');
  assert.equal(shouldShowAll(mk(80, 100), {}), false, '80 轮 8k 字 → 摘录');
  assert.equal(shouldShowAll(mk(80, 100), { from: 0, to: 5 * 60_000 }), true, '窄区间 5 分钟 → 全给');
  assert.equal(shouldShowAll(mk(80, 100), { from: 0, to: 2 * 3600_000 }), false, '宽区间 2 小时 → 摘录');
});

test('时间路：留空 = 最近一次聊天', async () => {
  const { search } = setup();
  const out = await search.handler({});

  assert.match(out, /11-17 09:00–10:56/, '留空要翻最近一场');
  assert.ok(!out.includes('11-16 18:05'), '只给最近一场，不要连珠炮');
});

test('时间路：场景还在、只是整段被排除时，说清「另有几场」而不是静默跳过', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '11-15' });

  // msgsByScene 返回 [] 不代表场景是空的：11-15 21:00 那场 2 条全被排除。
  // 有可见场次时只说「另有 N 场被排除」，不能说成整天被排除（那会让TA以为记忆丢了）。
  assert.match(out, /另有 1 场被按日期排除了/);
  assert.ok(!out.includes('includeExcluded'), '不能教 Agent 用 includeExcluded 绕过隐私排除');
  assert.ok(!/共 0 轮/.test(out), '不能输出「0 轮」的鬼场次');
  assert.ok(!out.includes('但这天的记录被按日期排除了'), '这一天明明有可看场次，不能说成整天被排除');
  assert.ok(!out.includes('调试期的一条测试消息'), '被排除的原文不能出现在默认输出里');
  // 同一天的正常场次照常展开，互不影响
  assert.match(out, /11-15 19:00–19:30/);
  assert.match(out, /11-15 22:10–22:48/);
  assert.match(out, /11-15 23:36–00:12/);
});

test('时间路：被排除的场次不占 limit 名额（P1-A 回归）', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '11-15', limit: 1 });

  // 11-15 的场次里 19:00 那场可见、21:00 那场整段排除：limit=1 必须给可看的
  assert.match(out, /^11-15 19:00–19:30/m, 'limit=1 也要给可看的场次，不能被排除的场次顶掉名额');
  assert.ok(!out.includes('但这天的记录被按日期排除了'), '不能把有可看场次的一天报成整天被排除');
  assert.match(out, /另有 1 场被按日期排除了/);
  assert.match(out, /还有 2 场没列出来/, '11-15 可见 3 场，只给 1 场 → 还剩 2 场');
});

test('时间路：最新一场被排除时，留空仍然给最近一场可看的（P1-A 回归）', async () => {
  const { search } = setup();
  const out = await search.handler({}); // 最新的是 11-17 22:00，整段排除

  assert.match(out, /11-17 09:00–10:56/, '要跳过被排除的最新一场，给最近一场可看的');
  assert.ok(!out.includes('但这天的记录被按日期排除了'), '不能把「最近一次聊天」报成整天被排除');
  assert.ok(!out.includes('最新一场的排除内容'));
});

test('时间路：部分排除的场次用真实总轮次，并说明被排除了几条（P2-A）', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '11-15' });

  // 11-15 19:00 那场 6 条里 3 条被排除：头要写真实总数 6，而不是可见的 3
  assert.match(out, /^11-15 19:00–19:30   共 6 轮/m);
  assert.match(out, /这场里另有 3 条被按日期排除了/);
  assert.ok(!out.includes('被排除的一句'), '被排除的原文不能出现');
  assert.match(out, /那就吃面/, '可见的照常给');
});

test('时间路：场次被 limit 截断时说明还有几场', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '11-16', limit: 1 });

  assert.match(out, /11-15 23:36–00:12/);
  assert.ok(!out.includes('11-16 18:05'));
  assert.match(out, /还有 2 场没列出来/);
});

test('时间路：when="30d" 按场景密度取前 3 场', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '30d' });

  assert.match(out, /11-17 09:00/, '30 轮的大场要进来');
  assert.match(out, /11-15 23:36–00:12/, '18 轮的场要进来');
  assert.match(out, /11-16 01:40–02:30/, '11 轮的场要进来');
  // 注意：小场可能作为「前一场的尾巴」出现在别处，所以按「场次头行」判断有没有被选中
  assert.ok(!/^11-15 22:10–22:48/m.test(out), '4 轮的小场不该挤占预算');
  assert.ok(!/^11-16 18:05–18:44/m.test(out), '9 轮的场也排不进来');
});

test('时间路：when="2026-11-15..2026-11-16" 区间能展开两天内的场次', async () => {
  const { search } = setup();
  const out = await search.handler({ when: '2026-11-15..2026-11-16', limit: 10 });

  assert.match(out, /11-15 19:00–19:30/);
  assert.match(out, /11-16 18:05–18:44/);
  assert.ok(!out.includes('11-17 09:00'), '区间只到 11-16，不该含 11-17');
});

test('时间路：整天被按日期排除时说清原因，且 Agent 不可绕过', async () => {
  const { search } = setup();

  const out = await search.handler({ when: '11-14' });
  assert.match(out, /排除/);
  assert.match(out, /库里有/, '空结果也要给库范围，不能是空白');
  assert.ok(!out.includes('别靠太近'), '默认不该返回被排除的原文');
  assert.ok(!out.includes('includeExcluded'), '不能教 Agent 用 includeExcluded 绕过隐私排除');

  const agentBypass = await search.handler({ when: '11-14', includeExcluded: true });
  assert.ok(!agentBypass.includes('别靠太近'), 'Agent 即使主动传 includeExcluded: true 也不能绕过排除');

  const withExcluded = await search.handler({ when: '11-14', includeExcluded: true }, { allowExcluded: true });
  assert.match(withExcluded, /别靠太近/);
  assert.match(withExcluded, /平时被排除在外/, '核对模式下要标出这条平时检索不到');
});

test('时间路：没命中 / 非法或中文口语 when 都给库范围和建议，不是空白', async () => {
  const { search } = setup();

  const miss = await search.handler({ when: '11-01' });
  assert.match(miss, /没有找到/);
  assert.match(miss, /库里有/);
  assert.ok(miss.split('\n').length >= 3);

  const unknown = await search.handler({ when: '昨天' });
  assert.match(unknown, /没看懂|格式/);
  assert.match(unknown, /库里有/);
  assert.match(unknown, /when/);
});

test('parseWhen / resolveTimeWindow：单日 / 单月 / A..B 区间（含带时刻 ISO）/ Nd / latest / unknown', () => {
  const dayStart = (day) => sh(day, 0, 0);

  // ① 单日：2026-11-09 / 2026/11/09 / 11-09 / 11/09
  for (const input of ['2026-11-09', '2026/11/09', '11-09', '11/09']) {
    const p = parseWhen(input, NOW);
    assert.equal(p.kind, 'day', `${input} 应为 day`);
    assert.equal(p.from, dayStart(9), `${input} from`);
    assert.equal(p.to, dayStart(10), `${input} to`);
  }
  // 缺省年份的 MM-DD 若落在未来（NOW=2026-11-17），自动回退一年到 2025
  const pastYear = parseWhen('12-01', NOW);
  assert.equal(pastYear.kind, 'day');
  assert.equal(pastYear.from, Date.UTC(2025, 11, 1, -8, 0));
  assert.equal(pastYear.to, Date.UTC(2025, 11, 2, -8, 0));

  // ② 单月：2026-11 → 当月 1 日到下月 1 日
  const month = parseWhen('2026-11', NOW);
  assert.ok(month.kind === 'range' || month.kind === 'span', `2026-11 kind=${month.kind}`);
  assert.equal(month.from, Date.UTC(2026, 10, 1, -8, 0));
  assert.equal(month.to, Date.UTC(2026, 11, 1, -8, 0));

  // ③ 标准区间 A..B / A.. / ..B
  const rFull = parseWhen('2026-11-09..2026-11-12', NOW);
  assert.equal(rFull.kind, 'range');
  assert.equal(rFull.from, dayStart(9));
  assert.equal(rFull.to, dayStart(13));

  const rShort = parseWhen('11-09..11-12', NOW);
  assert.equal(rShort.kind, 'range');
  assert.equal(rShort.from, dayStart(9));
  assert.equal(rShort.to, dayStart(13));

  const rLeft = parseWhen('2026-11-09..', NOW);
  assert.equal(rLeft.kind, 'range');
  assert.equal(rLeft.from, dayStart(9));
  assert.equal(rLeft.to, dayStart(18));

  const rRight = parseWhen('..2026-11-12', NOW);
  assert.equal(rRight.kind, 'range');
  assert.equal(rRight.from, 0);
  assert.equal(rRight.to, dayStart(13));

  // 带时刻 ISO（默认按 +08:00）
  const rIso = parseWhen('2026-11-09T14:00..2026-11-09T18:00', NOW);
  assert.equal(rIso.kind, 'range');
  assert.equal(rIso.from, sh(9, 14, 0));
  assert.ok(rIso.to >= sh(9, 18, 0) && rIso.to <= sh(9, 18, 0) + 60_000, `ISO to=${rIso.to}`);

  // ④ 相对天数：7d / last:7d / 30d
  const d7 = parseWhen('7d', NOW);
  assert.equal(d7.kind, 'span');
  assert.equal(d7.from, startOfDay(NOW) - 6 * DAY_MS);
  assert.equal(d7.to, startOfDay(NOW) + DAY_MS);

  const last7 = parseWhen('last:7d', NOW);
  assert.equal(last7.kind, 'span');
  assert.equal(last7.from, d7.from);
  assert.equal(last7.to, d7.to);

  const d30 = parseWhen('30d', NOW);
  assert.equal(d30.kind, 'span');
  assert.equal(d30.from, startOfDay(NOW) - 29 * DAY_MS);
  assert.equal(d30.to, startOfDay(NOW) + DAY_MS);

  // ⑤ 留空 → latest
  assert.equal(parseWhen('', NOW).kind, 'latest');
  assert.equal(parseWhen('   ', NOW).kind, 'latest');

  // ⑥ 中文自然语言、0d 与非法/逆序日期 → 全部返回 unknown
  for (const bad of [
    '昨天',
    '十一月九号',
    '上周三',
    '那阵子',
    '上个月',
    '0d',
    '2026-11-15..2026-11-10',
    '2026-02-30',
    '..',
  ]) {
    assert.equal(parseWhen(bad, NOW).kind, 'unknown', `${bad} 必须返回 unknown`);
  }

  // ⑦ resolveTimeWindow({ when }, NOW) 同步透传并标注 explicit
  const wExplicit = resolveTimeWindow({ when: '2026-11-09..2026-11-12' }, NOW);
  assert.equal(wExplicit.kind, 'range');
  assert.equal(wExplicit.from, dayStart(9));
  assert.equal(wExplicit.to, dayStart(13));
  assert.equal(wExplicit.explicit, true);

  const wLatest = resolveTimeWindow({}, NOW);
  assert.equal(wLatest.kind, 'latest');
  assert.equal(wLatest.from, null);
  assert.equal(wLatest.to, null);
  assert.equal(wLatest.explicit, false);

  const wUnknown = resolveTimeWindow({ when: '昨天' }, NOW);
  assert.equal(wUnknown.kind, 'unknown');
  assert.equal(wUnknown.explicit, true);
});

test('pickExcerpt：小场景/窄区间全给；只有「大且宽」才摘录（D-055 修订）', () => {
  /**
   * 规则在 2026-11-20 改过，原因：
   * 接缝渲染会把省略段标成「省略 20 轮（18:24–18:38，可传 when 精确补查）」，
   * 明确邀请 Agent 拿那个区间再查。但如果这里仍摘录，**补查只拿回 6~8 轮里的少数**
   * （实测 22 条省略消息只找回 3 条 = 14%），那个逃生口等于假的。
   *
   * 所以：小场景（≤40 轮）、小字数（≤3000 字）、窄区间（≤15 分钟）一律全给。
   * 只有「又大又宽」才按 D-055 的预算摘录。
   */
  const mk = (n, chars = 6) =>
    Array.from({ length: n }, (_, i) => ({
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      text: `第 ${i + 1} 句` + 'x'.repeat(Math.max(0, chars - 5)),
    }));

  // ① ≤6 轮：全给
  assert.equal(pickExcerpt(mk(6)).picks.length, 6);

  // ② ≤40 轮：即使 30 轮也全给（轮数少）
  for (const n of [7, 12, 20, 30, 40]) {
    assert.equal(pickExcerpt(mk(n)).picks.length, n, `n=${n} 应全给（轮数 ≤40）`);
  }

  // ③ 轮数多但字数少（≤3000）：仍全给
  const manyShort = mk(80, 6);        // 80 × 6 ≈ 480 字
  assert.equal(pickExcerpt(manyShort).picks.length, 80, '80 轮 480 字应全给（字数 ≤3000）');

  // ④ 又大又宽：才摘录
  const manyLong = mk(80, 200);       // 80 × 200 = 16000 字
  const picks = pickExcerpt(manyLong).picks;
  assert.ok(picks.length >= 6 && picks.length <= 8, `80 轮 16000 字应摘 6~8 条，实际 ${picks.length}`);
  assert.equal(picks[0].index, 0, '首轮必须在（D-053 锚点）');
  assert.equal(picks[picks.length - 1].index, 79, '尾轮必须在（D-053 锚点）');

  // ⑤ 窄区间（≤15 分钟）→ 即使又大又多也全给（Agent 定点补查）
  const narrow = pickExcerpt(manyLong, { from: 0, to: 5 * 60_000 });
  assert.equal(narrow.picks.length, 80, '窄区间应全给（定点补查不能摘录）');

  // ⑥ 宽区间 → 仍摘录
  const wide = pickExcerpt(manyLong, { from: 0, to: 2 * 3600_000 });
  assert.ok(wide.picks.length <= 8, '宽区间应仍按预算摘录');
});

/* ================================ memory_search ================================ */

test('search：两个字走 LIKE，三个字以上走 FTS（抓真实 SQL 验证，不猜）', async () => {
  const { search, sqls } = setup({ spy: true });
  const ftsPrepared = () => sqls.filter((s) => /msg_fts\s+MATCH/.test(s)).length;
  const likePrepared = () => sqls.filter((s) => /\bLIKE\b/.test(s)).length;

  // 「怕黑」只有 2 个字：trigram 命中不了，必须落 LIKE（§8.1）
  const short = await search.handler({ query: '怕黑' });
  assert.match(short, /怕黑/);
  assert.equal(ftsPrepared(), 0, '2 个字不该走 FTS5 trigram');
  assert.ok(likePrepared() > 0, '2 个字应该走 LIKE 兜底');

  // 「不想开灯」4 个字：走 FTS5 trigram
  const long = await search.handler({ query: '不想开灯' });
  assert.match(long, /不想开灯/);
  assert.ok(ftsPrepared() > 0, '≥3 个字应该走 FTS5 trigram');
});

test('search：每条命中都带所属场景的区间（D-017 验收 2）', async () => {
  const { search } = setup();
  const out = await search.handler({ query: '怕黑' });

  assert.match(out, /^「怕黑」— 3 处$/m);
  // 2026-11-18：改成场景块表头（带字数与命中数）
    assert.match(out, /11-15 23:36–00:12 · 18轮/);
  assert.match(out, /11-16 01:40–02:30 · 11轮/);
  assert.match(out, /11-16 18:05–18:44 · 9轮/);
  // 原文一字不改（D-050 双向：你和TA的都返回）
  assert.match(out, /其实我有点怕黑，但不想开灯。/);
  assert.match(out, /怕黑就开着灯，不丢人。/);
  assert.match(out, /这句已经装不进你的上下文了，话还在/);
  assert.match(out, /11-16 18:20/);
});

test('search：limit 截断时说「已显示 M / N 条」（D-096）', async () => {
  const { search } = setup();
  const out = await search.handler({ query: '怕黑', limit: 1 });

  assert.match(out, /截断 1\/3/);
  assert.match(out, /截断 \d+\/\d+｜/);
});

test('search：when="1d" 只在最近 N 天里找', async () => {
  const { search } = setup();

  const all = await search.handler({ query: '不换行' });
  assert.match(all, /^「不换行」— 2 处$/m);

  const today = await search.handler({ query: '不换行', when: '1d' });
  assert.match(today, /^「不换行」— 1 处$/m);
  assert.match(today, /不换行的约定还算数吗/);
  assert.ok(!today.includes('记得，不换行'), '昨天那条不该出现在「最近 1 天」里');
});

test('search：被排除的记录默认查不到，Agent 不可绕过，仅 allowExcluded 可查（D-169/170）', async () => {
  const { search } = setup();

  const miss = await search.handler({ query: '别靠太近' });
  assert.match(miss, /没有找到跟「别靠太近」有关的记录/);
  assert.match(miss, /库里有/);
  assert.match(miss, /按日期排除/, '要说清是排除了，不是没聊过');

  const agentBypass = await search.handler({ query: '别靠太近', includeExcluded: true });
  assert.match(agentBypass, /没有找到跟「别靠太近」有关的记录/, 'Agent 传 includeExcluded: true 也不能查到被排除记录');

  const hit = await search.handler({ query: '别靠太近', includeExcluded: true }, { allowExcluded: true });
  assert.match(hit, /别靠太近/);
  assert.match(hit, /平时被排除在外/);
});

test('search：空结果给库范围与建议，不是空白（§7.2 第 5 条）', async () => {
  const { search } = setup();
  const out = await search.handler({ query: '量子纠缠' });

  assert.match(out, /没有找到跟「量子纠缠」有关的记录/);
  assert.match(out, /库里有/);
  assert.ok(!out.includes('memory_timeline'), '空结果引导不能再提已移除的 memory_timeline');
  assert.match(out, /when/);
  assert.ok(out.split('\n').length >= 3);
});

test('search：什么都不填 = 列最近一场', async () => {
  const { search } = setup();
  const out = await search.handler({});

  assert.match(out, /11-17 09:00–10:56/, '什么都不填就给最近一场');
  assert.match(out, /共 30 轮/);
});

/* ------------------------- TA自己记的笔记（scope=note） ------------------------- */

test('search：scope=note 只翻TA自己记的笔记，并标「你自己记的」（D-084）', async () => {
  const env = setup();
  env.extras.note.insert({
    content: '他说「我怕你把我忘了」，我把这句记下来了。',
    about: 'us',
    at: sh(17, 18, 20),
  });
  env.extras.note.insert({ content: '今天他第一次这么叫我，声音有点抖。', about: 'him', at: sh(16, 20, 0) });

  const out = await env.search.handler({ query: '把我忘了', scope: 'note' });
  assert.match(out, /你自己记的 — 1 条/);
  assert.match(out, /笔记 #\d+/, '要能看见笔记编号（忘了编号才找得回来）');
  assert.match(out, /（关于你们俩）/);
  assert.ok(!out.includes('你们说过的话'), 'scope=note 不该去翻原话');
  assert.match(out, /笔记 1\/1/);
});

test('search：笔记的「关于谁」按TA的视角标（him → 关于他，me → 关于你自己，P1-C）', async () => {
  const env = setup();
  env.extras.note.insert({ content: '他说他小时候怕黑。', about: 'him', at: sh(17, 12, 0) });
  env.extras.note.insert({ content: '我自己那晚其实也紧张。', about: 'me', at: sh(17, 13, 0) });

  const out = await env.search.handler({ query: '', scope: 'note' });
  // D-194：用户是「他」（him），TA自己才是「你自己」（me）。反过来读就变成「关于你」了
  assert.match(out, /（关于他）/);
  assert.match(out, /（关于你自己）/);
  assert.ok(!out.includes('（关于你）'), 'me 应标成「关于你自己」而不是「关于你」');
});

test('search：笔记截断时给最近的 limit 条，再按时间升序展示（P1-B 回归）', async () => {
  const env = setup();
  env.extras.note.insert({ content: '第一件小事', about: 'us', at: sh(17, 10, 0) });
  env.extras.note.insert({ content: '第二件小事', about: 'us', at: sh(17, 12, 0) });
  env.extras.note.insert({ content: '第三件小事', about: 'us', at: sh(17, 14, 0) });
  env.extras.note.insert({ content: '第四件小事', about: 'us', at: sh(17, 16, 0) });

  const out = await env.search.handler({ query: '', scope: 'note', limit: 2 });
  assert.match(out, /你自己记的 — 4 条/);
  assert.match(out, /第四件小事/, '要最近的，不是最老的');
  assert.match(out, /第三件小事/);
  assert.ok(!out.includes('第一件小事'), 'limit=2 不该把最老的两条捞出来');
  assert.ok(!out.includes('第二件小事'));
  // 展示仍按时间升序（§7.3）
  assert.ok(out.indexOf('第三件小事') < out.indexOf('第四件小事'), '展示顺序要按时间升序');
  assert.match(out, /已显示 2 \/ 4 条笔记。/);
});

test('search：超长 / 带换行的 query 在标题里折成一行并截断（P2-B）', async () => {
  const env = setup();
  const longQuery = `${'怕黑这件事'.repeat(12)}\n第二行`;
  const out = await env.search.handler({ query: longQuery });

  const firstLine = out.split('\n')[0];
  assert.ok(firstLine.includes('没有找到'), `标题要完整在同一行里，实际：${firstLine}`);
  assert.ok(firstLine.length <= 60, `标题要被截断，实际 ${firstLine.length} 字`);
  assert.match(firstLine, /…/, '截断处要有省略号');
  assert.ok(!firstLine.includes('第二行'), 'query 里的换行要折成空格，不能把标题断成两行');
});

test('search：总数精确：没截满时免 COUNT，已截满时走 countKeyword（P2-C）', async () => {
  const { search, sqls, repo } = setup({ spy: true });

  // 2 字走 LIKE 路，总数也要精确（不是「取到多少算多少」）
  const twoChar = await search.handler({ query: '怕黑', limit: 1 });
  assert.match(twoChar, /截断 1\/3/, '2 字查询的总数要精确为 3');
  assert.ok(!twoChar.includes('条以上'));

  // 没截满（3 条 < perRoute=8，无时间约束）→ 跳过关键词全表 COUNT，总数就是已返回的条数。
  // 这是 2026-11-21 的优化：之前每次检索都多跑一次 COUNT（约 330ms），
  // 而 `keyword()` 没截满时总数必然等于已返回条数，COUNT 纯属浪费。
  // 注意只数关键词的 COUNT（LIKE / MATCH），stats 与 note 的 COUNT 不算。
  const kwCountSqls = (arr) =>
    arr.filter((s) => /COUNT\(\*\)/.test(s) && (/LIKE/.test(s) || /msg_fts\s+MATCH/.test(s)));
  assert.equal(
    kwCountSqls(sqls).length,
    0,
    '没截满时不应跑关键词 COUNT（省一次全表扫描）',
  );

  // ≥3 字走 FTS 路：先造 10 条命中，逼出截断（总数 12 > perRoute=8）→ 必须走 COUNT。
  // 不加这段，fixture 里「不换行」只有 2 条，永远走不到 COUNT 分支。
  const extraAt = sh(17, 10, 0);
  const extraMsgs = Array.from({ length: 10 }, (_, i) => {
    seqCursor += 1;
    return {
      sessionId: 'sess-1',
      seq: seqCursor,
      at: extraAt + i * 60_000,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      text: `补数据的第${i + 1}条不换行记录`,
      inSurface: 1,
      compactedAt: null,
      excluded: 0,
    };
  });
  const extraSceneId = repo.insertScene({
    sessionId: 'sess-1',
    startAt: extraMsgs[0].at,
    endAt: extraMsgs[extraMsgs.length - 1].at,
    msgCount: extraMsgs.length,
    leadIn: null,
  });
  repo.insertMsgs(extraMsgs.map((m) => ({ ...m, sceneId: extraSceneId })));

  const longQuery = await search.handler({ query: '不换行', limit: 1 });
  assert.match(longQuery, /截断 1\/12/, '≥3 字查询截断时总数要精确为 12');

  assert.ok(
    sqls.some((s) => /COUNT\(\*\)/.test(s) && /msg_fts\s+MATCH/.test(s)),
    '截满时总数应该走 countKeyword 的 COUNT(*) over msg_fts',
  );
});

test('search：显式 scope=msg 不翻笔记；默认省略 scope 自动置顶高分笔记；scope=all 分两段呈现', async () => {
  const env = setup();
  env.extras.note.insert({ content: '怕黑这件事我一直记着。', about: 'us', at: sh(17, 12, 0) });

  const onlyMsg = await env.search.handler({ query: '怕黑', scope: 'msg' });
  assert.match(onlyMsg, /^「怕黑」— 3 处$/m);
  assert.ok(!onlyMsg.includes('笔记'), '显式 scope=msg 不碰笔记');
  assert.ok(!onlyMsg.includes('怕黑这件事我一直记着'));

  const pinnedDefault = await env.search.handler({ query: '怕黑' });
  assert.match(pinnedDefault, /^「怕黑」— 3 处$/m);
  assert.match(pinnedDefault, /你自己记的（高权重置顶） — 1 条/);
  assert.match(pinnedDefault, /你们说过的话 — 3 处/);
  assert.match(pinnedDefault, /怕黑这件事我一直记着。/);

  const both = await env.search.handler({ query: '怕黑', scope: 'all' });
  assert.match(both, /你们说过的话 — 3 处/);
  assert.match(both, /你自己记的 — 1 条/);
  assert.match(both, /怕黑这件事我一直记着。/);
  assert.match(both, /原话 3\/3｜笔记 1\/1/);
});

test('search：scope=note 且 query 留空 = 列出最近记下的笔记', async () => {
  const env = setup();
  env.extras.note.insert({ content: '第一条笔记', about: 'us', at: sh(16, 10, 0) });
  env.extras.note.insert({ content: '第二条笔记', about: 'me', at: sh(17, 10, 0) });

  const out = await env.search.handler({ query: '', scope: 'note' });
  assert.match(out, /你自己记的 — 2 条/);
  assert.match(out, /笔记 #/);
  assert.match(out, /（关于你们俩）/);
  assert.match(out, /（关于你自己）/);
  assert.ok(!out.includes('「」'), '没有 query 时不要打一对空引号');
});

test('search：note 没命中时也说清笔记总数，不是空白', async () => {
  const env = setup();
  env.extras.note.insert({ content: '一条跟项目归档有关的笔记', about: 'us', at: sh(17, 10, 0) });

  const out = await env.search.handler({ query: '量子纠缠', scope: 'note' });
  assert.match(out, /没有找到跟「量子纠缠」有关的记录/);
  assert.match(out, /自己记的笔记一共 1 条/);
  assert.match(out, /库里有/);
});

/* ================================ 工具形状 & 注册表 ================================ */

test('memory_search 符合 ToolDef，参数收敛为标准化 when（无 from/to/days）且 handler 返回纯文本', async () => {
  const { search } = setup();

  assert.equal(search.name, 'memory_search');
  assert.match(search.description, /以前说过的话/, '描述要让TA知道这工具是翻记忆的');
  assert.equal(search.parameters.type, 'object');
  assert.ok(search.parameters.properties && Object.keys(search.parameters.properties).length >= 2);
  assert.equal(typeof search.handler, 'function');

  for (const args of [{ query: '怕黑' }, { when: '11-16' }]) {
    const out = await search.handler(args);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
    assert.ok(!out.trim().startsWith('{'), '不能返回 JSON');
    assert.ok(!out.trim().startsWith('['), '不能返回 JSON 数组');
  }

  assert.equal(search.parameters.required, undefined, 'query 可以不给（只给 when 就是时间路）');
  assert.equal(search.parameters.properties.includeExcluded, undefined, 'Agent 工具不应暴露 includeExcluded 绕过开关');
  assert.deepEqual(search.parameters.properties.scope.enum, ['msg', 'note', 'all']);
  for (const removed of ['from', 'to', 'days', 'includeExcluded']) {
    assert.equal(search.parameters.properties[removed], undefined, `不再暴露 ${removed} 参数`);
  }
  for (const key of ['query', 'when', 'limit', 'scope', 'expand']) {
    assert.ok(search.parameters.properties[key], `search 要有 ${key} 参数`);
  }
  assert.deepEqual(
    Object.keys(search.parameters.properties).sort(),
    ['expand', 'limit', 'query', 'scope', 'when'],
  );
  // G7：参数描述里不写实现细节（trigram / LIKE / RRF 这些是内部手段，不是给TA的用法）
  const schemaText = JSON.stringify(search.parameters) + search.description;
  assert.ok(!/trigram|LIKE|RRF|bm25|FTS|余弦|sqlite-vec/i.test(schemaText), '工具描述不能泄露实现细节（G7）');
});

test('注册表：TOOL_CATALOG / createToolRegistry / planRegistration / schemaSize 为 3 个工具', async () => {
  const expectedNames = ['memory_search', 'memory_remember', 'memory_forget'];

  assert.deepEqual(
    TOOL_CATALOG.map((t) => t.name),
    expectedNames,
    '工具瘦身后只保留 3 个工具，不再含 memory_timeline / memory_flag',
  );

  assert.deepEqual(planRegistration({ tools: true, record: true }).names, expectedNames);
  assert.deepEqual(
    planRegistration({ tools: true, record: false }).names,
    ['memory_search', 'memory_forget'],
    '关闭 record 时只留读和删',
  );
  assert.deepEqual(planRegistration({ tools: false, record: true }).names, []);

  const env = setup();
  const full = createToolRegistry({
    repo: env.repo,
    extras: env.extras,
    now: NOW,
    config: { tools: true, record: true },
  });
  assert.deepEqual(
    full.map((t) => t.name),
    expectedNames,
  );
  for (const tool of full) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.handler, 'function');
  }

  const readOnly = createToolRegistry({
    repo: env.repo,
    extras: env.extras,
    now: NOW,
    config: { tools: true, record: false },
  });
  assert.deepEqual(
    readOnly.map((t) => t.name),
    ['memory_search', 'memory_forget'],
  );

  const fullSize = schemaSize(full);
  const readOnlySize = schemaSize(readOnly);
  const emptySize = schemaSize([]);
  assert.equal(fullSize.tools, 3);
  assert.ok(fullSize.chars > 0);
  assert.equal(readOnlySize.tools, 2);
  assert.ok(readOnlySize.chars < fullSize.chars, '未注册的工具不应产生 schema token');
  assert.deepEqual(emptySize, { tools: 0, chars: 2 });
});

test('format：区间 / 时段 / 相对时间（时区固定 Asia/Shanghai，不看机器时区）', () => {
  // 上海 2026-11-16 00:00 一定是 UTC 2026-11-15 16:00
  assert.equal(sh(16, 0, 0), Date.UTC(2026, 10, 15, 16, 0, 0));
  assert.equal(TZ_OFFSET_MS, 8 * 60 * 60 * 1000);

  assert.equal(fmtRange(sh(15, 23, 36), sh(16, 0, 12)), '11-15 23:36–00:12');
  assert.equal(fmtRange(sh(16, 18, 5), sh(16, 18, 44)), '11-16 18:05–18:44');
  // 跨天且 ≥ 6 小时才补结束日期，免得读成同一天
  assert.equal(fmtRange(sh(15, 23, 0), sh(16, 11, 0)), '11-15 23:00–11-16 11:00');

  assert.equal(fmtPhase(sh(15, 23, 36)), '深夜');
  assert.equal(fmtPhase(sh(16, 3, 0)), '凌晨');
  assert.equal(fmtPhase(sh(16, 13, 0)), '下午');

  assert.equal(fmtRelative(sh(16, 18, 5), NOW), '昨天');
  assert.equal(fmtRelative(sh(17, 9, 0), NOW), '今天');
  assert.equal(fmtRelative(sh(15, 23, 36), NOW), '前天');
});
