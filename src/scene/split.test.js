// split.test.js —— 场景切分与邻接的单元测试
//
// 覆盖：
//   - 三条硬切规则：30 分钟断点 / 40 条上限 / 跨压缩点
//   - 两条防断裂规则：2 分钟内连续回应 / 沉默后短句归前一场
//   - 规则的**优先级**（防断裂否决硬切）与统计口径
//   - 邻接回填：preceded_by / followed_by / gap_* / lead_in
//   - 纯函数性质：不改入参、可重复调用、乱序输入结果一致
//
// 跑法：node --test "src/scene/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GAP_CUT_MS,
  GAP_JOIN_MS,
  MAX_SCENE_MSGS,
  SHORT_REPLY_CHARS,
  TOPIC_INTRO_WORDS,
  introducesTopic,
  sortMessages,
  splitScenes,
  splitScenesWithStats,
  describe,
  sceneStats,
} from './split.js';

import {
  LEAD_IN_COUNT,
  leadInDigest,
  linkScenes,
  assignPlan,
  buildScenes,
} from './link.js';

/* ============================ 造数据 ============================ */

/** 2026-11-12 22:00:00 +08:00 */
const T0 = Date.parse('2026-11-12T22:00:00+08:00');
const MIN = 60_000;

/** 默认正文：14 个字，> SHORT_REPLY_CHARS，保证不会误触「沉默后短句归前一场」 */
const LONG_TEXT = '这是第若干条消息，内容够长';

/**
 * 造一条消息（字段名与 T2 导出一致，snake_case）
 * @param {number} seq
 * @param {number} offsetMin 相对 T0 的分钟数
 * @param {object} [extra] 覆盖字段
 */
function m(seq, offsetMin, extra = {}) {
  return {
    seq,
    at: T0 + offsetMin * MIN,
    speaker: seq % 2 === 1 ? 'user' : 'assistant',
    text: LONG_TEXT,
    in_surface: 1,
    compacted_at: null,
    excluded: 0,
    ...extra,
  };
}

/** 按「距上一条的间隔分钟数」造一串消息；第一条的间隔忽略 */
function chain(offsetsMin, extraOf) {
  const out = [];
  let t = 0;
  for (let i = 0; i < offsetsMin.length; i++) {
    t += i === 0 ? 0 : offsetsMin[i];
    out.push(m(i + 1, t, extraOf?.(i) ?? {}));
  }
  return out;
}

/* ============================ 1. 硬切：30 分钟断点 ============================ */

test('30 分钟断点：间隔 > 30min 切开，<= 30min 不切（严格大于）', () => {
  // 0 → 3 → 6 分钟（都在 30 分钟内），然后 +31 分钟
  const msgs = chain([0, 3, 3, 31]);
  const { scenes, stats } = splitScenesWithStats(msgs);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].msg_count, 3);
  assert.equal(scenes[1].msg_count, 1);
  assert.equal(stats.cutByGap, 1);

  // 边界：正好 30 分钟**不**切（规则是 > 30 分钟）
  const exact = chain([0, 30]);
  assert.equal(splitScenes(exact).length, 1, '间隔正好 30 分钟不该切');
  // 30 分钟 + 1 毫秒就切
  const over = [m(1, 0), m(2, 0)];
  over[1].at = over[0].at + GAP_CUT_MS + 1;
  assert.equal(splitScenes(over).length, 2);
});

/* ============================ 2. 硬切：40 条上限 ============================ */

test('软上限强切：间隔 3 分钟（不触发 2 分钟合并）时，超过 MAX_SCENE_MSGS 起新场', () => {
  const total = MAX_SCENE_MSGS + 5;
  const msgs = chain(Array.from({ length: total }, (_, i) => (i === 0 ? 0 : 3)));
  const { scenes, stats } = splitScenesWithStats(msgs);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].msg_count, MAX_SCENE_MSGS, `第一场应正好 ${MAX_SCENE_MSGS} 条`);
  assert.equal(scenes[1].msg_count, 5);
  assert.equal(stats.cutBySize, 1);
  assert.equal(scenes[0].msgs[0].seq, 1);
  assert.equal(scenes[0].msgs.at(-1).seq, MAX_SCENE_MSGS);
  assert.equal(scenes[1].msgs[0].seq, MAX_SCENE_MSGS + 1);
});

