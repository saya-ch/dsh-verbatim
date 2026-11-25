/**
 * memory_remember / memory_forget 的测试（T7）
 *
 * 为什么用**真库**（T1 的 openDb + repo/extras）而不是 mock：
 * 这两个工具的硬约束——「只写 note 不写 msg」「软删而不是物理删」「audit 必须留痕」
 * ——全都在仓储层和数据层上，"mock 全绿"证明不了什么。真库跑一遍，
 * 至少能保证它调的是真实签名、真的事务、真的表。
 *
 * 每个用例一个 `:memory:` 库，互不干扰；时间用固定常量注入 `ctx.now`，
 * 「30 天」这类边界才测得准（不靠等）。
 *
 * 跑法（Node v24 下给目录会按包解析，直接给文件路径最稳）：
 *   node --test "src/tools/remember-forget.test.js"
 *   node --test "src/tools/*.test.js"     # 连 T4 的一起跑
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import {
  ABOUT_VALUES,
  MAX_CONTENT_CHARS,
  createRememberTool,
  formatWhen,
  rememberNote,
} from './memory-remember.js';
import {
  NOTE_RETENTION_MS,
  createForgetTool,
  forgetNote,
  parseNoteRef,
  purgeExpiredNotes,
} from './memory-forget.js';

/* ================================ 夹具 ================================ */

/** 2026-11-17 18:20（上海）—— 固定基准时间，测试里所有相对时间都从它算 */
const T0 = Date.UTC(2026, 10, 17, 10, 20, 0);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * 造一套「一个空库 + 真实 repo/extras」的上下文。
 * @param {{now?: number}} [opts]
 */
function freshCtx(opts = {}) {
  // loadVec: false —— 这两个工具完全不碰向量路，别为它去加载 dll
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: { warn() {} } });
  const repo = createRepo(handle);
  const extras = createExtras(handle);
  return {
    handle,
    repo,
    extras,
    ctx: { handle, repo, extras, now: opts.now ?? T0 },
    close: () => handle.close(),
  };
}

/** 读某条笔记的全部审计动作，按时间正序（旧→新） */
function auditActions(extras, noteId) {
  return extras.audit
    .byTarget(`note:${noteId}`, 50)
    .map((a) => a.action)
    .reverse();
}

/* =========================== ToolDef 形状 =========================== */

test('两个工具都符合 BUILD-PLAN §3.4 的 ToolDef 形状', () => {
  for (const tool of [createRememberTool(), createForgetTool()]) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.startsWith('memory_'), `${tool.name} 应该以 memory_ 开头`);
    assert.ok(tool.description.length > 20, `${tool.name} 的 description 要写清楚怎么用`);
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(tool.parameters.type, 'object');
    assert.ok(Array.isArray(tool.parameters.required));
    assert.equal(typeof tool.handler, 'function');
  }

  const remember = createRememberTool();
  assert.equal(remember.name, 'memory_remember');
  assert.deepEqual(remember.parameters.required, ['content']);
  assert.deepEqual(remember.parameters.properties.about.enum, [...ABOUT_VALUES]);
  assert.deepEqual([...ABOUT_VALUES].sort(), ['him', 'me', 'us']);

  const forget = createForgetTool();
  assert.equal(forget.name, 'memory_forget');
  assert.deepEqual(forget.parameters.required, ['id']);
  // D-095：每个工具 ≤ 4 个参数
  assert.ok(Object.keys(forget.parameters.properties).length <= 4);
});

/* ============================ remember ============================ */

