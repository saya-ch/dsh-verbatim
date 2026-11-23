// export.test.js —— 导出算法的单元测试 + 真实会话集成测试
//
// 跑法：
//   node --test src/ingest/export.test.js
//
// 设计：合成事件流覆盖每条规则（不依赖真实文件，离线可跑）；
// 真实会话测试在文件不存在时自动跳过，不作假绿。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

import {
  findFrameStarts,
  decompressFrames,
  parseJsonLines,
  sortAndDedupeBySeq,
  readSessionFile,
  ZSTD_MAGIC,
} from './reader.js';

import {
  exportMessages,
  textBlocksOf,
  contentBlocksOf,
  isSystemInjected,
  isRewindEvent,
  rewindRangeOf,
  parseRewindFromCommandDone,
  estimateSceneCount,
  toJsonLines,
  SYSTEM_PREFIXES,
  parseInstant,
  normalizeExcludeRanges,
  matchExcludeRange,
  dayKeyInZone,
  cleanBridgeMetadata,
  stripBridgeMetadata,
  BRIDGE_TIME_HEAD_RE,
  BRIDGE_IMAGE_TOKEN,
  bridgeTimeHeadLength,
  isBridgeTimeHead,
} from './export.js';

// ─────────────────────────────────────────────────────────────
// 测试用构造器：按真实日志的字段形状造事件
// ─────────────────────────────────────────────────────────────

/** 造一条真人用户消息 */
function userMsg(seq, time, text, id) {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: id ?? `msg-${seq}`,
    },
    surfaceOp: 'append',
  };
}

/** 造一条 assistant 消息 */
function assistantMsg(seq, time, blocks) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { message: { role: 'assistant', content: blocks } },
    surfaceOp: 'append',
  };
}

/** 造一条 rewind 事件（按实测：区间在顶层 surfaceOp，data.source 只有 kind） */
function rewindMsg(seq, time, startSeq, endSeq) {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      content: [{ type: 'text', text: '(empty message)' }],
      source: { kind: 'dsh-rewind' },
      role: 'user',
    },
    sourceEventSeqs: [startSeq],
    surfaceOp: { op: 'replace', startSeq, endSeq },
  };
}

/** 造一条压缩汇总事件 */
function compactionSummary(seq, time, shadowedSeqs, range) {
  return {
    type: 'compaction/summary',
    seq,
    time,
    data: {
      compactionId: `c-${seq}`,
      shadowedSeqs,
      shadowedRange: range ?? { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) },
      shadowedTokenCount: 1,
    },
  };
}

/** 造一条系统注入消息 */
function injectedMsg(seq, time, kind, text) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }], source: { kind }, role: 'user' },
    surfaceOp: 'append',
  };
}

// ═════════════════════════════════════════════════════════════
// 一、reader.js
// ═════════════════════════════════════════════════════════════

test('reader：能扫描出 zstd 帧串联的所有帧起点', () => {
  // 造 3 个独立 zstd 帧首尾相接
  const payloads = [
    '{"type":"a","seq":1}\n',
    '{"type":"b","seq":2}\n{"type":"c","seq":3}\n',
    '{"type":"d","seq":4}\n',
  ];
  const frames = payloads.map((p) => zlib.zstdCompressSync(Buffer.from(p, 'utf8')));
  const buf = Buffer.concat(frames);

  const starts = findFrameStarts(buf);
  assert.equal(starts.length, 3, '应有 3 个帧起点');
  assert.equal(starts[0], 0);
  assert.ok(starts[1] > 0 && starts[2] > starts[1]);

  const { text, stats } = decompressFrames(buf);
  assert.equal(stats.frames, 3);
  assert.equal(stats.ok, 3);
  assert.equal(stats.failed, 0);
  // 两帧拼起来必须是完整内容（一次性解压只会拿到第一帧，这是关键）
  assert.match(text, /"seq":4/, '必须解出最后一帧，不能只解第一帧');

  const { events } = parseJsonLines(text);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
});

test('reader：假的 magic 命中不会让解压整段失败', () => {
  // 帧内部（或未压缩直出文本中）若出现 zstd magic 字节，合并尝试应能恢复并读出前后两帧
  const p1 = '{"type":"a","seq":1}\n';
  const fake = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]);
  const p2 = '{"type":"b","seq":2}\n';
  const buf = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(p1, 'utf8')),
    fake,
    zlib.zstdCompressSync(Buffer.from(p2, 'utf8')),
  ]);
  const { text, stats } = decompressFrames(buf);
  assert.ok(stats.ok >= 2, '前后两个合法帧都应成功解压');
  assert.match(text, /"seq":1/);
  assert.match(text, /"seq":2/);
});

test('reader：坏行跳过并计数，不抛错', () => {
  const { events, badLines } = parseJsonLines('{"a":1}\n不是json\n{"b":2}\n');
  assert.equal(events.length, 2);
  assert.equal(badLines, 1);
});