test('软上限会被「2 分钟连续回应」否决（照 §6.2 伪代码的优先级）', () => {
  // 每 1 分钟一句：quickReply 成立 → 防断裂压过 size 硬切
  const total = MAX_SCENE_MSGS + 5;
  const msgs = chain(Array.from({ length: total }, (_, i) => (i === 0 ? 0 : 1)));

  const loose = splitScenesWithStats(msgs);
  assert.equal(loose.scenes.length, 1, '默认口径：连聊不断，软上限被否决');
  assert.equal(loose.scenes[0].msg_count, total);
  assert.equal(loose.stats.cutBySize, 0);
  // 超出 MAX_SCENE_MSGS 的 5 条各被并入一次 → 5 次否决
  assert.equal(loose.stats.overridden.size, 5);

  // 关掉「防断裂可否决上限」，MAX_SCENE_MSGS 就是硬上限
  const strict = splitScenesWithStats(msgs, { forceJoinOverridesMax: false });
  assert.equal(strict.scenes.length, 2);
  assert.equal(strict.scenes[0].msg_count, MAX_SCENE_MSGS);
  assert.equal(strict.stats.cutBySize, 1);
  assert.equal(strict.stats.forcedJoinQuickReply, 0);
});

/* ============================ 3. 硬切：跨压缩点 ============================ */

test('跨压缩点：compacted_at 由空变非空就切（间隔够大时）', () => {
  const msgs = chain([0, 3, 3, 3], (i) => (i >= 2 ? { compacted_at: T0 + 10 * MIN, in_surface: 0 } : {}));
  const { scenes, stats } = splitScenesWithStats(msgs);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].msg_count, 2);
  assert.equal(scenes[1].msg_count, 2);
  assert.equal(stats.cutByCompaction, 1);
  assert.equal(stats.compactionFlips, 1);
  // 正常切开时不该有场景横跨压缩点
  assert.equal(scenes[0].crossesCompaction, false);
  assert.equal(scenes[1].crossesCompaction, false);
  // 派生标记
  assert.equal(scenes[0].hasOutOfSurface, false);
  assert.equal(scenes[1].hasOutOfSurface, true);
  assert.equal(scenes[1].outOfSurfaceCount, 2);
});

test('跨压缩点会被「2 分钟连续回应」否决 → 场景横跨压缩点，如实标 crossesCompaction', () => {
  // 间隔 1 分钟，第二条已被压缩
  const msgs = [m(1, 0), m(2, 1, { compacted_at: T0 + 10 * MIN, in_surface: 0 })];
  const { scenes, stats } = splitScenesWithStats(msgs);

  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].crossesCompaction, true, '横跨压缩点要标出来，不是悄悄发生');
  assert.equal(stats.cutByCompaction, 0);
  assert.equal(stats.forcedJoinQuickReply, 1);
  assert.equal(stats.overridden.compaction, 1);
  assert.equal(stats.compactionFlips, 1);
});

/* ============================ 4. 防断裂：2 分钟合并 ============================ */

test('2 分钟合并：间隔 <= 2min 的连续回应强制同场（正好 2 分钟也算）', () => {
  // 0 → 2 → 2 → 2 分钟，全程 <= 2min
  const msgs = chain([0, 2, 2, 2]);
  assert.equal(splitScenes(msgs).length, 1);

  // 超过 2 分钟但没有其他硬切原因 → 也不切（没理由切）
  const slower = chain([0, 2.5, 2.5]);
  assert.equal(splitScenes(slower).length, 1);

  // 2 分钟合并能救回一次压缩点切分（两个硬切条件里只有压缩点可能撞上 2 分钟）
  const withCompact = [m(1, 0), m(2, GAP_JOIN_MS / MIN, { compacted_at: T0 + 5 * MIN })];
  const r = splitScenesWithStats(withCompact);
  assert.equal(r.scenes.length, 1);
  assert.equal(r.stats.forcedJoinQuickReply, 1);

  // 边界：2 分钟 + 1 毫秒就不算「直接回应」，压缩点照切
  const over2 = [m(1, 0), { ...m(2, 0), at: T0 + GAP_JOIN_MS + 1, compacted_at: T0 + 5 * MIN }];
  assert.equal(splitScenes(over2).length, 2);
});

