/**
 * 「相关度偏低」柔提示的契约测试。
 *
 * 这里守的是**产品决策**，不是实现细节：
 *   系统只做「提示」不做「硬拦截」。任何让这个函数变得激进、
 *   或者让它在明显有证据时也报警的改动，都应该被这些测试拦住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { weakEvidenceHint, WEAK_TOP1_FLOOR } from './memory-search.js';

const hits = (...scores) => scores.map((score, i) => ({ id: i + 1, score }));

test('有字面命中时不提示（用户搜到了确切的词）', () => {
  // 即使分数很低，只要关键词路有命中就说明用户搜的词真的在原文里
  assert.equal(weakEvidenceHint(hits(0.30), 3), null);
});

test('top-1 高于地板时不提示', () => {
  assert.equal(weakEvidenceHint(hits(WEAK_TOP1_FLOOR)), null);
  assert.equal(weakEvidenceHint(hits(0.85, 0.80)), null);
});

test('top-1 低于地板时提示，并带上真实分数', () => {
  const out = weakEvidenceHint(hits(0.41, 0.39), 0);
  assert.ok(out, '应当给出提示');
  assert.match(out, /相关度偏低/);
  assert.match(out, /0\.41/, '提示里要带上真实的最高分，便于用户判断');
});

test('没有任何带分数的命中时不提示（多为纯关键词结果，不该说它不靠谱）', () => {
  assert.equal(weakEvidenceHint([{ id: 1 }, { id: 2 }], 0), null);
  assert.equal(weakEvidenceHint([], 0), null);
  assert.equal(weakEvidenceHint(null, 0), null);
});

test('地板值 0.62 是稳定的产品契约，不能随手改', () => {
  // 改这个值等于直接改变多少用户会看到「可能不相关」提示，必须谨慎评估。
  assert.equal(
    WEAK_TOP1_FLOOR,
    0.62,
    'WEAK_TOP1_FLOOR 应保持 0.62，避免误伤正常语义检索结果',
  );
});

test('提示语必须说明「这是提示，不是结论」', () => {
  const out = weakEvidenceHint(hits(0.40), 0);
  // 关键是让 Agent 知道可以自己判断，而不是被系统告知「没有」
  assert.match(out, /自行确认|未必/, '提示语不能断言「不存在」，只能提示「可能不相关」');
});