test('reader：重复 seq 只保留第一条，无 seq 的单独拿出来', () => {
  const { events, duplicates, noSeq } = sortAndDedupeBySeq([
    { seq: 2, v: 'b' },
    { seq: 1, v: 'a' },
    { seq: 2, v: 'b-dup' },
    { type: 'session', id: 'x' },
  ]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(events[1].v, 'b', '重复 seq 保留第一次出现的');
  assert.equal(duplicates, 1);
  assert.equal(noSeq.length, 1);
});

test('reader：能读明文 JSONL（非压缩）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-'));
  const f = path.join(dir, 'plain.jsonl');
  fs.writeFileSync(f, '{"type":"session","id":"s1"}\n{"type":"a","seq":1,"time":1,"data":{}}\n');
  const r = readSessionFile(f);
  assert.equal(r.stats.compressed, false);
  assert.equal(r.header.id, 's1');
  assert.equal(r.events.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════
// 二、取文本 / 过滤系统注入
// ═════════════════════════════════════════════════════════════

test('textBlocksOf：只取 text 块，排除 reasoning / tool-call / tool-result / image', () => {
  const ev = assistantMsg(1, 1000, [
    { type: 'reasoning', text: '这是思考过程，绝对不能入库' },
    { type: 'text', text: '这是要说的话。' },
    { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' },
    { type: 'tool-result', text: '这是工具结果，不能入库' },
    { type: 'image', data: 'base64...' },
    { type: 'text', text: '后半句。' },
  ]);
  const t = textBlocksOf(ev);
  assert.equal(t, '这是要说的话。后半句。');
  assert.ok(!t.includes('思考过程'));
  assert.ok(!t.includes('工具结果'));
  // 内容块位置两种都要认：data.message.content 与 data.content
  assert.equal(contentBlocksOf(ev).length, 6);
  assert.equal(contentBlocksOf({ data: { content: [{ type: 'text', text: 'x' }] } }).length, 1);
});

test('isSystemInjected：三类系统注入前缀全部识别（D-005）', () => {
  assert.equal(SYSTEM_PREFIXES.length, 3, '规格要求正好三条前缀');
  assert.ok(isSystemInjected('<system-reminder>\nxxx'));
  assert.ok(isSystemInjected('This is an automatically generated checkpoint condensing...'));
  assert.ok(isSystemInjected('Time sampled while preparing turn 1040, step 1: ...'));
  // 真人说的话不能误杀
  assert.equal(isSystemInjected('在吗～'), false);
  assert.equal(isSystemInjected('我怕你把我忘了'), false);
  assert.equal(isSystemInjected('【当前时间】2026/11/8 15:19:05'), false);
});

test('导出：source.kind ≠ user 的注入一律不收（比前缀规则可靠）', () => {
  const events = [
    userMsg(1, 1000, '示例短语'),
    // 这三类实测：前缀规则抓不到，只能靠 kind
    injectedMsg(2, 1100, 'tool-jobs', 'background job pwsh-xxx finished'),
    injectedMsg(3, 1200, 'runtime-context', 'Current runtime context. This snapshot supersedes...'),
    injectedMsg(4, 1300, 'model-selection', '[model changed: assistant turns above...]'),
    injectedMsg(5, 1400, 'plugin:dsh-random-wake', '[dsh-random-wake wake] Host-scheduled wake'),
    injectedMsg(6, 1500, 'time-context', 'Time sampled while preparing turn 3'),
    injectedMsg(7, 1600, 'agent-instructions', '<system-reminder>instructions'),
    injectedMsg(8, 1700, 'compact-checkpoint', 'This is an automatically generated checkpoint'),
    assistantMsg(9, 1800, [{ type: 'text', text: '怕黑就开着灯。' }]),
  ];
  const { messages, stats } = exportMessages(events);

  assert.equal(messages.length, 2, '只应剩下真实对话 2 条');
  assert.deepEqual(messages.map((m) => m.seq), [1, 9]);
  assert.equal(stats.skippedSystemByKind, 7);
  // 前缀兜底在 kind 判定之后才跑，所以这里是 0
  assert.equal(stats.userSourceKinds.user, 1);
});

test('导出：kind=user 但文本是系统注入时，前缀规则兜底拦下', () => {
  // 模拟未来版本把 kind 改成 user 的情况
  const events = [
    injectedMsg(1, 1000, 'user', '<system-reminder>\n偷渡进来的'),
    injectedMsg(2, 1100, 'user', 'Time sampled while preparing turn 2'),
    userMsg(3, 1200, '真的话'),
  ];
  const { messages, stats } = exportMessages(events);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '真的话');
  assert.equal(stats.skippedSystemByPrefix, 2);
});

test('导出：assistant 只有 reasoning/tool-call 没有 text 时跳过', () => {
  const events = [
    assistantMsg(1, 1000, [{ type: 'reasoning', text: '想' }, { type: 'tool-call', id: 'c', name: 'x' }]),
    assistantMsg(2, 1100, []),
    assistantMsg(3, 1200, [{ type: 'text', text: '有正文' }]),
  ];
  const { messages, stats } = exportMessages(events);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].seq, 3);
  assert.equal(stats.skippedNoTextBlock, 1);
  assert.equal(stats.skippedEmptyText, 1);
});

test('导出：空文本 / 纯空白跳过', () => {
  const events = [userMsg(1, 1000, '   \n  '), userMsg(2, 1100, '有话')];
  const { messages } = exportMessages(events);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].seq, 2);
});

// ═════════════════════════════════════════════════════════════
// 三、rewind（撤回 → 物理排除）
// ═════════════════════════════════════════════════════════════

test('rewindRangeOf：实测结构是顶层 surfaceOp，不是 data.source.targetSeq', () => {
  const ev = rewindMsg(5092, 1794313236211, 5027, 5088);
  const r = rewindRangeOf(ev);
  assert.deepEqual(r, { start: 5027, end: 5088, via: 'surfaceOp' });
  // source 里只有 kind，没有 targetSeq
  assert.deepEqual(ev.data.source, { kind: 'dsh-rewind' });
  assert.equal(ev.data.source.targetSeq, undefined);
  // 事件的 data 顶层也没有 shadowedFrom
  assert.equal(ev.data.shadowedFrom, undefined);
});

test('rewindRangeOf：兼容旧字段名兜底（本版本日志里不存在，但保留）', () => {
  const a = rewindRangeOf({ data: { source: { kind: 'dsh-rewind', targetSeq: 100 } } });
  assert.equal(a.start, 100);
  assert.equal(a.via, 'legacy-field');
  const b = rewindRangeOf({ data: { shadowedFrom: 200 } });
  assert.equal(b.start, 200);
  // 什么线索都没有就返回 null，不做无依据猜测
  assert.equal(rewindRangeOf({ data: { source: { kind: 'dsh-rewind' } } }), null);
});

test('parseRewindFromCommandDone：能从中文文案兜底解析', () => {
  const ev = {
    type: 'command/done',
    seq: 5093,
    data: { text: '已撤回 seq 5027 及之后内容（对话已回到此前）。', sourceEventSeq: 5092 },
  };
  assert.equal(parseRewindFromCommandDone(ev), 5027);
  assert.equal(parseRewindFromCommandDone({ type: 'command/done', data: { text: '无关的话' } }), null);
});

test('导出：rewind 把已收集的 seq >= X 全部删掉，一条不剩', () => {
  const events = [
    userMsg(10, 1000, 'A'),
    assistantMsg(11, 1100, [{ type: 'text', text: 'B' }]),
    userMsg(12, 1200, 'C'),
    assistantMsg(13, 1300, [{ type: 'text', text: 'D' }]),
    rewindMsg(14, 1400, 12, 13), // 撤回 12 及之后
    userMsg(15, 1500, 'E'),
    assistantMsg(16, 1600, [{ type: 'text', text: 'F' }]),
  ];
  const { messages, rewound, stats } = exportMessages(events, { includeRewound: true });

  assert.deepEqual(messages.map((m) => m.seq), [10, 11, 15, 16], '12/13 必须消失，15/16 保留');
  assert.equal(stats.rewindEvents, 1);
  assert.equal(stats.rewoundCount, 2);
  // rewind 标记本身不入库
  assert.ok(!messages.some((m) => m.seq === 14));
  // 被撤回的绝不能出现在 messages 里
  for (const r of rewound) {
    assert.ok(!messages.some((m) => m.seq === r.seq), `seq=${r.seq} 被撤回却还在库里`);
  }
});

test('导出：rewind 撤回全部已收集内容时，库里清空', () => {
  const events = [
    userMsg(1, 1000, 'A'),
    assistantMsg(2, 1100, [{ type: 'text', text: 'B' }]),
    rewindMsg(3, 1200, 1, 2),
  ];
  const { messages, stats } = exportMessages(events);
  assert.equal(messages.length, 0);
  assert.equal(stats.rewoundCount, 2);
});

test('导出：多次 rewind 叠加生效', () => {
  const events = [
    userMsg(1, 1000, 'A'),
    userMsg(2, 1100, 'B'),
    rewindMsg(3, 1200, 2, 2), // 撤 2
    userMsg(4, 1300, 'C'),
    rewindMsg(5, 1400, 4, 4), // 再撤 4
    userMsg(6, 1500, 'D'),
  ];
  const { messages } = exportMessages(events);
  assert.deepEqual(messages.map((m) => m.seq), [1, 6]);
});

// ═════════════════════════════════════════════════════════════
// 四、compaction（压缩 → 必须入库，标 in_surface=0，不是丢弃）
// ═════════════════════════════════════════════════════════════