/* ============================ 5. 防断裂：沉默后短句归前一场 ============================ */

test('沉默 > 30 分钟后首条 < 10 字且无话题引入词 → 归前一场', () => {
  const msgs = [m(1, 0), m(2, 45, { text: '嗯' })];
  const { scenes, stats } = splitScenesWithStats(msgs);

  assert.equal(scenes.length, 1, '「嗯」应该并回前一场');
  assert.equal(stats.forcedJoinShortAfterSilence, 1);
  assert.equal(stats.cutByGap, 0);
  assert.equal(stats.overridden.gap, 1);
});

test('沉默后短句只要带话题引入信号，就照切', () => {
  const cases = [
    ['那个事你记得吗', 'word'], // 话题引入词
    ['为什么呢？', 'question'], // 问号收尾
    ['《夜行》', 'proper'], // 含专名标记
  ];
  for (const [text, via] of cases) {
    const { scenes, stats } = splitScenesWithStats([m(1, 0), m(2, 45, { text })]);
    assert.equal(scenes.length, 2, `「${text}」应切开（via=${via}）`);
    assert.equal(stats.cutByGap, 1);
    assert.equal(stats.forcedJoinShortAfterSilence, 0);
    assert.equal(stats.topicIntroBlocked[via], 1, `「${text}」应由 ${via} 拦下`);
  }
});

test('沉默后「长」消息（>= 10 字）一律照切', () => {
  const text = '一二三四五六七八九十'; // 正好 10 字
  assert.equal(text.length, SHORT_REPLY_CHARS);
  const { scenes, stats } = splitScenesWithStats([m(1, 0), m(2, 45, { text })]);
  assert.equal(scenes.length, 2);
  assert.equal(stats.forcedJoinShortAfterSilence, 0);
});

test('沉默后极短消息：只有首条（gap 判定看前一条）才享受并入', () => {
  // 45 分钟后「嗯」（并入），紧接着 1 分钟后又一句（quickReply 继续并入）
  const msgs = [m(1, 0), m(2, 45, { text: '嗯' }), m(3, 46)];
  const { scenes } = splitScenesWithStats(msgs);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].msg_count, 3);
});

/* ============================ 6. 话题引入词 ============================ */

test('introducesTopic：4 个话题引入词 / 问号收尾 / 专名标记', () => {
  for (const w of TOPIC_INTRO_WORDS) {
    const r = introducesTopic(`嗯${w}`);
    assert.equal(r.intro, true, `「${w}」应算话题引入`);
    assert.equal(r.via, 'word');
  }
  assert.deepEqual(introducesTopic('你在想什么？'), { intro: true, via: 'question' });
  assert.deepEqual(introducesTopic('好吧?'), { intro: true, via: 'question' });
  assert.equal(introducesTopic('《红楼梦》').via, 'proper');
  assert.equal(introducesTopic('LeetCode').via, 'proper');
  assert.equal(introducesTopic('OK').via, 'proper');
  // 小写拉丁词不是专名（中文闲聊里 ok / hhh / emmm 极常见，认成专名会让防断裂失效）
  assert.equal(introducesTopic('ok').intro, false);
  assert.equal(introducesTopic('hhh').intro, false);
  assert.equal(introducesTopic('嗯').intro, false);
  assert.equal(introducesTopic('').intro, false);
  assert.equal(introducesTopic(undefined).intro, false);
  // 指代词不算话题引入（D-102：指代是延续信号，不是引入信号）
  assert.equal(introducesTopic('还记得上次那个吗').via, 'word'); // 命中「那个」，但不是因为「上次」
  assert.equal(introducesTopic('上次说的').intro, false);
});

/* ============================ 7. 输入保护与纯函数性质 ============================ */

