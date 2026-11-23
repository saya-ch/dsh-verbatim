/**
 * fact 提炼的测试 —— 全部用 mock provider，不调真实 API
 *
 * 验收重点（BUILD-PLAN.md §6.1 T5 那一行）：
 *   **mock provider：fact 校验拦下 speaker='her' 的来源**
 * 这一条是 D-069 的唯一代码保证，必须单独、显式地测。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mockLlm } from '../model/mock.js';
import {
  extractFacts,
  validateFact,
  mergeFacts,
  DROP_REASONS,
  FACT_LIMITS,
} from './fact.js';
import { FACT_SUBJECTS } from './prompts.js';

// ─────────────────────────────────────────────
// 测试数据
// ─────────────────────────────────────────────

/** 造一条 msg */
function msg(seq, speaker, text, extra = {}) {
  return { seq, speaker, text, at: 1_763_000_000_000 + seq * 1000, inSurface: 1, ...extra };
}

/** 一场正常对话：user 说自己，TA回应 */
const SCENE = [
  msg(101, 'user', '其实我有点怕黑，但不想开灯'),
  msg(102, 'assistant', '那我陪你，灯就不开了'),
  msg(103, 'user', '你别叫我哥哥了，叫我阿止吧'),
  msg(104, 'assistant', '好，阿止'),
];

/** 模型输出：合法 */
const GOOD_OUTPUT = JSON.stringify({
  facts: [
    {
      subject: 'me',
      key: '怕黑',
      value: '其实有点怕黑，但不想开灯',
      sourceSeq: 101,
      origin: 'extracted_from_user',
    },
    {
      subject: 'me',
      key: '称呼',
      value: '别叫哥哥，叫阿止',
      sourceSeq: 103,
      origin: 'extracted_from_user',
    },
  ],
});

/** 建一个 seq → msg 的查询函数（模拟上层 repo） */
function lookupFrom(msgs) {
  const map = new Map(msgs.map((m) => [m.seq, m]));
  return (seq) => map.get(seq) ?? null;
}

// ─────────────────────────────────────────────
// 五条硬校验
// ─────────────────────────────────────────────

