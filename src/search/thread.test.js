import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coalesceTurns,
  buildExchanges,
  segmentThreadsByValley,
  foldTimelineClusters,
} from './thread.js';

const BASE = Date.parse('2026-11-20T20:00:00+08:00');
const mk = (id, offsetSec, speaker, text, extra = {}) => ({
  id,
  sceneId: 1,
  sessionId: 's1',
  seq: id,
  at: BASE + offsetSec * 1000,
  speaker,
  text,
  excluded: 0,
  ...extra,
});

function unitVec(axis, dim = 8) {
  const v = new Float32Array(dim);
  v[axis % dim] = 1;
  return v;
}

function mixVec(a, b, wA = 0.5) {
  const v = new Float32Array(a.length);
  let norm = 0;
  for (let i = 0; i < a.length; i += 1) {
    v[i] = wA * a[i] + (1 - wA) * b[i];
    norm += v[i] * v[i];
  }
  const n = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i += 1) v[i] /= n;
  return v;
}

test('coalesceTurns：合并连续同人短消息，跳过 excluded，超间隔断开', () => {
  const msgs = [
    mk(1, 0, 'user', '今天好累'),
    mk(2, 20, 'user', '猫咪也不理我'),
    mk(3, 40, 'assistant', '怎么啦，抱抱'),
    mk(4, 50, 'assistant', '被屏蔽的一句', { excluded: 1 }),
    mk(5, 300, 'user', '算了睡了'), // 超过 3 分钟但换了人，本来就分 Turn
    mk(6, 600, 'user', '隔了5分钟又说一句'),
  ];
  const turns = coalesceTurns(msgs);
  assert.equal(turns.length, 4);
  assert.equal(turns[0].startMsgId, 1);
  assert.equal(turns[0].endMsgId, 2);
  assert.match(turns[0].text, /今天好累\n猫咪也不理我/);
  assert.equal(turns[1].text, '怎么啦，抱抱');
  assert.equal(turns[2].text, '算了睡了');
  assert.equal(turns[3].text, '隔了5分钟又说一句');
});

test('buildExchanges：配对一问一答，保留完整因果语境', () => {
  const msgs = [
    mk(1, 0, 'user', '帮我查一下'),
    mk(2, 10, 'user', '上次那家宠物医院叫啥'),
    mk(3, 25, 'assistant', '叫爱宠之家，不过那天关门了'),
    mk(4, 1200, 'assistant', '对了明天记得带伞'), // 孤立单条
  ];
  const turns = coalesceTurns(msgs);
  const ex = buildExchanges(turns);
  assert.equal(ex.length, 2);
  assert.equal(ex[0].startMsgId, 1);
  assert.equal(ex[0].endMsgId, 3);
  assert.match(ex[0].text, /你：帮我查一下\n上次那家宠物医院叫啥\nTA：叫爱宠之家/);
  assert.equal(ex[1].startMsgId, 4);
});

test('segmentThreadsByValley：在局部语义谷值处精准断开两个微话题', () => {
  const vCat = unitVec(0);
  const vCat2 = mixVec(unitVec(0), unitVec(1), 0.9);
  const vWork = unitVec(3);
  const vWork2 = mixVec(unitVec(3), unitVec(4), 0.9);

  const exs = [
    { startMsgId: 1, endMsgId: 2, startAt: BASE, endAt: BASE + 1000, text: '聊猫1', msgs: [mk(1, 0, 'user', 'a')], vec: vCat },
    { startMsgId: 3, endMsgId: 4, startAt: BASE + 2000, endAt: BASE + 3000, text: '聊猫2', msgs: [mk(3, 2, 'user', 'b')], vec: vCat2 },
    { startMsgId: 5, endMsgId: 6, startAt: BASE + 4000, endAt: BASE + 5000, text: '聊猫3', msgs: [mk(5, 4, 'user', 'c')], vec: vCat },
    // 语义突变点：从猫切到工作
    { startMsgId: 7, endMsgId: 8, startAt: BASE + 6000, endAt: BASE + 7000, text: '工作1', msgs: [mk(7, 6, 'user', 'd')], vec: vWork },
    { startMsgId: 9, endMsgId: 10, startAt: BASE + 8000, endAt: BASE + 9000, text: '工作2', msgs: [mk(9, 8, 'user', 'e')], vec: vWork2 },
  ];

  const ths = segmentThreadsByValley(exs);
  assert.equal(ths.length, 2, '应在猫与工作之间切出 2 个微话题');
  assert.equal(ths[0].startMsgId, 1);
  assert.equal(ths[0].endMsgId, 6);
  assert.equal(ths[1].startMsgId, 7);
  assert.equal(ths[1].endMsgId, 10);
});

test('foldTimelineClusters：跨天同主题自动折叠进主命中的故事线，释放 Top-K 名额', () => {
  const vCat = unitVec(0);
  const vCatSim = mixVec(unitVec(0), unitVec(1), 0.98); // dot ≈ 0.98 >= 0.78
  const vOther = unitVec(4);

  const hits = [
    { id: 10, sceneId: 1, at: BASE, vec: vCat },
    { id: 20, sceneId: 2, at: BASE + 86400_000, vec: vCatSim }, // 跨天同主题，应折叠
    { id: 30, sceneId: 3, at: BASE + 2 * 86400_000, vec: vOther },
  ];
  const folded = foldTimelineClusters(hits, (h) => h.vec);
  assert.equal(folded.length, 2, '跨天同主题应折叠为 1 个主命中，释放出名额');
  assert.equal(folded[0].id, 10);
  assert.equal(folded[0].relatedTimeline.length, 1);
  assert.equal(folded[0].relatedTimeline[0].id, 20);
  assert.equal(folded[1].id, 30);
});