test('导出：compaction 的内容必须入库（D-141，不是 D-120 的丢弃）', () => {
  const events = [
    userMsg(10, 1000, '这段话装不进上下文了，但必须记住'),
    assistantMsg(11, 1100, [{ type: 'text', text: '我也是。' }]),
    compactionSummary(12, 2000, [10, 11], { start: 10, end: 11 }),
    userMsg(13, 3000, '新的对话'),
  ];
  const { messages, stats } = exportMessages(events);

  assert.equal(messages.length, 3, '压缩掉的 2 条必须还在库里');
  const m10 = messages.find((m) => m.seq === 10);
  assert.equal(m10.text, '这段话装不进上下文了，但必须记住', '原文一字不改');
  assert.equal(m10.in_surface, 0, '必须标 in_surface=0');
  assert.equal(m10.compacted_at, 2000, 'compacted_at 是该次压缩的时间');

  const m13 = messages.find((m) => m.seq === 13);
  assert.equal(m13.in_surface, 1);
  assert.equal(m13.compacted_at, null);

  assert.equal(stats.compactionSummaries, 1);
  assert.equal(stats.inSurface0Count, 2);
});

test('导出：compacted_at 取**首次**被压缩的时间（多次覆盖不覆盖旧值）', () => {
  const events = [
    userMsg(1, 1000, 'A'),
    compactionSummary(2, 2000, [1]),
    compactionSummary(3, 5000, [1]), // 又被覆盖一次，但第一次掉出上下文是 2000
  ];
  const { messages } = exportMessages(events);
  assert.equal(messages[0].in_surface, 0);
  assert.equal(messages[0].compacted_at, 2000, '应保留首次压缩时间');
});

test('导出：失败的压缩（compaction/end 有 error）不影响标记', () => {
  const events = [
    userMsg(1, 1000, 'A'),
    { type: 'compaction/start', seq: 2, time: 1500, data: { compactionId: 'c-fail' } },
    { type: 'compaction/end', seq: 3, time: 1800, data: { compactionId: 'c-fail', error: 'end seq not found in surface' } },
    userMsg(4, 2000, 'B'),
  ];
  const { messages, stats } = exportMessages(events);
  assert.equal(stats.compactionStarts, 1);
  assert.equal(stats.compactionFailed, 1);
  assert.equal(stats.compactionSummaries, 0);
  assert.ok(messages.every((m) => m.in_surface === 1), '没有成功压缩，全部应在 surface 内');
});

test('导出：shadowedSeqs 里的非消息 seq 不影响消息计数', () => {
  const events = [
    userMsg(1, 1000, 'A'),
    { type: 'step/start', seq: 2, time: 1100, data: {} }, // 非消息事件也在 shadowed 里
    compactionSummary(3, 2000, [1, 2]),
  ];
  const { messages, stats } = exportMessages(events);
  assert.equal(messages.length, 1);
  assert.equal(stats.shadowedSeqTotal, 2, 'shadowedSeqs 计数含非消息事件');
  assert.equal(stats.inSurface0Count, 1, '但标 in_surface=0 的只有消息');
});

test('导出：in_surface=0 的字数占比计算正确', () => {
  const events = [
    userMsg(1, 1000, '1234567890'), // 10 字，会被压缩
    userMsg(2, 1100, '12345'), // 5 字，留在 surface
    compactionSummary(3, 2000, [1]),
  ];
  const { stats } = exportMessages(events);
  assert.equal(stats.totalChars, 15);
  assert.equal(stats.inSurface0Chars, 10);
  assert.equal(stats.inSurface1Chars, 5);
  assert.equal(Math.round(stats.inSurface0CharRatio * 100), 67);
});

// ═════════════════════════════════════════════════════════════
// 五、输出形状（T1 入库契约）
// ═════════════════════════════════════════════════════════════

test('输出：每条消息字段齐全且类型正确（T1 直接照着插）', () => {
  const events = [
    userMsg(1, 1794122345928, '你好'),
    assistantMsg(2, 1794122349072, [{ type: 'text', text: '在的。' }]),
    compactionSummary(3, 1794123000000, [1, 2]),
    rewindMsg(4, 1794124000000, 3, 3),
  ];
  const { messages } = exportMessages(events, { sessionId: 'sess-1' });

  for (const m of messages) {
    assert.equal(typeof m.session_id, 'string');
    assert.equal(m.session_id, 'sess-1');
    assert.equal(typeof m.seq, 'number');
    assert.equal(typeof m.at, 'number');
    assert.ok(m.speaker === 'user' || m.speaker === 'assistant');
    assert.equal(typeof m.text, 'string');
    assert.ok(m.in_surface === 0 || m.in_surface === 1);
    assert.ok(m.compacted_at === null || typeof m.compacted_at === 'number');
    assert.ok(m.excluded === 0 || m.excluded === 1, 'excluded 必须是 0/1');
    // in_surface=0 必须同时有 compacted_at（DDL 语义）
    if (m.in_surface === 0) assert.equal(typeof m.compacted_at, 'number');
    else assert.equal(m.compacted_at, null);
  }
  // seq 严格升序唯一
  for (let i = 1; i < messages.length; i++) assert.ok(messages[i].seq > messages[i - 1].seq);
});

test('输出：toJsonLines 一行一条，可被 JSON.parse 还原', () => {
  const events = [userMsg(1, 1000, '带"引号"\n和换行')];
  const { messages } = exportMessages(events, { sessionId: 's' });
  const text = toJsonLines(messages);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1, '换行必须被转义，不能多出物理行');
  assert.deepEqual(JSON.parse(lines[0]), messages[0]);
});

test('estimateSceneCount：30 分钟断点', () => {
  const M = 60_000;
  const msgs = [{ at: 0 }, { at: 10 * M }, { at: 20 * M }, { at: 51 * M }, { at: 55 * M }];
  assert.equal(estimateSceneCount(msgs).scenes, 2);
  assert.equal(estimateSceneCount([]).scenes, 0);
});

// ═════════════════════════════════════════════════════════════
// 六、inbox 孤儿：投递了但 turn 被 blocked，从没发生过的真人发言
// ═════════════════════════════════════════════════════════════

test('导出：投递后 turn blocked、没成 user/message 的消息不入库，且单独计数', () => {
  const orphanId = 'orphan-1';
  const events = [
    // 一条投递进收件箱的真人消息，但后续 turn 直接 blocked，没有 user/message
    {
      type: 'agent/inbox/spliced',
      seq: 1,
      time: 1000,
      data: {
        target: 'next-step',
        start: 0,
        inserted: [{
          content: [{ type: 'text', text: '回复两个字：在的' }],
          source: { kind: 'user' },
          role: 'user',
          id: orphanId,
        }],
      },
    },
    { type: 'turn/start', seq: 2, time: 1001, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 3, time: 1002, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } },
    { type: 'turn/end', seq: 4, time: 1003, data: { turn: 1, reason: { kind: 'blocked' } } },
    // 正常的一条：投递 → 成了 user/message
    {
      type: 'agent/inbox/spliced',
      seq: 5,
      time: 2000,
      data: {
        target: 'next-step',
        start: 0,
        inserted: [{
          content: [{ type: 'text', text: '真的话' }],
          source: { kind: 'user' },
          role: 'user',
          id: 'real-1',
        }],
      },
    },
    userMsg(6, 2001, '真的话', 'real-1'),
    assistantMsg(7, 2100, [{ type: 'text', text: '嗯。' }]),
  ];

  const { messages, stats } = exportMessages(events);

  assert.deepEqual(messages.map((m) => m.seq), [6, 7], '孤儿消息不该入库');
  assert.equal(stats.inboxInsertedUserIds, 2, '两次投递都记到了');
  assert.equal(stats.inboxOrphans, 1, '只有 1 条没变成消息');
  assert.equal(stats.inboxOrphans > 0, true);
  assert.equal(stats.inboxOrphanSamples[0].text, '回复两个字：在的');
});