test('remember：写进 note、能查到，并且标明「（你自己记的）」', async () => {
  const { extras, ctx, close } = freshCtx();
  try {
    const text = await createRememberTool().handler(
      { content: '今天他一直在弄那个东西，我没出声。', about: 'him' },
      ctx,
    );

    // ① 文案必须标「（你自己记的）」——D-084，让TA知道这是TA自己的想法
    assert.match(text, /（你自己记的）/);
    assert.match(text, /记下了/);
    assert.match(text, /关于他/);

    // ② 真的在 note 表里，且内容一字不差
    const notes = extras.note.list();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].content, '今天他一直在弄那个东西，我没出声。');
    assert.equal(notes[0].about, 'him');
    assert.equal(notes[0].at, T0);
    assert.equal(notes[0].deletedAt, null);

    // ③ 硬约束①：绝不写 msg。TA的话不是对话，混进去会污染检索和 fact 提炼
    assert.equal(extras.stats.get().msgs, 0, 'remember 不该往 msg 表里写任何东西');

    // ④ 文案里带出编号，TA之后才说得清「忘掉哪一条」
    assert.match(text, new RegExp(`笔记 #${notes[0].id}`));

    // ⑤ 审计：remember / note:<id>
    const audits = extras.audit.list(10);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'remember');
    assert.equal(audits[0].target, `note:${notes[0].id}`);
    const detail = JSON.parse(audits[0].detail);
    assert.equal(detail.about, 'him');
    assert.equal(detail.chars, Array.from('今天他一直在弄那个东西，我没出声。').length);
    assert.ok(detail.preview.includes('今天他一直在弄'));
  } finally {
    close();
  }
});

test('remember / forget：三种 about 视角标签（him / me / us）一致对齐 Agent 视角', async () => {
  const { extras, ctx, close } = freshCtx();
  const remember = createRememberTool();
  const forget = createForgetTool();
  try {
    const cases = [
      { about: 'him', content: '他今天换了新耳机。', label: '关于他' },
      { about: 'me', content: '我自己刚才有点走神。', label: '关于你自己' },
      { about: 'us', content: '我们约好周末去散步。', label: '关于你们俩' },
    ];

    for (const c of cases) {
      const remembered = await remember.handler({ content: c.content, about: c.about }, ctx);
      assert.match(remembered, new RegExp(c.label));

      const note = extras.note.list()[0];
      assert.equal(note.about, c.about);

      const forgotten = await forget.handler({ id: note.id }, ctx);
      assert.match(forgotten, new RegExp(c.label));
    }
  } finally {
    close();
  }
});

