/**
 * gist 生成的测试 —— 全部用 mock provider，不调真实 API
 *
 * 验收重点（BUILD-PLAN.md §6.1 T5）：
 *   断言输出含三个标签 ｜ 断言禁用词被剔除
 * 外加 D-029 的两条硬规矩：三段缺一不可、【原话】不许改写。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mockLlm } from '../model/mock.js';
import {
  generateGist,
  parseSections,
  stripBanned,
  cleanQuotes,
  checkQuotesVerbatim,
  countChars,
  GIST_LABELS,
  GIST_LIMITS,
} from './gist.js';
import { GIST_BANNED_WORDS } from './prompts.js';

// ─────────────────────────────────────────────
// 测试数据：一段真实的深夜对话
// ─────────────────────────────────────────────

const MSGS = [
  { seq: 301, speaker: 'user', text: '睡不着，其实我有点怕黑' },
  { seq: 302, speaker: 'assistant', text: '那我陪你，先把这一会儿陪过掉' },
  { seq: 303, speaker: 'user', text: '嗯，点蜡' },
  { seq: 304, speaker: 'assistant', text: '灯不开了，就点蜡' },
];

/** 合法 gist（字数落在 30~60） */
const GOOD_GIST = {
  gist: [
    '【发生了什么】他半夜说睡不着，承认怕黑，就点蜡不开灯',
    '【原话】「睡不着，其实我有点怕黑」「就点蜡」',
    '【不懂的】点蜡',
  ].join('\n'),
  unresolved: ['点蜡'],
};

/** 带禁用词的 gist（模型不听话时） */
const BANNED_GIST = {
  gist: [
    '【发生了什么】气氛很微妙，他半夜说睡不着，聊了很多各种事',
    '【原话】「睡不着，其实我有点怕黑」',
    '【不懂的】无',
  ].join('\n'),
};

describe('三段式解析', () => {
  test('正常三段能拆开', () => {
    const s = parseSections(GOOD_GIST.gist);
    assert.ok(s);
    assert.equal(s.what, '他半夜说睡不着，承认怕黑，就点蜡不开灯');
    assert.equal(s.quote, '「睡不着，其实我有点怕黑」「就点蜡」');
    assert.equal(s.unknown, '点蜡');
  });

  test('缺【不懂的】→ 返回 null，不补写（补写就是编）', () => {
    const broken = '【发生了什么】他半夜说睡不着\n【原话】「睡不着」';
    assert.equal(parseSections(broken), null);
  });

  test('三段顺序颠倒 → 返回 null', () => {
    const broken = '【原话】「睡不着」\n【发生了什么】他半夜说睡不着\n【不懂的】无';
    assert.equal(parseSections(broken), null);
  });

  test('标签之外的前后冗余文本不影响拆分', () => {
    const noisy = `好的，这是索引：\n${GOOD_GIST.gist}\n以上。`;
    const s = parseSections(noisy);
    assert.ok(s);
    assert.equal(s.unknown, '点蜡\n以上。');
  });
});

describe('禁用词剔除（D-040）', () => {
  test('「气氛」「微妙」「很多」「各种」全部剔除', () => {
    const { text, removed } = stripBanned('气氛很微妙，他半夜说睡不着，聊了很多各种事');
    for (const w of ['气氛', '微妙', '很多', '各种']) {
      assert.ok(!text.includes(w), `剔除后不应该再出现「${w}」，实际：${text}`);
    }
    assert.ok(removed.length > 0);
  });

  test('剔除的是整句，不是把词挖掉留个洞', () => {
    const { text } = stripBanned('气氛很微妙，他半夜说睡不着');
    assert.equal(text, '他半夜说睡不着', '带禁用词的整句应该被丢掉');
    assert.ok(!text.includes('很'), '不应该留下被挖空后的残句');
  });

  test('正常句子原样保留', () => {
    const s = '他半夜说睡不着，承认怕黑';
    const { text, removed } = stripBanned(s);
    assert.equal(text, s);
    assert.deepEqual(removed, []);
  });

  test('整段都是禁用词时，退回到「只挖词」而不是清空', () => {
    const { text } = stripBanned('气氛很微妙');
    assert.ok(text.length > 0, '不能把整段清空（空段无法检索）');
    assert.ok(!text.includes('气氛'));
    assert.ok(!text.includes('微妙'));
  });

  test('禁用词表与 prompt 里写的是同一份', () => {
    for (const w of ['气氛', '微妙', '很多', '各种']) {
      assert.ok(GIST_BANNED_WORDS.includes(w), `禁用词表里缺「${w}」`);
    }
  });
});