test('空数组 → 0 场；单条 → 1 场', () => {
  const empty = splitScenesWithStats([]);
  assert.deepEqual(empty.scenes, []);
  assert.equal(empty.stats.outputScenes, 0);

  const one = splitScenes([m(1, 0)]);
  assert.equal(one.length, 1);
  assert.equal(one[0].msg_count, 1);
  assert.equal(one[0].start_at, one[0].end_at);
});

test('不改入参：切分前后消息对象逐字段不变', () => {
  const msgs = chain([0, 1, 40, 3]);
  const before = JSON.parse(JSON.stringify(msgs));
  splitScenes(msgs);
  linkScenes(splitScenes(msgs));
  assert.deepEqual(msgs, before);
});

test('乱序输入先按时间排，结果与有序输入一致', () => {
  const msgs = chain([0, 3, 40, 3, 1]);
  const sorted = sortMessages(msgs);
  const shuffled = [msgs[4], msgs[0], msgs[3], msgs[2], msgs[1]];
  assert.deepEqual(sortMessages(shuffled), sorted);

  const a = splitScenes(msgs).map((s) => s.msgs.map((x) => x.seq));
  const b = splitScenes(shuffled).map((s) => s.msgs.map((x) => x.seq));
  assert.deepEqual(a, b);
});

test('同一时刻的消息按 seq 升序，保证结果可复现', () => {
  const msgs = [m(3, 5), m(1, 5), m(2, 5)];
  const sorted = sortMessages(msgs);
  assert.deepEqual(sorted.map((x) => x.seq), [1, 2, 3]);
});

test('入参不是数组 / 缺 at → 抛 TypeError（不猜、不静默丢）', () => {
  assert.throws(() => splitScenes(null), TypeError);
  assert.throws(() => splitScenes('x'), TypeError);
  assert.throws(() => splitScenes([{ seq: 1, text: 'x' }]), TypeError);
});

/* ============================ 8. 字段名兼容与派生标记 ============================ */

test('兼容 camelCase（T1 的 MsgRow）：compactedAt / inSurface', () => {
  const msgs = [
    { seq: 1, at: T0, speaker: 'user', text: LONG_TEXT, inSurface: 1, compactedAt: null, excluded: 0 },
    { seq: 2, at: T0 + 3 * MIN, speaker: 'assistant', text: LONG_TEXT, inSurface: 0, compactedAt: T0 + MIN, excluded: 0 },
  ];
  const { scenes, stats } = splitScenesWithStats(msgs);
  assert.equal(scenes.length, 2);
  assert.equal(stats.cutByCompaction, 1);
  assert.equal(scenes[1].hasOutOfSurface, true);

  // 少传 in_surface 时按 compacted_at 兜底（T2 里两者等价）
  const onlyCompacted = [
    { seq: 1, at: T0, speaker: 'user', text: LONG_TEXT, compacted_at: null },
    { seq: 2, at: T0 + 3 * MIN, speaker: 'assistant', text: LONG_TEXT, compacted_at: T0 + MIN },
  ];
  assert.equal(splitScenes(onlyCompacted)[1].hasOutOfSurface, true);
});

test('excluded 参与切分，但派生 hasExcluded / excludedCount', () => {
  const msgs = chain([0, 3, 3, 40], (i) => (i === 1 ? { excluded: 1 } : {}));
  const { scenes } = splitScenesWithStats(msgs);

  assert.equal(scenes.length, 2);
  // 被排除的消息仍然在场景里（真实存在过，只是检索时不过滤出来）
  assert.equal(scenes[0].msg_count, 3);
  assert.equal(scenes[0].hasExcluded, true);
  assert.equal(scenes[0].excludedCount, 1);
  assert.equal(scenes[1].hasExcluded, false);
  assert.equal(scenes[1].excludedCount, 0);
});

test('会话 id 变化必定切（一个场景绝不混两个会话）', () => {
  const msgs = [
    m(1, 0, { session_id: 'a' }),
    m(2, 3, { session_id: 'a' }),
    m(3, 4, { session_id: 'b' }), // 间隔只有 1 分钟，但会话变了
  ];
  const { scenes, stats } = splitScenesWithStats(msgs);
  assert.equal(scenes.length, 2);
  assert.equal(stats.cutBySession, 1);
  assert.equal(scenes[0].msg_count, 2);
});