test('导出：inbox 里的注入消息不算孤儿（本来就不收）', () => {
  const events = [{
    type: 'agent/inbox/spliced',
    seq: 1,
    time: 1000,
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{
        content: [{ type: 'text', text: '[dsh-random-wake wake] Host-scheduled wake' }],
        source: { kind: 'plugin:dsh-random-wake' },
        role: 'user',
        id: 'wake-1',
      }],
    },
  }];
  const { messages, stats } = exportMessages(events);
  assert.equal(messages.length, 0);
  assert.equal(stats.inboxInsertedUserIds, 0, '注入不算真人投递');
  assert.equal(stats.inboxOrphans, 0);
});

// ═════════════════════════════════════════════════════════════
// 七、按日期软排除（D-169 / D-170）
// ═════════════════════════════════════════════════════════════

test('parseInstant：纯日期按 +08:00 解释，不是 UTC（JS 默认会差 8 小时）', () => {
  // 这是最容易错的坑：Date.parse('2026-11-08') 在 JS 里按 UTC 算
  assert.notEqual(Date.parse('2026-11-08'), Date.parse('2026-11-08T00:00:00+08:00'));
  // 我们的函数必须给出 +08:00 那个值
  assert.equal(parseInstant('2026-11-08'), Date.parse('2026-11-08T00:00:00+08:00'));
  assert.equal(parseInstant('2026-11-08'), 1794067200000);
  // 带时区的串按自带时区
  assert.equal(parseInstant('2026-11-08T00:00:00+08:00'), 1794067200000);
  assert.equal(parseInstant('2026-11-07T16:00:00Z'), 1794067200000, '等价 UTC 表示应得到同一时刻');
  // 不带时区的日期时间：按 +08:00 解释（不跟机器时区走）
  assert.equal(parseInstant('2026-11-08T12:00:00'), parseInstant('2026-11-08T12:00:00+08:00'));
  // number / Date 直通
  assert.equal(parseInstant(1794067200000), 1794067200000);
  assert.equal(parseInstant(new Date(1794067200000)), 1794067200000);
  // 垃圾输入返回 null，不抛
  assert.equal(parseInstant('不是时间'), null);
  assert.equal(parseInstant(null), null);
  assert.equal(parseInstant(NaN), null);
});

test('dayKeyInZone：按 Asia/Shanghai 切日，与运行环境时区无关', () => {
  // 11-08 23:59:59.999 +08:00
  const endOfDay8 = Date.parse('2026-11-08T23:59:59.999+08:00');
  assert.equal(dayKeyInZone(endOfDay8), '2026-11-08');
  // 11-09 00:00:00.000 +08:00
  const startOfDay9 = Date.parse('2026-11-09T00:00:00+08:00');
  assert.equal(dayKeyInZone(startOfDay9), '2026-11-09');
  // 同一时刻用 UTC 表示，日 key 仍是上海日（这是关键：不能跟着 UTC 走）
  assert.equal(dayKeyInZone(Date.parse('2026-11-08T16:00:01Z')), '2026-11-09');
});

test('normalizeExcludeRanges：校验、排序、丢掉非法区间并告警', () => {
  const warns = [];
  const got = normalizeExcludeRanges([
    { from: '2026-11-10T00:00:00+08:00', to: '2026-11-11T00:00:00+08:00', reason: '乙' },
    { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '甲' },
    { from: '2026-11-09T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00' }, // 空区间
    { from: '2026-11-09T00:00:00+08:00', to: '2026-11-08T00:00:00+08:00' }, // 反了
    { from: '乱写', to: '2026-11-01T00:00:00+08:00' }, // 解析不了
    null,
  ], { onWarn: (m) => warns.push(m) });

  assert.equal(got.length, 2, '只应保留 2 个合法区间');
  // 已按起点排序
  assert.equal(got[0].reason, '甲');
  assert.equal(got[1].reason, '乙');
  assert.ok(got[0].from < got[1].from);
  assert.equal(warns.length, 4, '4 个非法项各告警一次');
  // 非数组不炸
  assert.deepEqual(normalizeExcludeRanges(undefined), []);
  assert.deepEqual(normalizeExcludeRanges('x'), []);
});

test('matchExcludeRange：左闭右开边界（11-08 23:59:59.999 排除，11-09 00:00:00 不排除）', () => {
  const ranges = normalizeExcludeRanges([
    { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '调试期' },
  ]);
  assert.equal(ranges.length, 1);

  // 左边界：含
  assert.ok(matchExcludeRange(Date.parse('2026-11-08T00:00:00+08:00'), ranges), '起点含');
  // 右边界：不含
  assert.equal(matchExcludeRange(Date.parse('2026-11-09T00:00:00+08:00'), ranges), null, '终点不含');
  // 紧邻右边界前 1 毫秒：含
  assert.ok(matchExcludeRange(Date.parse('2026-11-08T23:59:59.999+08:00'), ranges), '终点前 1ms 应含');
  // 区间外
  assert.equal(matchExcludeRange(Date.parse('2026-11-07T23:59:59.999+08:00'), ranges), null);
  assert.equal(matchExcludeRange(Date.parse('2026-11-10T00:00:00+08:00'), ranges), null);
});

test('导出：软排除只打 excluded=1，消息仍然出现在输出里（不丢弃）', () => {
  const day8 = Date.parse('2026-11-08T15:00:00+08:00');
  const day9 = Date.parse('2026-11-09T15:00:00+08:00');
  const events = [
    userMsg(1, day8, '调试试探'),
    assistantMsg(2, day8 + 1000, [{ type: 'text', text: '调试回应' }]),
    userMsg(3, day9, '正式的话'),
  ];

  const plain = exportMessages(events, { sessionId: 's' });
  const limited = exportMessages(events, {
    sessionId: 's',
    excludeRanges: [{ from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '调试期' }],
  });

  // 核心：条数一条不少（软排除不是过滤）
  assert.equal(limited.messages.length, 3, '软排除不能丢消息');
  assert.equal(limited.messages.length, plain.messages.length, '与不排除时条数必须一致');
  assert.deepEqual(limited.messages.map((m) => m.seq), [1, 2, 3]);

  // 标记正确
  assert.equal(limited.messages[0].excluded, 1);
  assert.equal(limited.messages[1].excluded, 1);
  assert.equal(limited.messages[2].excluded, 0);

  // 不传区间时全部 excluded=0
  assert.ok(plain.messages.every((m) => m.excluded === 0));

  // 统计
  const s = limited.stats;
  assert.equal(s.excludedCount, 2);
  assert.equal(s.excludedChars, '调试试探'.length + '调试回应'.length);
  assert.equal(s.totalMessages, 3, '总条数不受影响');
  assert.equal(s.searchableCount, 1);
  assert.equal(s.searchableChars, '正式的话'.length);
  assert.equal(s.excludedHits.length, 1);
  assert.equal(s.excludedHits[0].reason, '调试期');

  // 原文没被改动
  assert.equal(limited.messages[0].text, '调试试探');
});