describe('gist 全流程', () => {
  test('正常输入：三段齐全、禁用词为 0、长度达标', async () => {
    const res = await generateGist({
      llm: mockLlm([JSON.stringify(GOOD_GIST)]),
      msgs: MSGS,
      startAt: 1_763_000_300_000,
      endAt: 1_763_000_900_000,
    });

    assert.ok(res.gist, '应该产出 gist');
    for (const label of Object.values(GIST_LABELS)) {
      assert.ok(res.gist.includes(label), `缺少标签 ${label}`);
    }
    for (const w of GIST_BANNED_WORDS) {
      assert.ok(!res.gist.includes(w), `gist 里不应出现禁用词「${w}」`);
    }

    const n = countChars(res.gist);
    assert.ok(
      n >= GIST_LIMITS.minChars && n <= GIST_LIMITS.maxChars,
      `长度应在 ${GIST_LIMITS.minChars}~${GIST_LIMITS.maxChars}，实际 ${n}：\n${res.gist}`,
    );
  });

  test('模型写了禁用词 → gist 里被剔干净', async () => {
    const res = await generateGist({
      llm: mockLlm([JSON.stringify(BANNED_GIST)]),
      msgs: MSGS,
    });

    assert.ok(res.gist);
    for (const w of ['气氛', '微妙', '很多', '各种']) {
      assert.ok(!res.gist.includes(w), `应该剔除「${w}」，实际：\n${res.gist}`);
    }
    assert.ok(res.stats.bannedRemoved.includes('气氛'));
  });

  test('unresolved 词被抽出来，供上层写 lexicon', async () => {
    const res = await generateGist({
      llm: mockLlm([JSON.stringify(GOOD_GIST)]),
      msgs: MSGS,
    });
    assert.deepEqual(res.unresolved, ['点蜡']);
  });

  test('模型没给 unresolved 数组 → 从【不懂的】段兜底抽取', async () => {
    const payload = { gist: GOOD_GIST.gist }; // 故意不带 unresolved
    const res = await generateGist({ llm: mockLlm([JSON.stringify(payload)]), msgs: MSGS });
    assert.deepEqual(res.unresolved, ['点蜡']);
  });

  test('【不懂的】为「无」→ unresolved 为空', async () => {
    const payload = {
      gist: '【发生了什么】他半夜说睡不着，承认怕黑\n【原话】「睡不着，其实我有点怕黑」\n【不懂的】无',
      unresolved: [],
    };
    const res = await generateGist({ llm: mockLlm([JSON.stringify(payload)]), msgs: MSGS });
    assert.deepEqual(res.unresolved, []);
  });

  test('缺段 → gist 为 null，不产出半成品', async () => {
    const payload = { gist: '【发生了什么】他半夜说睡不着\n【原话】「睡不着」' };
    const res = await generateGist({ llm: mockLlm([JSON.stringify(payload)]), msgs: MSGS });
    assert.equal(res.gist, null);
    assert.equal(res.ok, false);
  });

  test('模型输出不是 JSON → gist 为 null，不抛', async () => {
    const res = await generateGist({ llm: mockLlm(['他半夜说睡不着，点蜡。']), msgs: MSGS });
    assert.equal(res.gist, null);
    assert.equal(res.ok, false);
  });

  test('带 ```json 围栏也能解析', async () => {
    const fenced = '```json\n' + JSON.stringify(GOOD_GIST) + '\n```';
    const res = await generateGist({ llm: mockLlm([fenced]), msgs: MSGS });
    assert.ok(res.gist);
  });

  test('空场景 → 不调模型', async () => {
    const llm = mockLlm([JSON.stringify(GOOD_GIST)]);
    const res = await generateGist({ llm, msgs: [] });
    assert.equal(res.gist, null);
    assert.equal(llm.calls.length, 0);
  });

  test('prompt 里带上了时间与消息数（便于模型写锚点）', async () => {
    const llm = mockLlm([JSON.stringify(GOOD_GIST)]);
    await generateGist({
      llm,
      msgs: MSGS,
      startAt: new Date('2026-11-12T23:36:00+08:00').getTime(),
      endAt: new Date('2026-11-13T00:12:00+08:00').getTime(),
    });
    const text = llm.calls[0].messages.map((m) => m.content).join('\n');
    assert.ok(text.includes('11-12 23:36'));
    assert.ok(text.includes('消息数】4'));
  });
});