describe('五条硬校验', () => {
  test('① sourceSeq 不存在 → 丢弃', () => {
    const dropped = [];
    const fact = validateFact(
      { subject: 'me', key: '怕黑', value: '怕黑', sourceSeq: 999 },
      { lookupMsg: lookupFrom(SCENE), onDrop: (r) => dropped.push(r) },
    );
    assert.equal(fact, null);
    assert.deepEqual(dropped, [DROP_REASONS.SOURCE_MISSING]);
  });

  test('① sourceSeq 缺失 → 丢弃', () => {
    const fact = validateFact(
      { subject: 'me', key: '怕黑', value: '怕黑' },
      { lookupMsg: lookupFrom(SCENE) },
    );
    assert.equal(fact, null);
  });

  test('② 来源是 her（assistant）→ 丢弃（D-069 核心）', () => {
    const dropped = [];
    const fact = validateFact(
      // 明明 seq=102 真实存在，但那条是TA说的
      { subject: 'me', key: '怕黑', value: '其实有点怕黑，但不想开灯', sourceSeq: 102 },
      { lookupMsg: lookupFrom(SCENE), onDrop: (r) => dropped.push(r) },
    );
    assert.equal(fact, null, 'TA的话永不自动成为事实');
    assert.deepEqual(dropped, [DROP_REASONS.SOURCE_NOT_USER]);
  });

  test('② 整批提炼时，指向 assistant 的条目被拦下，合法的照常通过', () => {
    // 模型把 her 的话误当成事实来源
    const bad = JSON.stringify({
      facts: [
        { subject: 'me', key: '怕黑', value: '其实有点怕黑', sourceSeq: 102 }, // her 说的
        { subject: 'me', key: '称呼', value: '叫阿止', sourceSeq: 103 }, // 合法
      ],
    });

    return extractFacts({
      llm: mockLlm([bad]),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
    }).then((res) => {
      assert.equal(res.facts.length, 1);
      assert.equal(res.facts[0].sourceSeq, 103);
      assert.equal(res.dropped.length, 1);
      assert.equal(res.dropped[0].reason, DROP_REASONS.SOURCE_NOT_USER);
    });
  });

  test('③ inSurface !== 1 → 丢弃（压缩/撤回过的不能当依据）', () => {
    const scene = [...SCENE, msg(105, 'user', '这句已经被压缩了', { inSurface: 0 })];
    const dropped = [];
    const fact = validateFact(
      { subject: 'me', key: '压缩', value: '这句已经被压缩了', sourceSeq: 105 },
      { lookupMsg: lookupFrom(scene), onDrop: (r) => dropped.push(r) },
    );
    assert.equal(fact, null);
    assert.deepEqual(dropped, [DROP_REASONS.SOURCE_NOT_SURFACE]);
  });

  test('③ 兼容库里的 in_surface 字段名', () => {
    const scene = [msg(105, 'user', '这句被压缩了', { inSurface: 0, in_surface: 0 })];
    const fact = validateFact(
      { subject: 'me', key: '压缩', value: '这句被压缩了', sourceSeq: 105 },
      { lookupMsg: lookupFrom(scene) },
    );
    assert.equal(fact, null);
  });

  test('④ key 超过 20 字 → 丢弃', () => {
    const longKey = '一'.repeat(FACT_LIMITS.keyMaxChars + 1);
    const dropped = [];
    const fact = validateFact(
      { subject: 'me', key: longKey, value: '短的', sourceSeq: 101 },
      { lookupMsg: lookupFrom(SCENE), onDrop: (r) => dropped.push(r) },
    );
    assert.equal(fact, null);
    assert.deepEqual(dropped, [DROP_REASONS.KEY_TOO_LONG]);
  });

  test('④ key 恰好 20 字 → 通过（边界）', () => {
    const exactKey = '一'.repeat(FACT_LIMITS.keyMaxChars);
    const fact = validateFact(
      { subject: 'me', key: exactKey, value: '短的', sourceSeq: 101 },
      { lookupMsg: lookupFrom(SCENE) },
    );
    assert.ok(fact);
    assert.equal(fact.key, exactKey);
  });

  test('⑤ value 超过 80 字 → 丢弃', () => {
    const longValue = '字'.repeat(FACT_LIMITS.valueMaxChars + 1);
    const dropped = [];
    const fact = validateFact(
      { subject: 'me', key: '长句', value: longValue, sourceSeq: 101 },
      { lookupMsg: lookupFrom(SCENE), onDrop: (r) => dropped.push(r) },
    );
    assert.equal(fact, null);
    assert.deepEqual(dropped, [DROP_REASONS.VALUE_TOO_LONG]);
  });

  test('⑤ value 恰好 80 字 → 通过（边界）', () => {
    const exactValue = '字'.repeat(FACT_LIMITS.valueMaxChars);
    const fact = validateFact(
      { subject: 'me', key: '长句', value: exactValue, sourceSeq: 101 },
      { lookupMsg: lookupFrom(SCENE) },
    );
    assert.ok(fact);
    assert.equal([...fact.value].length, FACT_LIMITS.valueMaxChars);
  });

  test('额外：subject 不在 me/her/us → 丢弃', () => {
    const fact = validateFact(
      { subject: 'she', key: '称呼', value: '叫阿止', sourceSeq: 103 },
      { lookupMsg: lookupFrom(SCENE) },
    );
    assert.equal(fact, null);
  });

  test('额外：key 或 value 为空 → 丢弃', () => {
    assert.equal(
      validateFact({ subject: 'me', key: '  ', value: 'x', sourceSeq: 101 }, { lookupMsg: lookupFrom(SCENE) }),
      null,
    );
    assert.equal(
      validateFact({ subject: 'me', key: 'x', value: '', sourceSeq: 101 }, { lookupMsg: lookupFrom(SCENE) }),
      null,
    );
  });

  test('额外：模型写 her_claim / user_confirmed 的来源 → 丢弃（D-072 三档分开）', () => {
    for (const origin of ['her_claim', 'user_confirmed']) {
      const dropped = [];
      const fact = validateFact(
        { subject: 'me', key: '称呼', value: '叫阿止', sourceSeq: 103, origin },
        { lookupMsg: lookupFrom(SCENE), onDrop: (r) => dropped.push(r) },
      );
      assert.equal(fact, null, `${origin} 不由本模块产生`);
      assert.deepEqual(dropped, [DROP_REASONS.BAD_ORIGIN]);
    }
  });

  test('通过的条目 origin 一定是 extracted_from_user', () => {
    const fact = validateFact(
      { subject: 'us', key: '称呼', value: '叫阿止', sourceSeq: 103, origin: '乱七八糟' },
      { lookupMsg: lookupFrom(SCENE) },
    );
    assert.ok(fact);
    assert.equal(fact.origin, 'extracted_from_user');
  });
});

// ─────────────────────────────────────────────
// 提炼流程
// ─────────────────────────────────────────────

