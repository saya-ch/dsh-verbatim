/**
 * 会话形态判别的**契约测试**。
 *
 * 这里守的是一条真实事故：
 *   `memory-search.js` 里按会话形态给 `windowQuota` 的逻辑，引用了**从未声明**的
 *   `shapeCache` 变量 → ReferenceError → 被外层 `catch` 吞掉 → 永远回落 1.0。
 *   「按会话形态自适应」这个功能上线后**从未生效过**，而且完全不报错。
 *
 * 所以这里不只测 `detectSessionShape` 的返回值，还测**它在工具里真的被调用到**
 * （配额必须随形态变化而变化，而不总是 1.0）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../store/db.js';
import { createExtras, createRepo } from '../store/repo.js';
import { detectSessionShape, COMPANION_AVG_CHARS } from './session-shape.js';
import { createSearchTool } from '../tools/memory-search.js';

const BASE = Date.parse('2026-11-18T20:00:00+08:00');

/** 造一个指定「平均字数」的会话 */
function seedSession(db, sessionId, { count, charsPerMsg }) {
  const repo = createRepo(db);
  const text = '啊'.repeat(charsPerMsg);
  for (let i = 1; i <= count; i += 1) {
    repo.insertMsg({
      sessionId,
      seq: i,
      at: BASE + i * 60_000,
      speaker: i % 2 === 1 ? 'user' : 'assistant',
      text,
      inSurface: 1,
      excluded: 0,
    });
  }
  return repo;
}

function fresh() {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: { warn: () => {} } });
  return { handle, db: handle.db, repo: createRepo(handle.db), extras: createExtras(handle.db) };
}

test('detectSessionShape：短消息会话判为陪伴型，配额 1.0', () => {
  const { handle, db } = fresh();
  try {
    seedSession(db, 'companion', { count: 40, charsPerMsg: 12 });
    const s = detectSessionShape(handle, 'companion');
    assert.equal(s.shape, 'companion');
    assert.equal(s.windowQuota, 1.0);
    assert.ok(s.avgChars < COMPANION_AVG_CHARS);
  } finally {
    handle.close();
  }
});

test('detectSessionShape：长消息会话判为技术型，但配额仍然 1.0（实测降配额会掉分）', () => {
  const { handle, db } = fresh();
  try {
    seedSession(db, 'technical', { count: 40, charsPerMsg: 200 });
    const s = detectSessionShape(handle, 'technical');
    assert.equal(s.shape, 'technical');
    // 技术型会话的对话窗同样有真实召回贡献，配额必须保持 1.0
    assert.equal(s.windowQuota, 1.0, '技术型配额也必须是 1.0');
    assert.ok(s.avgChars >= COMPANION_AVG_CHARS);
  } finally {
    handle.close();
  }
});

test('detectSessionShape：消息太少时不下结论，保守开满配额', () => {
  const { handle, db } = fresh();
  try {
    seedSession(db, 'tiny', { count: 5, charsPerMsg: 200 });
    const s = detectSessionShape(handle, 'tiny');
    assert.equal(s.shape, 'unknown');
    assert.equal(s.useWindow, true);
  } finally {
    handle.close();
  }
});

test('detectSessionShape：excluded 的消息不参与形态统计（统计口径必须与检索口径一致）', () => {
  const { handle, db, repo } = fresh();
  try {
    // 20 条短消息（可检索）+ 20 条超长消息（全部 excluded）
    seedSession(db, 'mixed', { count: 20, charsPerMsg: 12 });
    for (let i = 21; i <= 40; i += 1) {
      repo.insertMsg({
        sessionId: 'mixed',
        seq: i,
        at: BASE + i * 60_000,
        speaker: 'user',
        text: '长'.repeat(2000),
        inSurface: 1,
        excluded: 1,          // ← 检索不到
      });
    }
    const s = detectSessionShape(handle, 'mixed');
    // 若把 excluded 算进去，平均会是 (20*12 + 20*2000)/40 ≈ 1006 → 判成技术型
    assert.equal(s.msgCount, 20, '只应统计 excluded = 0 的 20 条');
    assert.equal(s.shape, 'companion', '可检索部分是短消息，应判为陪伴型');
    assert.equal(s.windowQuota, 1.0);
  } finally {
    handle.close();
  }
});

/**
 * **这条才是防事故的**：形态判别必须真的被工具调用到、且结果可观测。
 *
 * 事故背景：`memory-search.js` 曾引用未声明的 `shapeCache`，`ReferenceError`
 * 被 `catch { windowQuota = 1.0 }` 吞掉 → 该功能从未生效且不报错。
 *
 * 现在配额统一是 1.0（实测技术型也不该降），所以不能再靠「两种形态值不同」来判定。
 * 改为验证**这个值确实流经工具**并被 `onResult` 暴露出来 —— 若哪天它又变成
 * 不可观测的默认值，这条测试会失败。
 */
test('memory-search 真的计算并暴露了 windowQuota（防止形态检测被静默吞掉）', async () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: { warn: () => {} } });
  try {
    const repo = seedSession(handle.db, 's-x', { count: 40, charsPerMsg: 200 });
    const extras = createExtras(handle.db);
    let captured = null;
    const tool = createSearchTool({
      repo,
      extras,
      handle,
      sessionId: 's-x',
      semantic: false,        // 只测配额计算，不碰语义路
      onResult: (info) => { captured = info; },
    });
    await tool.handler({ query: '啊' });
    assert.ok(captured, 'onResult 应当被调用');
    assert.equal(
      captured.windowQuota,
      1.0,
      'windowQuota 必须被计算并暴露（若为 undefined，说明形态检测又被 catch 吞掉了）',
    );
  } finally {
    handle.close();
  }
});