describe('长度校正', () => {
  test('超长会被压到上限以内', async () => {
    const longWhat = '他半夜说睡不着，承认怕黑，一直聊到天亮才睡着，中间又说起小时候的事'.repeat(2);
    const long = {
      gist: [
        `【发生了什么】${longWhat}`,
        '【原话】「睡不着，其实我有点怕黑」「就点蜡」「灯不开了」「先把这一会儿陪过掉」',
        '【不懂的】点蜡、摸鱼罐、那个东西',
      ].join('\n'),
    };
    const res = await generateGist({ llm: mockLlm([JSON.stringify(long)]), msgs: MSGS });
    assert.ok(res.gist);
    const n = countChars(res.gist);
    assert.ok(n <= GIST_LIMITS.maxChars, `应压到 ${GIST_LIMITS.maxChars} 以内，实际 ${n}`);
    // 三段仍然齐全（压缩不能把某一段吃掉）
    for (const label of Object.values(GIST_LABELS)) {
      assert.ok(res.gist.includes(label));
    }
  });

  test('太短不补内容（补内容就是编）', async () => {
    const short = { gist: '【发生了什么】点蜡\n【原话】「点蜡」\n【不懂的】无' };
    const res = await generateGist({ llm: mockLlm([JSON.stringify(short)]), msgs: MSGS });
    assert.ok(res.gist);
    // 不达标要报出来，但不能自己加字
    assert.ok(res.stats.charCount < GIST_LIMITS.minChars);
    assert.ok(res.issues.some((s) => s.includes('长度')));
  });
});

describe('【原话】禁用词的特殊处理', () => {
  test('用户真的说了含禁用词的话 → 原样保留（不许造假）', () => {
    const msgs = [{ seq: 1, speaker: 'user', text: '那天气氛怪怪的，我说不上来' }];
    const r = cleanQuotes('「那天气氛怪怪的」', msgs);
    assert.equal(r.text, '「那天气氛怪怪的」');
    assert.deepEqual(r.removed, []);
  });

  test('原文里没有、又含禁用词 → 整句删掉（模型把自己的评价混进原话）', () => {
    const msgs = [{ seq: 1, speaker: 'user', text: '睡不着' }];
    const r = cleanQuotes('「气氛很微妙」', msgs);
    assert.equal(r.text, '');
    assert.ok(r.removed.includes('气氛'));
  });

  test('混排：真的保留，假的删掉', () => {
    const msgs = [{ seq: 1, speaker: 'user', text: '睡不着，其实我有点怕黑' }];
    const r = cleanQuotes('「睡不着，其实我有点怕黑」「气氛很微妙」', msgs);
    assert.equal(r.text, '「睡不着，其实我有点怕黑」');
    assert.ok(r.removed.includes('气氛'));
  });

  test('没有 msgs 可核对时保守保留，不乱删', () => {
    const r = cleanQuotes('「气氛很微妙」', undefined);
    assert.equal(r.text, '「气氛很微妙」');
  });
});

describe('【原话】逐字校验（D-029）', () => {
  test('引号内容真的出自原文 → 无告警', () => {
    const quoteLine = GOOD_GIST.gist.split('\n')[1];
    const issues = checkQuotesVerbatim(quoteLine, MSGS);
    assert.deepEqual(issues, []);
  });

  test('引号内容被改写 → 告警', () => {
    const fake = '【原话】「我特别怕黑，一点都不敢关灯」';
    const issues = checkQuotesVerbatim(fake, MSGS);
    assert.ok(issues.length > 0);
    assert.ok(issues[0].includes('疑似改写'));
  });

  test('无引号或无原文时不乱报', () => {
    assert.deepEqual(checkQuotesVerbatim('无', MSGS), []);
    assert.deepEqual(checkQuotesVerbatim('「点蜡」', undefined), []);
  });
});