test('场景的 seqFrom / seqTo 是本场实际最小 / 最大 seq', () => {
  const msgs = chain([0, 3, 40]);
  const scenes = splitScenes(msgs);
  assert.equal(scenes[0].seqFrom, 1);
  assert.equal(scenes[0].seqTo, 2);
  assert.equal(scenes[1].seqFrom, 3);
  assert.equal(scenes[1].seqTo, 3);
});

/* ============================ 9. 邻接回填 ============================ */

/** 造 3 场：0/3 分钟一场，+40 分钟一场，+40 分钟一场 */
function threeScenes() {
  const msgs = chain([0, 3, 40, 40]);
  return splitScenes(msgs);
}

test('linkScenes：preceded_by / followed_by / gap_* 全部对上', () => {
  const scenes = threeScenes();
  assert.equal(scenes.length, 3);

  const linked = linkScenes(scenes);

  assert.deepEqual(linked.map((s) => s.id), [1, 2, 3]);
  assert.deepEqual(linked.map((s) => s.preceded_by), [null, 1, 2]);
  assert.deepEqual(linked.map((s) => s.followed_by), [2, 3, null]);
  assert.deepEqual(linked.map((s) => s.gap_before_ms), [null, 40 * MIN, 40 * MIN]);
  assert.deepEqual(linked.map((s) => s.gap_after_ms), [40 * MIN, 40 * MIN, null]);

  // gap 与 start/end 自洽
  assert.equal(linked[1].gap_before_ms, linked[1].start_at - linked[0].end_at);
  assert.equal(linked[0].gap_after_ms, linked[1].start_at - linked[0].end_at);
});

test('lead_in：前一场末尾 2 条原文（JSON 字符串 + 数组两用），第一场为空', () => {
  const scenes = threeScenes();
  const linked = linkScenes(scenes);

  assert.equal(LEAD_IN_COUNT, 2);
  assert.equal(linked[0].lead_in, '[]');
  assert.deepEqual(linked[0].lead_in_msgs, []);

  const parsed = JSON.parse(linked[1].lead_in);
  assert.equal(parsed.length, 2, '前一场只有 2 条，全给');
  assert.deepEqual(parsed, scenes[0].msgs.slice(-2).map(leadInDigest));
  assert.deepEqual(linked[1].lead_in_msgs, parsed);

  // 只存原文，不带任何解读字段
  for (const item of parsed) {
    assert.deepEqual(Object.keys(item).sort(), ['at', 'seq', 'speaker', 'text']);
  }

  // 前一场只有 1 条时，lead_in 就是那 1 条（不补齐、不编造）
  const linked3 = linkScenes(threeScenes());
  assert.equal(JSON.parse(linked3[2].lead_in).length, 1);
});

test('lead_in 取的是「前一场」，不是「前一条消息」', () => {
  const scenes = splitScenes([m(1, 0), m(2, 3), m(3, 40), m(4, 41)]);
  const linked = linkScenes(scenes);
  // 第 2 场（消息 3、4）的 lead_in 来自第 1 场（消息 1、2）
  assert.deepEqual(JSON.parse(linked[1].lead_in).map((x) => x.seq), [1, 2]);
});

test('linkScenes 不改入参，且可重复调用', () => {
  const scenes = threeScenes();
  const snapshot = JSON.parse(JSON.stringify(scenes.map((s) => ({ ...s, msgs: s.msgs.map((x) => ({ ...x })) }))));

  const a = linkScenes(scenes);
  const b = linkScenes(scenes);
  assert.deepEqual(a, b, '同样的输入两次结果一致');

  // 原场景对象没有被打上 id / 邻接字段
  assert.equal(scenes[0].id, undefined);
  assert.equal(scenes[0].preceded_by, undefined);
  assert.deepEqual(
    scenes.map((s) => ({ ...s, msgs: s.msgs.map((x) => ({ ...x })) })),
    snapshot,
  );
});