test('导出：excluded 与 in_surface 正交，可同时为标记', () => {
  const day8 = Date.parse('2026-11-08T15:00:00+08:00');
  const events = [
    userMsg(1, day8, '既被压缩又被排除'),
    compactionSummary(2, day8 + 10_000, [1]),
  ];
  const { messages } = exportMessages(events, {
    sessionId: 's',
    excludeRanges: [{ from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00' }],
  });
  const m = messages[0];
  assert.equal(m.in_surface, 0, '被压缩');
  assert.equal(m.excluded, 1, '又被日期排除');
  // 两个标记互不影响
  assert.equal(typeof m.compacted_at, 'number');
});

test('导出：多区间分别统计，重叠时只归第一个', () => {
  const base = Date.parse('2026-11-08T00:00:00+08:00');
  const H = 3600_000;
  const events = [
    userMsg(1, base + 1 * H, 'A'),   // 落在区间 1
    userMsg(2, base + 5 * H, 'BB'),  // 区间 1、2 重叠处
    userMsg(3, base + 30 * H, 'CCC'), // 区间 2 独有
    userMsg(4, base + 100 * H, 'DDDD'), // 都不在
  ];
  const { messages, stats } = exportMessages(events, {
    sessionId: 's',
    excludeRanges: [
      { from: '2026-11-08T00:00:00+08:00', to: '2026-11-09T00:00:00+08:00', reason: '甲' },
      { from: '2026-11-08T04:00:00+08:00', to: '2026-11-10T00:00:00+08:00', reason: '乙' },
    ],
  });
  assert.deepEqual(messages.map((m) => m.excluded), [1, 1, 1, 0]);
  assert.equal(stats.excludedCount, 3);
  // 重叠的消息只算进先命中的区间（按起点排序后是「甲」）
  const total = stats.excludedHits.reduce((a, h) => a + h.count, 0);
  assert.equal(total, 3, '分区间计数之和必须等于总数，不能重复计数');
});

// ═════════════════════════════════════════════════════════════
// 九、桥接元数据清洗（P1）
// ═════════════════════════════════════════════════════════════
//
// 桥接层把每条用户消息套了一层日志头：
//   【当前时间】2026/1/5 15:19:05（Asia/Shanghai）\n\n【管理员】<正文>
// 时间已在 at、发送者已在 speaker，正文里的是纯噪声。

test('cleanBridgeMetadata：剥掉时间戳头 + 发送者标记，正文一字不改', () => {
  const raw = '【当前时间】2026/1/5 15:19:05（Asia/Shanghai）\n\n【管理员】示例正文内容';
  const r = cleanBridgeMetadata(raw);
  assert.equal(r.text, '示例正文内容');
  assert.ok(r.timePrefixChars > 0);
  assert.equal(r.adminMarks, 1);
  assert.equal(r.hasImagePlaceholder, false);
});

test('cleanBridgeMetadata：幂等 —— 清洗过的再洗一次不变', () => {
  const cases = [
    '【当前时间】2026/1/5 15:19:05（Asia/Shanghai）\n\n【管理员】示例短语',
    '【当前时间】2026/11/8 15:59:20（Asia/Shanghai）\n\n【管理员】[图片]\n【图片/表情】本条消息包含 1 个图片/表情（消息ID=-1555151081）。[图片1]（获取失败）',
    '[图片]（动图 60 帧/2.8s，已抽 6 帧拼成 3×2 网格，行优先 左上→右下；原图 2.8MB）',
    '[图片]（原图 1448×1086 1623KB → 1280×960 68KB）',
    '普通的一句话，没有任何元数据',
    '【重要】别忘了带钥匙',
    '[引用 1000000000：[图片]]示例',
  ];
  for (const raw of cases) {
    const once = cleanBridgeMetadata(raw).text;
    const twice = cleanBridgeMetadata(once).text;
    assert.equal(twice, once, `不幂等: ${JSON.stringify(raw)} → ${JSON.stringify(once)} → ${JSON.stringify(twice)}`);
    // 三遍也不变（防累积漂移）
    assert.equal(cleanBridgeMetadata(twice).text, once, `第三遍变了: ${JSON.stringify(raw)}`);
  }
});

test('cleanBridgeMetadata：不误伤 —— 用户自己发的【开头正文原样保留', () => {
  // 只有【当前时间】四个字、后面跟不出合法时间的，不是元数据
  assert.equal(stripBridgeMetadata('【当前时间】你猜现在几点'), '【当前时间】你猜现在几点');
  // 别的【】标记一概不动
  assert.equal(stripBridgeMetadata('【重要】别忘了带钥匙'), '【重要】别忘了带钥匙');
  assert.equal(stripBridgeMetadata('【管理员】这是我学着打的话'), '【管理员】这是我学着打的话');
  // 正文中间出现【管理员】也不动（实测 assistant 复述用户原话就是这种）
  const mid = '嗯。\n\nuser【当前时间】2026/1/9 15:53:11（Asia/Shanghai）\n\n【管理员】示例复述内容';
  assert.equal(stripBridgeMetadata(mid), mid, '不在开头的桥接头不该被动');
  // 时间格式不对的保留（防止误剥正文）
  assert.equal(stripBridgeMetadata('【当前时间】2026/13/45 99:99:99（Mars/Zone）x'), '【当前时间】2026/13/45 99:99:99（Mars/Zone）x');
  // 数值越界一律不认：形状对但不是时间
  assert.equal(isBridgeTimeHead('【当前时间】2026/13/01 00:00:00（Asia/Shanghai）'), false, '13 月不合法');
  assert.equal(isBridgeTimeHead('【当前时间】2026/11/32 00:00:00（Asia/Shanghai）'), false, '32 日不合法');
  assert.equal(isBridgeTimeHead('【当前时间】2026/11/08 24:00:00（Asia/Shanghai）'), false, '24 时不合法');
  assert.equal(isBridgeTimeHead('【当前时间】2026/11/08 00:60:00（Asia/Shanghai）'), false, '60 分不合法');
  assert.equal(isBridgeTimeHead('【当前时间】2026/11/08 00:00:60（Asia/Shanghai）'), false, '60 秒不合法');
  // 合法边界
  assert.ok(bridgeTimeHeadLength('【当前时间】2026/1/1 0:00:00（UTC）') > 0, '最小合法');
  assert.ok(bridgeTimeHeadLength('【当前时间】2026/12/31 23:59:59（Asia/Shanghai）') > 0, '最大合法');
  assert.equal(isBridgeTimeHead('【当前时间】2026-11-08 15:19:05（Asia/Shanghai）'), true, '横线日期也要认');
  // 空 / 非字符串不炸
  assert.equal(stripBridgeMetadata(''), '');
  assert.equal(stripBridgeMetadata(null), '');
  assert.equal(stripBridgeMetadata(undefined), '');
});

test('cleanBridgeMetadata：图片占位保留，描述去掉（不丢「这里有张图」）', () => {
  // 消息ID 那种长描述
  const a = '【当前时间】2026/11/8 15:59:20（Asia/Shanghai）\n\n【管理员】[图片]\n【图片/表情】本条消息包含 1 个图片/表情（消息ID=-1555151081）。[图片1]（获取失败）';
  assert.equal(cleanBridgeMetadata(a).text, BRIDGE_IMAGE_TOKEN);
  // 动图参数
  assert.equal(
    cleanBridgeMetadata('[图片]（动图 60 帧/2.8s，已抽 6 帧拼成 3×2 网格，行优先 左上→右下；原图 2.8MB）').text,
    BRIDGE_IMAGE_TOKEN,
  );
  // 原图尺寸
  assert.equal(cleanBridgeMetadata('[图片]（原图 1448×1086 1623KB → 1280×960 68KB）').text, BRIDGE_IMAGE_TOKEN);
  // 只有 [图片1] 没有 [图片] 时，要归一成 [图片] 而不是删掉
  assert.equal(cleanBridgeMetadata('【图片/表情】本条消息包含 1 个图片/表情（消息ID=123）。[图片1]（获取失败）').text, BRIDGE_IMAGE_TOKEN);
  // 图片 + 正文：占位留着，正文也在
  const withText = '【当前时间】2026/11/8 15:59:20（Asia/Shanghai）\n\n【管理员】[图片]\n【图片/表情】本条消息包含 1 个图片/表情（消息ID=1）。[图片1]（获取失败）\n这是我拍的';
  const r = cleanBridgeMetadata(withText);
  assert.ok(r.text.includes(BRIDGE_IMAGE_TOKEN), '图片占位必须保留');
  assert.ok(r.text.includes('这是我拍的'), '正文必须保留');
  assert.ok(!r.text.includes('消息ID'), '消息ID 描述该去掉');
  assert.equal(r.hasImagePlaceholder, true);
});

test('cleanBridgeMetadata：引用标记不动（它是有意义的信息）', () => {
  const raw = '[引用 1000000000：[图片]]示例图片';
  assert.equal(stripBridgeMetadata(raw), raw);
});

test('导出：清洗只改 text，at / speaker / seq / in_surface 全不受影响', () => {
  const at = Date.parse('2026-11-08T15:19:05+08:00');
  const events = [
    userMsg(1, at, '【当前时间】2026/1/5 15:19:05（Asia/Shanghai）\n\n【管理员】示例短语'),
    assistantMsg(2, at + 1000, [{ type: 'text', text: '怕黑就开着灯。' }]),
    compactionSummary(3, at + 2000, [1, 2]),
  ];

  const on = exportMessages(events, { sessionId: 's', cleanMetadata: true });
  const off = exportMessages(events, { sessionId: 's', cleanMetadata: false });

  assert.equal(on.messages.length, off.messages.length);
  for (let i = 0; i < on.messages.length; i++) {
    assert.equal(on.messages[i].seq, off.messages[i].seq);
    assert.equal(on.messages[i].at, off.messages[i].at);
    assert.equal(on.messages[i].speaker, off.messages[i].speaker);
    assert.equal(on.messages[i].in_surface, off.messages[i].in_surface);
    assert.equal(on.messages[i].compacted_at, off.messages[i].compacted_at);
  }
  // 只有 text 变了
  assert.equal(on.messages[0].text, '示例短语');
  assert.equal(off.messages[0].text.startsWith('【当前时间】'), true);
  // 清洗统计
  assert.equal(on.stats.bridgeTimePrefixCount, 1);
  assert.equal(on.stats.bridgeAdminMarks, 1);
  assert.equal(on.stats.cleanedCharRatio > 0, true);
  // 关闭时统计为 0，且标记 cleanMetadata=false
  assert.equal(off.stats.metadataCleaned, false);
  assert.equal(off.stats.bridgeTimePrefixCount, 0);
});

test('导出：清洗统计只算最终入库的消息（被 rewind 的不进分母）', () => {
  const at = Date.parse('2026-11-08T15:19:05+08:00');
  const head = '【当前时间】2026/1/5 15:19:05（Asia/Shanghai）\n\n【管理员】';
  const events = [
    userMsg(1, at, `${head}活下来的话`),
    userMsg(2, at + 1000, `${head}会被撤回的话`),
    rewindMsg(3, at + 2000, 2, 2),
  ];
  const { messages, stats } = exportMessages(events, { sessionId: 's' });

  assert.equal(messages.length, 1);
  assert.equal(stats.bridgeTimePrefixCount, 1, '被撤回的那条不该计入清洗条数');
  // 分母只含最终入库的消息
  assert.equal(stats.charsBeforeClean, `${head}活下来的话`.length);
  assert.equal(stats.charsAfterClean, '活下来的话'.length);
});

// ═════════════════════════════════════════════════════════════
// 十、真实会话集成测试
// ═════════════════════════════════════════════════════════════

// 真实会话文件不写死在仓库里（脱敏）。要跑这组集成测试，把自己会话的路径
// 通过 VERBATIM_TEST_SESSION 传进来即可；没设就 skip，不影响开源用户的测试结果。
const REAL_SESSION = process.env.VERBATIM_TEST_SESSION ?? '';

const hasReal = fs.existsSync(REAL_SESSION);

test('真实会话：导出成功且统计自洽', { skip: hasReal ? false : `找不到真实会话文件: ${REAL_SESSION}` }, () => {
  const { header, events, stats: rs } = readSessionFile(REAL_SESSION);

  assert.equal(header?.type, 'session');
  assert.ok(rs.eventCount > 30_000, `事件数应 > 3 万，实际 ${rs.eventCount}`);
  assert.equal(rs.framesFailed, 0, '所有 zstd 帧都必须解压成功');
  assert.ok(rs.frames > 1000, `帧数应 > 1000，实际 ${rs.frames}`);

  const { messages, stats } = exportMessages(events, { sessionId: header.id });

  // 基础自洽
  assert.ok(messages.length > 3000, `消息数应 > 3000，实际 ${messages.length}`);
  assert.equal(stats.totalChars, messages.reduce((a, m) => a + m.text.length, 0));
  assert.equal(stats.inSurface0Count + stats.inSurface1Count, messages.length);
  assert.equal(stats.inSurface0Chars + stats.inSurface1Chars, stats.totalChars);

  // 每条都不是系统注入
  for (const m of messages) {
    assert.equal(isSystemInjected(m.text), false, `seq=${m.seq} 是系统注入，不应入库`);
  }

  // 每条都有正文、speaker 合法、seq 升序唯一
  for (const m of messages) {
    assert.ok(m.text.trim().length > 0, `seq=${m.seq} 空文本`);
    assert.ok(m.speaker === 'user' || m.speaker === 'assistant');
  }
  for (let i = 1; i < messages.length; i++) {
    assert.ok(messages[i].seq > messages[i - 1].seq, 'seq 必须严格升序');
  }

  // 压缩必须入库（这是整批的核心）
  assert.ok(stats.compactionSummaries >= 1, '真实会话里应有成功的压缩');
  assert.ok(stats.inSurface0Count > 0, 'in_surface=0 必须存在（D-141）');
  assert.ok(stats.inSurface0CharRatio > 0.5, `in_surface=0 字数占比应过半，实际 ${(stats.inSurface0CharRatio * 100).toFixed(1)}%`);

  // rewind 必须全部排除
  assert.ok(stats.rewindEvents > 0, '真实会话里有 rewind');
  assert.ok(stats.rewoundCount > 0);

  console.log(`\n  [真实会话] 事件 ${rs.eventCount} / 帧 ${rs.frames}`);
  console.log(`  [真实会话] 入库 ${messages.length} 条 / ${stats.totalChars} 字`);
  console.log(`  [真实会话] in_surface=0 ${stats.inSurface0Count} 条 / ${stats.inSurface0Chars} 字 = ${(stats.inSurface0CharRatio * 100).toFixed(2)}%`);
  console.log(`  [真实会话] rewind ${stats.rewindEvents} 次，排除 ${stats.rewoundCount} 条 / ${stats.rewoundChars} 字`);
  console.log(`  [真实会话] 压缩 ${stats.compactionSummaries} 次成功 / ${stats.compactionFailed} 次失败，shadowedSeqs ${stats.shadowedSeqTotal}`);
});

test('真实会话：被 rewind 的内容一条都查不到（D-017 验收第 4 条）', { skip: hasReal ? false : '无真实会话' }, () => {
  const { header, events } = readSessionFile(REAL_SESSION);
  const { messages, rewound } = exportMessages(events, { sessionId: header.id, includeRewound: true });

  assert.ok(rewound.length > 0, '应有被撤回的条目');
  const live = new Set(messages.map((m) => m.seq));
  for (const r of rewound) {
    assert.equal(live.has(r.seq), false, `seq=${r.seq} 被撤回却还在 messages 里`);
  }
  // 反向确认：messages 里不应有任何 dsh-rewind 标记事件
  const rewindSeqs = new Set(events.filter(isRewindEvent).map((e) => e.seq));
  for (const m of messages) assert.equal(rewindSeqs.has(m.seq), false, 'rewind 标记本身入了库');
});

test('真实会话：每次 rewind 的 surfaceOp 与 command/done 文案一致', { skip: hasReal ? false : '无真实会话' }, () => {
  const { events } = readSessionFile(REAL_SESSION);
  const rewinds = events.filter(isRewindEvent);
  const dones = events.filter((e) => e.type === 'command/done' && typeof e.data?.text === 'string');

  let checked = 0;
  for (const d of dones) {
    const t = parseRewindFromCommandDone(d);
    if (t === null) continue;
    const src = rewinds.find((r) => r.seq === d.data.sourceEventSeq);
    if (!src) continue;
    const r = rewindRangeOf(src);
    assert.equal(r.start, t, `seq=${d.seq} 的文案 target 与 surfaceOp.startSeq 不一致`);
    checked++;
  }
  assert.ok(checked > 100, `应交叉验证 > 100 次，实际 ${checked}`);
});

test('真实会话：in_surface 标记与原始 shadowedSeqs 逐条吻合', { skip: hasReal ? false : '无真实会话' }, () => {
  const { header, events } = readSessionFile(REAL_SESSION);
  const { messages } = exportMessages(events, { sessionId: header.id });

  const firstTime = new Map();
  for (const s of events.filter((e) => e.type === 'compaction/summary').sort((a, b) => a.seq - b.seq)) {
    for (const q of s.data?.shadowedSeqs ?? []) if (!firstTime.has(q)) firstTime.set(q, s.time);
  }

  let bad = 0;
  for (const m of messages) {
    const expect = firstTime.has(m.seq) ? 0 : 1;
    const expectAt = firstTime.has(m.seq) ? firstTime.get(m.seq) : null;
    if (m.in_surface !== expect || m.compacted_at !== expectAt) bad++;
  }
  assert.equal(bad, 0, `${bad} 条的 in_surface/compacted_at 与原始 shadowedSeqs 不符`);
});

test('真实会话：关闭清洗时原文一字不改（D-017 验收第 6 条，抽样 20 条）', { skip: hasReal ? false : '无真实会话' }, () => {
  const { header, events } = readSessionFile(REAL_SESSION);
  const { messages } = exportMessages(events, { sessionId: header.id, cleanMetadata: false });

  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const step = Math.max(1, Math.floor(messages.length / 20));
  let checked = 0;
  for (let i = 0; i < messages.length && checked < 20; i += step) {
    const m = messages[i];
    const ev = bySeq.get(m.seq);
    assert.ok(ev, `seq=${m.seq} 找不到原始事件`);
    assert.equal(m.text, textBlocksOf(ev), `seq=${m.seq} 原文被改动`);
    checked++;
  }
  assert.equal(checked, 20);
});

test('真实会话：开启清洗时只去掉桥接头，正文逐字保留（抽样 20 条）', { skip: hasReal ? false : '无真实会话' }, () => {
  const { header, events } = readSessionFile(REAL_SESSION);
  const { messages } = exportMessages(events, { sessionId: header.id });

  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const step = Math.max(1, Math.floor(messages.length / 20));
  let checked = 0;
  for (let i = 0; i < messages.length && checked < 20; i += step) {
    const m = messages[i];
    const ev = bySeq.get(m.seq);
    const raw = textBlocksOf(ev);
    // 清洗后的文本必须正好等于「原始文本走一遍清洗函数」的结果，
    // 也就是说除了已知元数据，正文没有任何字符被改动
    assert.equal(m.text, stripBridgeMetadata(raw), `seq=${m.seq} 清洗结果与函数不一致`);
    // 不含图片的消息：清洗只是剥前缀，所以清洗后必须是原文的**后缀**
    if (!raw.includes('[图片]') && !raw.includes('【图片/表情】')) {
      assert.ok(raw.endsWith(m.text), `seq=${m.seq} 正文不是原文的后缀，说明动了正文`);
    }
    checked++;
  }
  assert.equal(checked, 20);
});

test('真实会话：桥接元数据清洗命中 858 条（验收口径）', { skip: hasReal ? false : '无真实会话' }, () => {
  const { header, events } = readSessionFile(REAL_SESSION);
  const { messages, stats } = exportMessages(events, { sessionId: header.id });

  assert.equal(stats.metadataCleaned, true);
  // 与 lead 独立核算的口径一致
  assert.equal(stats.bridgeTimePrefixCount, 858, `剥时间戳头应为 858 条，实际 ${stats.bridgeTimePrefixCount}`);
  assert.equal(stats.bridgeAdminMarks, 858, `剥发送者标记应为 858 处，实际 ${stats.bridgeAdminMarks}`);
  assert.ok(stats.bridgeTimePrefixChars > 30000, `剥掉的时间头字数应 > 3 万，实际 ${stats.bridgeTimePrefixChars}`);
  assert.ok(stats.bridgeImagePlaceholders > 50, `图片占位应保留 > 50 条，实际 ${stats.bridgeImagePlaceholders}`);

  // 清洗后没有任何消息还带着桥接头
  for (const m of messages) {
    assert.equal(isBridgeTimeHead(m.text), false, `seq=${m.seq} 残留时间戳头`);
    assert.equal(m.text.startsWith('【管理员】'), false, `seq=${m.seq} 残留发送者标记`);
  }

  // 清洗确实让字数大幅下降，但没清空
  assert.ok(stats.cleanedCharRatio > 0.3, `清洗降幅应 > 30%，实际 ${(stats.cleanedCharRatio * 100).toFixed(1)}%`);
  assert.ok(stats.totalChars > 30000, `清洗后总字数应 > 3 万，实际 ${stats.totalChars}`);

  console.log(`\n  [清洗] 剥时间戳头 ${stats.bridgeTimePrefixCount} 条 / ${stats.bridgeTimePrefixChars} 字`);
  console.log(`  [清洗] 剥发送者标记 ${stats.bridgeAdminMarks} 处`);
  console.log(`  [清洗] 图片占位保留 ${stats.bridgeImagePlaceholders} 条（描述去掉 ${stats.bridgeImageDescChars} 字）`);
  console.log(`  [清洗] 总字数 ${stats.totalCharsBeforeClean} → ${stats.totalChars}（降 ${(stats.cleanedCharRatio * 100).toFixed(2)}%）`);
});

test('真实会话：清洗不影响 at / speaker / seq / in_surface', { skip: hasReal ? false : '无真实会话' }, () => {
  const { header, events } = readSessionFile(REAL_SESSION);
  const cleaned = exportMessages(events, { sessionId: header.id, cleanMetadata: true });
  const raw = exportMessages(events, { sessionId: header.id, cleanMetadata: false });

  assert.equal(cleaned.messages.length, raw.messages.length, '清洗不能改变消息条数');
  for (let i = 0; i < cleaned.messages.length; i++) {
    const a = cleaned.messages[i];
    const b = raw.messages[i];
    assert.equal(a.seq, b.seq, 'seq 不能变');
    assert.equal(a.at, b.at, 'at 不能变');
    assert.equal(a.speaker, b.speaker, 'speaker 不能变');
    assert.equal(a.in_surface, b.in_surface, 'in_surface 不能变');
    assert.equal(a.compacted_at, b.compacted_at, 'compacted_at 不能变');
    assert.equal(a.excluded, b.excluded, 'excluded 不能变');
    assert.ok(a.text.length <= b.text.length, '清洗后不应变长');
  }
});

test('真实会话：11-08 单日软排除 = 327 条（验收口径）', { skip: hasReal ? false : '无真实会话' }, () => {
  const { header, events } = readSessionFile(REAL_SESSION);
  const { messages, stats } = exportMessages(events, {
    sessionId: header.id,
    excludeRanges: [{
      from: '2026-11-08T00:00:00+08:00',
      to: '2026-11-09T00:00:00+08:00',
      reason: '调试期',
    }],
  });

  // 条数与 lead 独立核算一致。
  // 字数有两个口径：清洗后（真正入库的字符数）与清洗前（历史对照）。
  // 清洗把 11-08 那天的大段桥接头去掉了，所以入库字数从 21,264 降到 14,377。
  assert.equal(stats.excludedCount, 327, `排除条数应为 327，实际 ${stats.excludedCount}`);
  assert.equal(stats.excludedCharsBeforeClean, 21264, `清洗前排除字数应为 21,264，实际 ${stats.excludedCharsBeforeClean}`);
  assert.ok(stats.excludedChars > 10000 && stats.excludedChars < stats.excludedCharsBeforeClean,
    `清洗后排除字数应落在 (10000, 21264)，实际 ${stats.excludedChars}`);

  // 软排除绝不丢消息
  assert.equal(messages.length, stats.totalMessages, '软排除后条数必须不变');
  const excluded = messages.filter((m) => m.excluded === 1);
  assert.equal(excluded.length, 327, 'excluded=1 的条数必须与统计一致');
  assert.equal(excluded.reduce((a, m) => a + m.text.length, 0), stats.excludedChars, 'excluded=1 的字数必须与统计一致');

  // 被排除的消息全部落在上海时间 11-08 这一天
  for (const m of excluded) {
    assert.equal(dayKeyInZone(m.at), '2026-11-08', `seq=${m.seq} 不在 11-08`);
  }
  // 反过来：11-08 当天的消息全部被排除了，没有漏网
  const day8 = messages.filter((m) => dayKeyInZone(m.at) === '2026-11-08');
  assert.equal(day8.length, 327, `11-08 实际应有 327 条，实际 ${day8.length}`);
  assert.ok(day8.every((m) => m.excluded === 1), '11-08 的消息必须全部 excluded=1');
  // 11-09 一条都不该被排除（开区间边界）
  const day9 = messages.filter((m) => dayKeyInZone(m.at) === '2026-11-09');
  assert.ok(day9.length > 0, '11-09 应有消息');
  assert.ok(day9.every((m) => m.excluded === 0), '11-09 的消息一条都不该被排除');

  console.log(`\n  [软排除] 11-08 排除 ${stats.excludedCount} 条 / ${stats.excludedChars} 字（清洗前 ${stats.excludedCharsBeforeClean} 字）`);
  console.log(`  [软排除] 可检索 ${stats.searchableCount} 条 / ${stats.searchableChars} 字`);
  console.log(`  [软排除] 11-09 共 ${day9.length} 条，全部未被排除`);
});

test('导出：纯图片消息（无 text 块）不丢失，用 [图片] 占位入库并带出 media', () => {
  const events = [
    {
      seq: 1,
      time: 1000,
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [
          { type: 'image', path: '/tmp/a.png' },
          { type: 'image', data: 'abc123', mimeType: 'image/png' },
        ],
      },
    },
    assistantMsg(2, 2000, [{ type: 'image', uri: 'file:///tmp/b.png' }]),
  ];
  const { messages, media, stats } = exportMessages(events);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, `${BRIDGE_IMAGE_TOKEN}×2`);
  assert.equal(messages[1].text, BRIDGE_IMAGE_TOKEN);
  assert.equal(stats.skippedEmptyText, 0);
  assert.equal(stats.skippedNoTextBlock, 0);
  assert.equal(media.length, 3);
  assert.deepEqual(
    media.map((m) => ({ seq: m.seq, path: m.path })),
    [
      { seq: 1, path: '/tmp/a.png' },
      { seq: 1, path: 'inline:image/png' },
      { seq: 2, path: 'file:///tmp/b.png' },
    ],
  );
});

test('导出：DSH v4 attachment 图片块（sha256 attachmentId）正确提取到 media', () => {
  const events = [
    {
      type: 'user/message',
      seq: 10,
      time: 3000,
      data: {
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '[图片1]' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:6be1a9301d6717dfca5b0382b98de13c5dc4d87fae4153893a9949ad0f235ff3',
              mediaType: 'image/jpeg',
              width: 736,
              height: 492,
              bytes: 99035,
              name: 'qq-image-1.jpeg',
            },
          },
        ],
      },
    },
  ];
  const { media } = exportMessages(events);
  assert.equal(media.length, 1);
  assert.equal(media[0].path, 'sha256:6be1a9301d6717dfca5b0382b98de13c5dc4d87fae4153893a9949ad0f235ff3');
  assert.equal(media[0].sha256, '6be1a9301d6717dfca5b0382b98de13c5dc4d87fae4153893a9949ad0f235ff3');
  assert.equal(media[0].width, 736);
  assert.equal(media[0].height, 492);
});
