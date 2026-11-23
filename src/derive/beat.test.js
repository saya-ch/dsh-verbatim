/**
 * beat 分类的测试 —— 全部用 mock provider，不调真实 API
 *
 * 验收重点（BUILD-PLAN.md §6.1 T5）：
 *   **返回合法 kind，且低置信度能被识别**
 * 外加 D-104 的语义：一条消息可属多类、分类不依赖历史。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mockLlm } from '../model/mock.js';
import {
  classifyBeat,
  finalizeBeats,
  groupByKind,
  isLowConfidence,
  BEAT_KINDS,
  LOW_CONFIDENCE_THRESHOLD,
} from './beat.js';

// ─────────────────────────────────────────────
// 测试数据
// ─────────────────────────────────────────────

const MSG = { seq: 401, speaker: 'user', text: '我怕黑，你能不能别挂' };

describe('12 类清单', () => {
  test('恰好 12 类，与 BUILD-PLAN §4.3 一致', () => {
    assert.equal(BEAT_KINDS.length, 12);
    assert.deepEqual(
      [...BEAT_KINDS].sort(),
      [
        'apology',
        'avoid',
        'boundary',
        'care',
        'conflict',
        'intimacy',
        'probe',
        'promise',
        'seek',
        'share',
        'tease',
        'vuln',
      ].sort(),
    );
  });

  test('清单被冻结，不会被误改', () => {
    assert.ok(Object.isFrozen(BEAT_KINDS));
  });
});

describe('解析与规范化', () => {
  test('正常输出：kind 全部合法，confidence 原样保留', () => {
    const text = JSON.stringify({
      beats: [
        { kind: 'vuln', confidence: 0.92 },
        { kind: 'seek', confidence: 0.71 },
      ],
    });
    const res = finalizeBeats(text);

    assert.equal(res.ok, true);
    for (const b of res.beats) {
      assert.ok(BEAT_KINDS.includes(b.kind), `kind 必须合法，收到 ${b.kind}`);
    }
    assert.deepEqual(res.beats, [
      { kind: 'vuln', confidence: 0.92 },
      { kind: 'seek', confidence: 0.71 },
    ]);
  });

  test('低置信度能不被当成确定标签', () => {
    const text = JSON.stringify({
      beats: [
        { kind: 'tease', confidence: 0.35 },
        { kind: 'conflict', confidence: 0.55 },
      ],
    });
    const res = finalizeBeats(text);

    // 全部低于阈值 → 整条消息标记为低置信
    assert.equal(res.lowConfidence, true);
    for (const b of res.beats) {
      assert.ok(isLowConfidence(b));
    }
  });

  test('有一类站得住 → 整条消息不算低置信', () => {
    const text = JSON.stringify({
      beats: [
        { kind: 'vuln', confidence: 0.88 },
        { kind: 'probe', confidence: 0.4 },
      ],
    });
    const res = finalizeBeats(text);
    assert.equal(res.lowConfidence, false);
    // 但个别类仍然可以是低置信的（分开存，上层各自决定）
    assert.ok(isLowConfidence(res.beats.find((b) => b.kind === 'probe')));
    assert.ok(!isLowConfidence(res.beats.find((b) => b.kind === 'vuln')));
  });

  test('非法 kind 被丢弃，不映射不猜', () => {
    const text = JSON.stringify({
      beats: [
        { kind: 'flirty', confidence: 0.9 }, // 不在 12 类里
        { kind: 'vuln', confidence: 0.8 },
        { kind: '  ', confidence: 0.7 },
      ],
    });
    const res = finalizeBeats(text);

    assert.equal(res.beats.length, 1);
    assert.equal(res.beats[0].kind, 'vuln');
    assert.ok(res.issues.some((s) => s.includes('不在 12 类')));
  });

  test('kind 大小写与空格被归一', () => {
    const text = JSON.stringify({ beats: [{ kind: ' VuLn ', confidence: 0.8 }] });
    const res = finalizeBeats(text);
    assert.equal(res.beats[0].kind, 'vuln');
  });

  test('缺 confidence → 按 0.5（不确定）处理，绝不虚高', () => {
    const text = JSON.stringify({ beats: [{ kind: 'care' }] });
    const res = finalizeBeats(text);

    assert.equal(res.beats[0].confidence, 0.5);
    assert.ok(res.beats[0].confidence < LOW_CONFIDENCE_THRESHOLD);
    assert.equal(res.lowConfidence, true);
    assert.ok(res.issues.some((s) => s.includes('缺少合法 confidence')));
  });

  test('confidence 越界被夹到 [0,1]', () => {
    const text = JSON.stringify({
      beats: [
        { kind: 'vuln', confidence: 1.7 },
        { kind: 'seek', confidence: -0.3 },
      ],
    });
    const res = finalizeBeats(text);
    assert.equal(res.beats.find((b) => b.kind === 'vuln').confidence, 1);
    assert.equal(res.beats.find((b) => b.kind === 'seek').confidence, 0);
  });

  test('同 kind 重复 → 取更高的 confidence', () => {
    const text = JSON.stringify({
      beats: [
        { kind: 'vuln', confidence: 0.4 },
        { kind: 'vuln', confidence: 0.85 },
      ],
    });
    const res = finalizeBeats(text);
    assert.equal(res.beats.length, 1);
    assert.equal(res.beats[0].confidence, 0.85);
  });

  test('结果按 confidence 降序，便于上层截断', () => {
    const text = JSON.stringify({
      beats: [
        { kind: 'share', confidence: 0.5 },
        { kind: 'vuln', confidence: 0.95 },
        { kind: 'seek', confidence: 0.7 },
      ],
    });
    const res = finalizeBeats(text);
    const confs = res.beats.map((b) => b.confidence);
    assert.deepEqual(confs, [...confs].sort((a, b) => b - a));
  });

  test('空数组 → 合法结果，不是错误', () => {
    const res = finalizeBeats(JSON.stringify({ beats: [] }));
    assert.equal(res.ok, true);
    assert.deepEqual(res.beats, []);
    assert.equal(res.lowConfidence, true);
  });

  test('模型直接返回数组也接受', () => {
    const res = finalizeBeats(JSON.stringify([{ kind: 'care', confidence: 0.9 }]));
    assert.equal(res.beats[0].kind, 'care');
  });

  test('带 ```json 围栏也能解析', () => {
    const fenced =
      '```json\n' + JSON.stringify({ beats: [{ kind: 'intimacy', confidence: 0.8 }] }) + '\n```';
    const res = finalizeBeats(fenced);
    assert.equal(res.beats[0].kind, 'intimacy');
  });

  test('输出不是 JSON → ok=false，返回空 beats，不抛', () => {
    const res = finalizeBeats('这条像是在撒娇吧。');
    assert.equal(res.ok, false);
    assert.deepEqual(res.beats, []);
    assert.ok(res.issues.length > 0);
  });

  test('缺少 beats 字段 → ok=false', () => {
    const res = finalizeBeats(JSON.stringify({ labels: [] }));
    assert.equal(res.ok, false);
  });
});

describe('分类全流程', () => {
  test('单条消息：返回合法 kind', async () => {
    const llm = mockLlm([
      JSON.stringify({
        beats: [
          { kind: 'vuln', confidence: 0.9 },
          { kind: 'seek', confidence: 0.65 },
        ],
      }),
    ]);

    const res = await classifyBeat({ llm, msg: MSG });
    assert.equal(res.ok, true);
    assert.ok(res.beats.length >= 1);
    for (const b of res.beats) {
      assert.ok(BEAT_KINDS.includes(b.kind));
      assert.equal(typeof b.confidence, 'number');
      assert.ok(b.confidence >= 0 && b.confidence <= 1);
    }
  });

  test('prompt 里带上前后消息（判断「在回应什么」）', async () => {
    const llm = mockLlm([JSON.stringify({ beats: [] })]);
    await classifyBeat({
      llm,
      msg: MSG,
      before: { speaker: 'assistant', text: '灯我不开' },
      after: { speaker: 'assistant', text: '我在' },
    });

    const text = llm.calls[0].messages.map((m) => m.content).join('\n');
    assert.ok(text.includes('【前一条】'));
    assert.ok(text.includes('【后一条】'));
    assert.ok(text.includes('我怕黑'));
  });

  test('空消息 → 跳过，不调模型', async () => {
    const llm = mockLlm([JSON.stringify({ beats: [] })]);
    const res = await classifyBeat({ llm, msg: { seq: 1, speaker: 'user', text: '   ' } });
    assert.deepEqual(res.beats, []);
    assert.equal(llm.calls.length, 0);
  });

  test('TA（assistant）的回复也能分类（因为是互动）', async () => {
    const llm = mockLlm([JSON.stringify({ beats: [{ kind: 'care', confidence: 0.85 }] })]);
    const res = await classifyBeat({
      llm,
      msg: { seq: 402, speaker: 'assistant', text: '我在，灯不开' },
    });
    assert.equal(res.beats[0].kind, 'care');
  });

  test('拿不准时整条消息被标为低置信（不硬分）', async () => {
    const llm = mockLlm([
      JSON.stringify({ beats: [{ kind: 'probe', confidence: 0.42 }] }),
    ]);
    const res = await classifyBeat({ llm, msg: MSG });
    assert.equal(res.lowConfidence, true);
    assert.ok(res.beats.every(isLowConfidence));
  });

  test('模型乱给 kind → 空结果，不硬塞一个默认类', async () => {
    const llm = mockLlm([JSON.stringify({ beats: [{ kind: 'unknown', confidence: 0.9 }] })]);
    const res = await classifyBeat({ llm, msg: MSG });
    assert.deepEqual(res.beats, []);
    assert.equal(res.lowConfidence, true);
  });
});

describe('发展通道归组（D-104）', () => {
  test('按 kind 归组并按时间升序', () => {
    const beats = [
      { kind: 'vuln', confidence: 0.9, at: 300 },
      { kind: 'vuln', confidence: 0.8, at: 100 },
      { kind: 'vuln', confidence: 0.85, at: 200 },
      { kind: 'care', confidence: 0.9, at: 150 },
    ];
    const map = groupByKind(beats);
    assert.deepEqual(
      map.get('vuln').map((b) => b.at),
      [100, 200, 300],
    );
    assert.equal(map.get('care').length, 1);
  });

  test('默认丢弃低置信的，不让噪声进发展序列', () => {
    const beats = [
      { kind: 'vuln', confidence: 0.9, at: 1 },
      { kind: 'vuln', confidence: 0.4, at: 2 },
    ];
    const map = groupByKind(beats);
    assert.equal(map.get('vuln').length, 1);
    assert.equal(map.get('vuln')[0].at, 1);
  });

  test('minConfidence 可调（人工抽检时可以放宽）', () => {
    const beats = [{ kind: 'vuln', confidence: 0.4, at: 2 }];
    const map = groupByKind(beats, { minConfidence: 0.3 });
    assert.equal(map.get('vuln').length, 1);
  });

  test('非法 kind 不进序列', () => {
    const map = groupByKind([{ kind: 'flirty', confidence: 0.9, at: 1 }]);
    assert.equal(map.size, 0);
  });
});

describe('isLowConfidence', () => {
  test('缺字段 / 非数字 → 一律视为低置信', () => {
    assert.equal(isLowConfidence(null), true);
    assert.equal(isLowConfidence({ kind: 'vuln' }), true);
    assert.equal(isLowConfidence({ kind: 'vuln', confidence: '0.9' }), true);
  });

  test('阈值边界：0.6 及以上算站得住', () => {
    assert.equal(isLowConfidence({ kind: 'vuln', confidence: 0.6 }), false);
    assert.equal(isLowConfidence({ kind: 'vuln', confidence: 0.599 }), true);
  });
});