test('linkScenes：opts.ids 用真实库 id，leadInCount 可调', () => {
  const scenes = splitScenes([m(1, 0), m(2, 1), m(3, 2), m(4, 40)]);
  const linked = linkScenes(scenes, { ids: [501, 502], leadInCount: 1 });

  assert.deepEqual(linked.map((s) => s.id), [501, 502]);
  assert.deepEqual(linked.map((s) => s.preceded_by), [null, 501]);
  assert.deepEqual(linked.map((s) => s.followed_by), [502, null]);
  assert.equal(JSON.parse(linked[1].lead_in).length, 1);
});

test('linkScenes 入参校验：非数组 / ids 长度不符 → TypeError', () => {
  assert.throws(() => linkScenes(null), TypeError);
  assert.throws(() => linkScenes([], { ids: [1] }), TypeError);
});

/* ============================ 10. 回填计划（T1 接口） ============================ */

test('assignPlan：每场给出 [fromSeq, toSeq] 与 msgCount，可直接喂 assignSeqRange', () => {
  const scenes = linkScenes(splitScenes([m(1, 0, { session_id: 's1' }), m(2, 3, { session_id: 's1' }), m(3, 40, { session_id: 's1' })]));
  const plan = assignPlan(scenes);

  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], {
    sceneIndex: 0,
    sceneId: 1,
    sessionId: 's1',
    fromSeq: 1,
    toSeq: 2,
    msgCount: 2,
  });
  assert.equal(plan[1].fromSeq, 3);
  assert.equal(plan[1].toSeq, 3);

  // 显式传 sessionId 时优先
  assert.equal(assignPlan(scenes, 'override')[0].sessionId, 'override');
});

test('buildScenes：切分 + 邻接一步到位', () => {
  const { scenes, stats } = buildScenes([m(1, 0), m(2, 3), m(3, 40)]);
  assert.equal(scenes.length, 2);
  assert.equal(stats.outputScenes, 2);
  assert.equal(scenes[0].followed_by, scenes[1].id);
  assert.equal(JSON.parse(scenes[1].lead_in).length, 2);
});

/* ============================ 11. 分布统计 ============================ */

test('describe：min / median / max，空数组全 null', () => {
  assert.deepEqual(describe([]), { count: 0, min: null, median: null, max: null, mean: null });
  assert.deepEqual(describe([3]), { count: 1, min: 3, median: 3, max: 3, mean: 3 });
  const d = describe([5, 1, 3]);
  assert.equal(d.min, 1);
  assert.equal(d.median, 3);
  assert.equal(d.max, 5);
  assert.equal(describe([1, 2, 3, 4]).median, 2.5, '偶数个取中间两个的均值');
  assert.equal(describe([1, NaN, 3]).count, 2, '非法值被过滤');
});

test('sceneStats：时长 / 条数分布 + 跨压缩点 / 含排除计数', () => {
  const msgs = [
    m(1, 0, { excluded: 1 }),
    m(2, 3),
    m(3, 40, { compacted_at: T0 + 20 * MIN, in_surface: 0 }), // 间隔 37 分钟 + 压缩点翻转 → 切
    m(4, 43), // 间隔 3 分钟 + 压缩点翻转回来 → 切
  ];
  const scenes = splitScenes(msgs);
  const st = sceneStats(scenes);

  assert.equal(st.scenes, 3);
  assert.equal(st.messages, 4);
  assert.equal(st.msgCount.min, 1);
  assert.equal(st.msgCount.max, 2);
  assert.equal(st.durationMs.min, 0, '单条场景时长为 0');
  assert.equal(st.crossesCompaction, 0);
  assert.equal(st.withExcluded, 1);
  assert.equal(st.withOutOfSurface, 1);
  assert.equal(st.overMaxMsgs, 0);
});

/* ============================ 10. V3：双软硬上限 + 2h 沉默封顶 + 语义精修 ============================ */