describe('提炼流程', () => {
  test('正常提取：两条合法事实全通过', async () => {
    const res = await extractFacts({
      llm: mockLlm([GOOD_OUTPUT]),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
    });

    assert.equal(res.ok, true);
    assert.equal(res.facts.length, 2);
    assert.deepEqual(
      res.facts.map((f) => f.key),
      ['怕黑', '称呼'],
    );
    for (const f of res.facts) {
      assert.ok(FACT_SUBJECTS.includes(f.subject));
      assert.equal(f.origin, 'extracted_from_user');
      // 每条必须能指回真实的 user 消息
      const src = SCENE.find((m) => m.seq === f.sourceSeq);
      assert.equal(src.speaker, 'user');
      assert.equal(src.inSurface, 1);
    }
  });

  test('模型返回空数组 → 得到空结果，不编（不许编）', async () => {
    const res = await extractFacts({
      llm: mockLlm([JSON.stringify({ facts: [] })]),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.facts, []);
  });

  test('模型输出带 ```json 围栏 → 仍能解析', async () => {
    const fenced = '```json\n' + GOOD_OUTPUT + '\n```';
    const res = await extractFacts({
      llm: mockLlm([fenced]),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
    });
    assert.equal(res.facts.length, 2);
  });

  test('模型输出前后有冗余说明 → 仍能提取 JSON', async () => {
    const noisy = `好的，这是提取结果：\n${GOOD_OUTPUT}\n以上就是全部。`;
    const res = await extractFacts({
      llm: mockLlm([noisy]),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
    });
    assert.equal(res.facts.length, 2);
  });

  test('模型输出不是 JSON → ok=false，不抛、不产生假事实', async () => {
    const res = await extractFacts({
      llm: mockLlm(['我觉得你怕黑，还讨厌被叫哥哥。']),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
    });
    assert.equal(res.ok, false);
    assert.deepEqual(res.facts, []);
    assert.ok(res.issues.length > 0);
  });

  test('只把 speaker=user 的消息送进 prompt（TA的话不进模型）', async () => {
    const llm = mockLlm([JSON.stringify({ facts: [] })]);
    await extractFacts({ llm, msgs: SCENE, lookupMsg: lookupFrom(SCENE) });

    assert.equal(llm.calls.length, 1);
    const promptText = llm.calls[0].messages.map((m) => m.content).join('\n');
    assert.ok(promptText.includes('怕黑'), 'user 的原话应该在 prompt 里');
    assert.ok(!promptText.includes('那我陪你，灯就不开了'), 'TA的话不应该进 fact prompt');
    // 只剩 user 的两条（101 / 103）
    assert.ok(promptText.includes('[seq=101]'));
    assert.ok(promptText.includes('[seq=103]'));
    assert.ok(!promptText.includes('[seq=102]'));
  });

  test('inSurface=0 的消息不进 prompt', async () => {
    const scene = [...SCENE, msg(105, 'user', '被压缩的那句', { inSurface: 0 })];
    const llm = mockLlm([JSON.stringify({ facts: [] })]);
    await extractFacts({ llm, msgs: scene, lookupMsg: lookupFrom(scene) });
    const promptText = llm.calls[0].messages.map((m) => m.content).join('\n');
    assert.ok(!promptText.includes('被压缩的那句'));
  });

  test('只有 her 的消息 → 直接跳过，不调模型', async () => {
    const llm = mockLlm([JSON.stringify({ facts: [] })]);
    const herOnly = [msg(201, 'assistant', 'TA说了一件很重要的事')];
    const res = await extractFacts({ llm, msgs: herOnly, lookupMsg: lookupFrom(herOnly) });
    assert.deepEqual(res.facts, []);
    assert.equal(llm.calls.length, 0, '没有 user 消息就不该烧调用');
  });

  test('同一 subject+key 重复 → 去重', async () => {
    const dup = JSON.stringify({
      facts: [
        { subject: 'me', key: '怕黑', value: '怕黑', sourceSeq: 101 },
        { subject: 'me', key: '怕黑', value: '还是很怕黑', sourceSeq: 101 },
      ],
    });
    const res = await extractFacts({
      llm: mockLlm([dup]),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
    });
    assert.equal(res.facts.length, 1);
    assert.equal(res.facts[0].value, '怕黑');
  });

  test('超过单批上限 → 丢弃多余', async () => {
    const many = JSON.stringify({
      facts: Array.from({ length: 10 }, (_, i) => ({
        subject: 'me',
        key: `事${i}`,
        value: `第${i}件事`,
        sourceSeq: 101,
      })),
    });
    const res = await extractFacts({
      llm: mockLlm([many]),
      msgs: SCENE,
      lookupMsg: lookupFrom(SCENE),
      maxFacts: 3,
    });
    assert.equal(res.facts.length, 3);
    assert.ok(res.dropped.some((d) => d.reason === DROP_REASONS.OVER_LIMIT));
  });

  test('不传 lookupMsg 时用本批 msgs 自建索引', async () => {
    const res = await extractFacts({ llm: mockLlm([GOOD_OUTPUT]), msgs: SCENE });
    assert.equal(res.facts.length, 2);
  });

  test('drop 原因码是稳定的英文常量，不是中文', async () => {
    for (const v of Object.values(DROP_REASONS)) {
      assert.match(v, /^[a-z_]+$/);
    }
  });
});

// ─────────────────────────────────────────────
// 合并
// ─────────────────────────────────────────────

describe('mergeFacts', () => {
  test('同 subject+key 用新的覆盖旧的', () => {
    const oldFacts = [{ subject: 'me', key: '怕黑', value: '旧值' }];
    const newFacts = [{ subject: 'me', key: '怕黑', value: '新值' }];
    const merged = mergeFacts(oldFacts, newFacts);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].value, '新值');
  });

  test('不同 subject 的同名 key 不合并', () => {
    const merged = mergeFacts(
      [{ subject: 'me', key: '称呼', value: '阿止' }],
      [{ subject: 'us', key: '称呼', value: '互相叫名字' }],
    );
    assert.equal(merged.length, 2);
  });
});