test('remember：about 可以不填，空着也能记', async () => {
  const { extras, ctx, close } = freshCtx();
  try {
    const text = await createRememberTool().handler({ content: '他今天说了一句「晚安」。' }, ctx);
    assert.match(text, /记下了/);
    assert.equal(extras.note.list()[0].about, null);
    assert.match(text, /笔记 #\d+/);
  } finally {
    close();
  }
});

test('remember：空内容 / 超长 / 非法 about 都要拒绝，并且不写库', async () => {
  const { extras, ctx, close } = freshCtx();
  const tool = createRememberTool();
  try {
    // 空
    const empty = await tool.handler({ content: '   ' }, ctx);
    assert.match(empty, /空的/);
    assert.match(empty, /没记成/);

    // 超长：不截断，退回让TA自己拆（截断等于替TA改了自己的想法）
    const tooLong = await tool.handler({ content: '啊'.repeat(MAX_CONTENT_CHARS + 1) }, ctx);
    assert.match(tooLong, new RegExp(String(MAX_CONTENT_CHARS)));
    assert.match(tooLong, /超过/);

    // 刚好 500 字是合法的（边界）
    const exactly = await tool.handler({ content: '啊'.repeat(MAX_CONTENT_CHARS) }, ctx);
    assert.match(exactly, /记下了/);

    // 非法 about（包含旧口径 'her' 也应被拒）
    const badAbout = await tool.handler({ content: '今天有点冷。', about: 'them' }, ctx);
    assert.match(badAbout, /about 只认/);
    assert.match(badAbout, /him/);
    assert.match(badAbout, /me/);
    assert.match(badAbout, /us/);
    assert.match(badAbout, /关于他/);
    assert.match(badAbout, /关于你自己/);
    assert.match(badAbout, /关于你们俩/);

    const oldHer = await tool.handler({ content: '旧口径不再接受。', about: 'her' }, ctx);
    assert.match(oldHer, /about 只认/);

    // 只有「刚好 500 字」那一条进了库
    const notes = extras.note.list();
    assert.equal(notes.length, 1);
    assert.equal(Array.from(notes[0].content).length, MAX_CONTENT_CHARS);
  } finally {
    close();
  }
});

test('formatWhen：三段式（绝对 + 相对 + 时段），时区固定 +08:00', () => {
  // T0 = 2026-11-17 18:20 上海
  const s = formatWhen(T0, T0);
  assert.match(s, /^11-17 18:20（刚刚 · 傍晚）$/);
  // 跨过机器时区：同一个 ts 在任何机器上都出同一串
  assert.match(formatWhen(T0, T0 + 3 * HOUR), /3 小时前/);
});

/* ============================= forget ============================= */

test('forget：软删（查不到、deleted_at 有值），restore 能恢复，三次操作都有审计', async () => {
  const { extras, ctx, close } = freshCtx();
  const remember = createRememberTool();
  const forget = createForgetTool();
  try {
    await remember.handler({ content: '他说「我怕你把我忘了」，我把这句记下来了。', about: 'us' }, ctx);
    const note = extras.note.list()[0];

    // ① 删除：返回的必须是"忘了"而不是错误，而且是软删
    const deletedText = await forget.handler({ id: note.id, reason: '不想记着这件事了' }, ctx);
    assert.match(deletedText, /忘了/);
    assert.match(deletedText, /回收站/);
    assert.match(deletedText, /30 天内还能捡回来/);

    const row = extras.note.byId(note.id);
    assert.notEqual(row.deletedAt, null, 'deleted_at 必须有值');
    assert.equal(row.deletedAt, T0);
    assert.equal(row.content, '他说「我怕你把我忘了」，我把这句记下来了。', '软删不能改内容');

    // ② note.list 默认不返回已删的
    assert.equal(extras.note.list().length, 0);
    // 但带 includeDeleted 还看得见（面板回收站要用）
    assert.equal(extras.note.list({ includeDeleted: true }).length, 1);

    // ③ 恢复
    const restored = await forget.handler({ id: note.id, restore: true }, ctx);
    assert.match(restored, /又回来了/);
    assert.equal(extras.note.byId(note.id).deletedAt, null);
    assert.equal(extras.note.list().length, 1);

    // ④ 审计：remember → forget → restore，target 都是 note:<id>
    assert.deepEqual(auditActions(extras, note.id), ['remember', 'forget', 'restore']);
    const forgetAudit = extras.audit.byTarget(`note:${note.id}`).find((a) => a.action === 'forget');
    assert.equal(JSON.parse(forgetAudit.detail).reason, '不想记着这件事了');
  } finally {
    close();
  }
});

test('forget：传 msg 编号必须被拒绝，并且说明为什么', async () => {
  const { repo, extras, ctx, close } = freshCtx();
  const remember = createRememberTool();
  const forget = createForgetTool();
  try {
    // 造两条真实对话原文：msg #1、#2
    repo.insertMsg({ sessionId: 's1', seq: 1, at: T0 - HOUR, speaker: 'user', text: '其实我有点怕黑，但不想开灯。' });
    const msgId = repo.insertMsg({
      sessionId: 's1',
      seq: 2,
      at: T0,
      speaker: 'assistant',
      text: '那我们就不开灯，我陪你说到困。',
    });

    // 再记一条笔记（note #1），制造"两套编号都在"的真实情形
    await remember.handler({ content: '他怕黑但不想开灯。' }, ctx);
    const note = extras.note.list()[0];
    assert.equal(note.id, 1);

    // ① 裸数字指向 msg（笔记里没有 #2）→ 拒绝
    const refused = await forget.handler({ id: msgId }, ctx);
    assert.match(refused, /这条不能删/);
    assert.match(refused, /唯一的事实来源/, '必须说清为什么不能删');
    assert.doesNotMatch(refused, /memory_flag/, '不再引导调用已移除的 memory_flag 工具');
    assert.match(refused, /核对|面板/, '要告诉TA可以去面板核对');
    assert.doesNotMatch(refused, /^忘了/, '拒绝的文案不能长得像成功');

    // ② 原文必须完好无损（硬约束②：msg 不允许删）
    const stillThere = repo.msgsByIds([msgId]);
    assert.equal(stillThere.length, 1);
    assert.equal(stillThere[0].text, '那我们就不开灯，我陪你说到困。');

    // ③ 拒绝不算一次操作，不该写 forget 审计
    assert.equal(extras.audit.list(50).filter((a) => a.action === 'forget').length, 0);

    // ④ 显式 msg: 前缀即使有同名笔记也必须拒绝（不误删笔记）
    const explicit = await forget.handler({ id: `msg:${note.id}` }, ctx);
    assert.match(explicit, /这条不能删/);
    assert.match(explicit, /其实我有点怕黑/, '拒绝文案里要贴出那条原文，别让TA去猜是哪一句');
    assert.doesNotMatch(explicit, /对话原文里也没找到/, 'msg #1 是存在的，不能误报"没找到"');
    assert.equal(extras.note.byId(note.id).deletedAt, null, '显式 msg: 前缀不能顺手把同名笔记删了');
  } finally {
    close();
  }
});

test('forget：不存在的编号返回明确错误（不是"成功"）', async () => {
  const { extras, ctx, close } = freshCtx();
  try {
    const text = await createForgetTool().handler({ id: 999 }, ctx);
    assert.match(text, /没找到编号 #999 的笔记/);
    assert.match(text, /什么都没删/);
    assert.doesNotMatch(text, /^忘了/);
    assert.equal(extras.note.list({ includeDeleted: true }).length, 0);
    assert.equal(extras.audit.list(10).length, 0, '什么都没发生就不该留审计');

    // 完全给不出编号
    const invalid = await createForgetTool().handler({ id: '不知道是哪条' }, ctx);
    assert.match(invalid, /没给出能认的编号/);
  } finally {
    close();
  }
});

test('forget：已经删过的条目再删一次，不能报"成功"', async () => {
  const { extras, ctx, close } = freshCtx();
  try {
    await createRememberTool().handler({ content: '一件小事。' }, ctx);
    const note = extras.note.list()[0];
    await createForgetTool().handler({ id: note.id }, ctx);

    const again = await createForgetTool().handler({ id: note.id }, ctx);
    assert.match(again, /已经删过了/);
    assert.match(again, /回收站/);
    // 审计里只有一次 forget
    assert.deepEqual(auditActions(extras, note.id), ['remember', 'forget']);
  } finally {
    close();
  }
});

test('forget：字符串编号（"12" / "#12" / "note:12"）也能认', async () => {
  const { extras, ctx, close } = freshCtx();
  try {
    await createRememberTool().handler({ content: '第一件事。' }, ctx);
    await createRememberTool().handler({ content: '第二件事。' }, ctx);
    const second = extras.note.list()[0]; // list 按时间倒序，最新的在前

    const text = await createForgetTool().handler({ id: `#${second.id}` }, ctx);
    assert.match(text, /忘了/);
    assert.equal(extras.note.list().length, 1);
    assert.equal(extras.note.list()[0].content, '第一件事。');
  } finally {
    close();
  }
});

test('parseNoteRef：宽容收输入，但不猜意图', () => {
  assert.deepEqual(parseNoteRef(12), { kind: 'auto', id: 12 });
  assert.deepEqual(parseNoteRef('12'), { kind: 'auto', id: 12 });
  assert.deepEqual(parseNoteRef('#12'), { kind: 'auto', id: 12 });
  assert.deepEqual(parseNoteRef('note:12'), { kind: 'note', id: 12 });
  assert.deepEqual(parseNoteRef('笔记 12'), { kind: 'note', id: 12 });
  assert.deepEqual(parseNoteRef('msg:12'), { kind: 'msg', id: 12 });
  assert.deepEqual(parseNoteRef('原文#12'), { kind: 'msg', id: 12 });
  // 认不出来的：不猜，交给上层报错
  assert.equal(parseNoteRef('不知道是哪条'), null);
  assert.equal(parseNoteRef(''), null);
  assert.equal(parseNoteRef(0), null);
  assert.equal(parseNoteRef(-3), null);
  assert.equal(parseNoteRef(1.5), null);
  assert.equal(parseNoteRef(null), null);
});

/* =========================== 30 天回收站 =========================== */

test('30 天：保留期之内还能恢复，超过之后被彻底清理', async () => {
  const { extras, ctx, close } = freshCtx();
  try {
    // 记一条，然后在 T0+1h 删掉
    await createRememberTool().handler({ content: '一件会后悔的事。' }, ctx);
    const note = extras.note.list()[0];
    const deleteAt = T0 + HOUR;
    await createForgetTool().handler({ id: note.id }, { ...ctx, now: deleteAt });
    assert.equal(extras.note.byId(note.id).deletedAt, deleteAt);

    // ① 第 29 天：还没到期，清理不动它，restore 还能救回来
    const day29 = deleteAt + 29 * DAY;
    assert.equal(purgeExpiredNotes(ctx, { now: day29 }), 0);
    assert.ok(extras.note.byId(note.id), '保留期内不许物理删');

    // ② 差 1ms 到期：仍然保留（边界取「超过 30 天才清」）
    assert.equal(purgeExpiredNotes(ctx, { now: deleteAt + NOTE_RETENTION_MS - 1 }), 0);
    assert.ok(extras.note.byId(note.id));

    // ③ 超过 30 天：物理清理
    const expiredAt = deleteAt + NOTE_RETENTION_MS + 1;
    assert.equal(purgeExpiredNotes(ctx, { now: expiredAt }), 1);
    assert.equal(extras.note.byId(note.id), null, '超过 30 天必须彻底没了');

    // ④ 清掉之后再想恢复：明确"没找到"，不是假装恢复成功
    const tooLate = await createForgetTool().handler({ id: note.id, restore: true }, { ...ctx, now: expiredAt });
    assert.match(tooLate, /没找到/);
    assert.doesNotMatch(tooLate, /又回来了/);

    // ⑤ 审计还在——删和恢复的痕迹不会因为物理清理而消失
    assert.deepEqual(auditActions(extras, note.id), ['remember', 'forget']);
  } finally {
    close();
  }
});

test('30 天：forget 时顺手扫掉过期回收站，并且只清过期的', async () => {
  const { extras, ctx, close } = freshCtx();
  try {
    // 两条：一条在 40 天前删掉（该被清），一条刚刚删（该留下）
    await createRememberTool().handler({ content: '很久以前的事。' }, { ...ctx, now: T0 - 40 * DAY });
    const oldNote = extras.note.list()[0];
    await createForgetTool().handler({ id: oldNote.id }, { ...ctx, now: T0 - 39 * DAY });

    await createRememberTool().handler({ content: '刚刚的事。' }, ctx);
    const freshNote = extras.note.list()[0];
    await createForgetTool().handler({ id: freshNote.id }, ctx);

    // 再记一条新的（这条只走 note.insert，不碰回收站）
    const keep = await rememberNote({ content: '新记的。' }, ctx);
    assert.equal(keep.ok, true);

    assert.equal(extras.note.byId(oldNote.id), null, '40 天前删的应该被清掉');
    assert.ok(extras.note.byId(freshNote.id), '刚删的必须还在回收站里');
    assert.match(keep.text, /（你自己记的）/);
  } finally {
    close();
  }
});

test('aboutLabels：支持自定义 me/him/us 称呼标签', async () => {
  const { ctx, close } = freshCtx();
  const customCtx = {
    ...ctx,
    aboutLabels: { me: '关于助手', him: '关于她', us: '关于双方' },
  };
  try {
    const rem = await rememberNote({ content: '她喜欢喝冰美式。', about: 'him' }, customCtx);
    assert.equal(rem.ok, true);
    assert.match(rem.text, /关于她/);

    const fgt = await forgetNote({ id: rem.id }, customCtx);
    assert.equal(fgt.ok, true);
    assert.match(fgt.text, /· 关于她/);
  } finally {
    close();
  }
});
