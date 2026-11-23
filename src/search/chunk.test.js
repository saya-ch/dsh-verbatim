/**
 * 长文本分片（D-247）的测试。
 *
 * 重点不是"切成几片"，而是**切出来的东西还能不能读**：
 *   ① 每片从句首开始（不能把半句话切开）
 *   ② 原文 100% 覆盖（不能丢字）
 *   ③ 相邻片有重叠（横跨边界的句子两边都看得到）
 *   ④ 短文本不切（绝大多数消息不该走这条路）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitIntoChunks,
  splitSentences,
  shouldChunk,
  formatChunkWithContext,
  CHUNK_MIN_CHARS,
  CHUNK_TARGET_CHARS,
} from './chunk.js';

/** 造一段多句的长文本 */
function makeLong(sentenceCount = 60) {
  const s = '这是第若干句话，用来测试分片是否能按句子边界切开而不是硬切字符。';
  return `开场。${s.repeat(sentenceCount)}结尾。`;
}

test('短文本不切 —— 返回 null，调用方按「一条消息一个向量」处理', () => {
  assert.equal(splitIntoChunks('我怕黑'), null);
  assert.equal(splitIntoChunks('句子。'.repeat(100)), null); // 400 字，仍低于阈值
  // 正好卡在阈值上：应该切（>= CHUNK_MIN_CHARS）
  const atThreshold = '啊'.repeat(CHUNK_MIN_CHARS);
  assert.equal(shouldChunk(atThreshold), true, `${CHUNK_MIN_CHARS} 字算「该切」`);
  assert.equal(shouldChunk(atThreshold.slice(1)), false);
});

test('长文本按句子边界切：每片都从句首开始', () => {
  const text = makeLong();
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length > 1, `应当切成多片，实际 ${chunks.length}`);

  for (let i = 1; i < chunks.length; i++) {
    const prev = text[chunks[i].start - 1];
    assert.match(
      prev,
      /[。！？!?\n]/u,
      `第 ${i} 片没有从句首开始（前一个字符是「${prev}」）`,
    );
  }
});

test('原文 100% 覆盖：每个字至少出现在一片里', () => {
  const text = makeLong(40);
  const chunks = splitIntoChunks(text);
  const covered = new Array(text.length).fill(false);
  for (const c of chunks) {
    for (let i = c.start; i < c.end; i++) covered[i] = true;
  }
  const missing = covered.indexOf(false);
  assert.equal(missing, -1, `第 ${missing} 个字没有被任何片覆盖`);
});

test('相邻片有重叠：横跨边界的那句话两边都能看到', () => {
  const text = makeLong();
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length >= 2);
  for (let i = 1; i < chunks.length; i++) {
    const overlap = chunks[i - 1].end - chunks[i].start;
    assert.ok(overlap > 0, `第 ${i - 1} 片和第 ${i} 片没有重叠（overlap=${overlap}）`);
  }
});

test('每片长度接近目标值，但不超过太多', () => {
  const text = makeLong();
  const chunks = splitIntoChunks(text);
  for (const c of chunks) {
    assert.ok(
      c.text.length <= CHUNK_TARGET_CHARS * 2,
      `有一片 ${c.text.length} 字，远超目标 ${CHUNK_TARGET_CHARS}`,
    );
  }
});

test('start/end 与 text 对得上（能定位回原文）', () => {
  const text = makeLong(40);
  const chunks = splitIntoChunks(text);
  for (const c of chunks) {
    assert.equal(text.slice(c.start, c.end), c.text, '片内容和原文位置必须一致');
  }
});

test('没有标点的超长文本：硬切兜底，仍然覆盖全文', () => {
  const text = '啊'.repeat(3000); // 一个标点都没有
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length > 1, '没有标点也要切，否则后半段永远搜不到');
  const covered = new Array(text.length).fill(false);
  for (const c of chunks) for (let i = c.start; i < c.end; i++) covered[i] = true;
  assert.ok(covered.every(Boolean), '硬切也必须覆盖全文');
});

test('splitSentences 保留标点，位置准确', () => {
  const text = '第一句。第二句！第三句？';
  const s = splitSentences(text);
  assert.equal(s.length, 3);
  assert.equal(s[0].text, '第一句。');
  assert.equal(text.slice(s[1].start, s[1].end), s[1].text);
  assert.equal(s[2].text, '第三句？');
});

test('英文/代码文本也能切（换行也当边界）', () => {
  const text = ('line of code here\n').repeat(120);
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.text.trim().length > 0);
});

test('formatChunkWithContext：第 0 片保持原样，第 1+ 片仅带上所属章节 + 跨片表格表头', () => {
  const full = '已推送 ccf9c89。这次我们完成了全量二百四十道题的端到端回归测试以及跨样本性能基线校准工作，下面把详细分析流程、每组超参数配置以及各个子模块的关键耗时和通过率指标完整汇总如下，请逐一核对确认无误后归档：\n\n## 实验结果\n| 组别 | 通过率 | 耗时 |\n|---|---|---|\n| clean | 100% | 90s |\n| 3.3.0 | 8/12 | 120s |\n';
  const rowOffset = full.indexOf('| 3.3.0');
  assert.equal(formatChunkWithContext(full, '| 组别 | 通过率 | 耗时 |', 0), '| 组别 | 通过率 | 耗时 |');

  const second = formatChunkWithContext(full, '| 3.3.0 | 8/12 | 120s |', 1, rowOffset);
  assert.ok(!second.includes('[上下文:'), '不应拼首行上下文以免同一消息分片向量撞车');
  assert.ok(second.includes('[章节: ## 实验结果]'), '应继承所属章节标题');
  assert.ok(second.includes('| 组别 | 通过率 | 耗时 |'), '应继承活跃 Markdown 表格表头');
  assert.ok(second.endsWith('| 3.3.0 | 8/12 | 120s |'));
});