test('沉默封顶（2h）：3 小时后发「早安」不再粘回前一场；跨 24 点热聊不断', () => {
  // 睡前 23:50 → 次日 02:55（间隔 185 分钟 > 2h）：即使「早安」< 10 字也不并入
  const overnight = [m(1, 0, { text: '晚安' }), m(2, 185, { text: '早安' })];
  const r1 = splitScenesWithStats(overnight);
  assert.equal(r1.scenes.length, 2, '超过 2 小时沉默的短句必须切开');
  assert.equal(r1.stats.forcedJoinShortAfterSilence, 0);

  // 23:55 → 00:05（跨零点但间隔仅 10 分钟）：保持同一场
  const midnightT0 = Date.UTC(2026, 10, 18, 15, 55); // 上海 23:55
  const crossMidnight = [
    { seq: 1, at: midnightT0, speaker: 'user', text: '还没睡呢' },
    { seq: 2, at: midnightT0 + 10 * MIN, speaker: 'assistant', text: '刚过零点啦' },
  ];
  const r2 = splitScenesWithStats(crossMidnight);
  assert.equal(r2.scenes.length, 1, '跨 24 点连续热聊绝不硬切');
});

test('字数软/硬上限 + user 轮次对齐：任务长对话可控切分且不劈开问答对', () => {
  // 每条 600 字，交替 user/assistant，间隔 3 分钟
  const big = '甲'.repeat(600);
  const msgs = Array.from({ length: 16 }, (_, i) => ({
    id: i + 1,
    seq: i + 1,
    at: T0 + i * 3 * MIN,
    speaker: i % 2 === 0 ? 'user' : 'assistant',
    text: big,
  }));
  const { scenes, stats } = splitScenesWithStats(msgs);
  assert.ok(scenes.length >= 2, '16 条 × 600 字 = 9600 字应触发字数切分');
  assert.ok(stats.cutByChars + stats.cutByHardCap >= 1);
  // 除首场外，每个新场的第一条都应对齐到 user（不把问答对劈成两半）
  for (let i = 1; i < scenes.length; i++) {
    assert.equal(scenes[i].msgs[0].speaker, 'user', `第 ${i + 1} 场应从 user 新起一轮`);
  }
});

test('热聊二级硬上限（150 条）：160 条 1 分钟连续回复不会滚成单一巨场', () => {
  const msgs = chain(Array.from({ length: 160 }, (_, i) => (i === 0 ? 0 : 1)));
  const { scenes, stats } = splitScenesWithStats(msgs);
  assert.equal(scenes.length, 2);
  assert.ok(scenes[0].msg_count <= 151, '首场不超过硬上限 + 1 条问答对齐容忍');
  assert.equal(stats.cutByHardCap, 1);
});

test('阶段 B 语义精修（TextTiling）：无缝换话题的连续热聊按语义深谷精准切分', () => {
  // 44 条 1 分钟连续热聊：前 22 条聊主题 A（向量 [1,0,0,0]），后 22 条无缝切到主题 B（向量 [0,1,0,0]）
  const msgs = Array.from({ length: 44 }, (_, i) => ({
    id: i + 1,
    seq: i + 1,
    at: T0 + i * MIN,
    speaker: i % 2 === 0 ? 'user' : 'assistant',
    text: i < 22 ? `主题A讨论第${i}句` : `主题B讨论第${i}句`,
  }));
  const vectors = new Map();
  for (let i = 0; i < 44; i++) {
    vectors.set(i + 1, i < 22 ? new Float32Array([1, 0, 0, 0]) : new Float32Array([0, 1, 0, 0]));
  }

  // 不给向量（阶段 A）：44 条 1 分钟连聊保持 1 场
  const noVec = splitScenesWithStats(msgs);
  assert.equal(noVec.scenes.length, 1);

  // 给已有向量（阶段 B）：精准在 index=22（seq=23，user 新话题第一句）切开
  const withVec = splitScenesWithStats(msgs, { vectors });
  assert.equal(withVec.scenes.length, 2);
  assert.equal(withVec.stats.cutBySemantic, 1);
  assert.equal(withVec.scenes[0].msg_count, 22);
  assert.equal(withVec.scenes[1].msgs[0].seq, 23);
  assert.equal(withVec.scenes[1].msgs[0].speaker, 'user');
});
