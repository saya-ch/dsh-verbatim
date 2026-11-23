import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from './store/db.js';
import { createRepo, createExtras } from './store/repo.js';
import { syncScenesForSession } from './pipeline.js';
import { createDbAdmin } from './host/db-admin.js';
import { runTimelineRoute } from './tools/time-route.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-20T10:00:00+08:00');

test('syncScenesForSession：cutFromIdx > 0 时不触发 FOREIGN KEY constraint failed，且后续天能正常成场', () => {
  const handle = openDb({ dbPath: ':memory:' });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    const sid = 'sess-fk-cut';

    // 第一批：第 1 天两场（间隔 6h）+ 第 2 天第一场（共 3 场）
    repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '第一场开头', inSurface: 1 },
      { sessionId: sid, seq: 2, at: T0 + 60_000, speaker: 'assistant', text: '第一场回复', inSurface: 1 },
      { sessionId: sid, seq: 3, at: T0 + 6 * HOUR, speaker: 'user', text: '第二场开头', inSurface: 1 },
      { sessionId: sid, seq: 4, at: T0 + 6 * HOUR + 60_000, speaker: 'assistant', text: '第二场回复', inSurface: 1 },
      { sessionId: sid, seq: 5, at: T0 + DAY, speaker: 'user', text: '第三场开头', inSurface: 1 },
      { sessionId: sid, seq: 6, at: T0 + DAY + 60_000, speaker: 'assistant', text: '第三场回复', inSurface: 1 },
    ]);

    const r1 = syncScenesForSession({
      db: handle.db,
      repo,
      extras,
      sessionId: sid,
      now: T0 + DAY + 2 * HOUR,
      settleMs: 30 * 60_000,
    });
    assert.equal(r1.scenes, 3);

    // 第二批：紧接第三场 5 分钟后又发了新消息（触发 cutFromIdx = 2 > 0），以及隔天第 4 场
    repo.insertMsgs([
      { sessionId: sid, seq: 7, at: T0 + DAY + 5 * 60_000, speaker: 'user', text: '第三场续聊', inSurface: 1 },
      { sessionId: sid, seq: 8, at: T0 + 2 * DAY, speaker: 'user', text: '隔天新话题', inSurface: 1 },
      { sessionId: sid, seq: 9, at: T0 + 2 * DAY + 60_000, speaker: 'assistant', text: '隔天回复', inSurface: 1 },
    ]);

    const r2 = syncScenesForSession({
      db: handle.db,
      repo,
      extras,
      sessionId: sid,
      now: T0 + 2 * DAY + 2 * HOUR,
      settleMs: 30 * 60_000,
    });
    assert.ok(r2.scenes >= 4, 'cutFromIdx > 0 应正常重切并生成后续场次');
    const msgs = repo.msgsByTimeRange(sid, 0, T0 + 3 * DAY, 100, true);
    assert.ok(msgs.every((m) => m.sceneId != null), '所有已沉淀消息都应分配 scene_id');
  } finally {
    handle.close();
  }
});

test('media.replaceForSession：重导会话时不丢失已有图片备注 caption', () => {
  const handle = openDb({ dbPath: ':memory:' });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    const sid = 'sess-media-cap';
    repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '看这张图', inSurface: 1 },
    ]);
    extras.media.replaceForSession(sid, [
      { seq: 1, path: '/tmp/a.png', sha256: 'abc123', width: 100, height: 100, at: T0 },
    ]);
    const row = repo.msgsByTimeRange(sid, 0, T0 + DAY, 10, true)[0];
    const mediaRows = extras.media.byMsgIds([row.id]).get(row.id);
    assert.equal(mediaRows.length, 1);
    extras.media.setCaption(mediaRows[0].id, '公园湖边的长椅');

    // 重新导入同一附件
    extras.media.replaceForSession(sid, [
      { seq: 1, path: '/tmp/a.png', sha256: 'abc123', width: 100, height: 100, at: T0 },
    ]);
    const after = extras.media.byMsgIds([row.id]).get(row.id);
    assert.equal(after[0].caption, '公园湖边的长椅');
  } finally {
    handle.close();
  }
});

test('beatsByKind：过滤掉 excluded = 1 的消息', () => {
  const handle = openDb({ dbPath: ':memory:' });
  try {
    const repo = createRepo(handle);
    const extras = createExtras(handle);
    const sid = 'sess-beat-excl';
    repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '正常消息', inSurface: 1, excluded: 0 },
      { sessionId: sid, seq: 2, at: T0 + 1000, speaker: 'user', text: '隐私消息', inSurface: 1, excluded: 1 },
    ]);
    const msgs = repo.msgsByTimeRange(sid, 0, T0 + DAY, 10, true);
    for (const m of msgs) {
      repo.insertBeat(m.id, 'promise', 0.9);
    }
    const beats = repo.beatsByKind('promise', 50);
    assert.equal(beats.length, 1);
    assert.equal(beats[0].msgId, msgs[0].id);
  } finally {
    handle.close();
  }
});

test('runTimelineRoute：leadIn 摘要兜底时不泄露 excluded === 1 的消息', () => {
  const handle = openDb({ dbPath: ':memory:' });
  try {
    const repo = createRepo(handle);
    const sid = 'sess-leadin-excl';
    repo.insertMsgs([
      { sessionId: sid, seq: 1, at: T0, speaker: 'user', text: '可见的最后一句', inSurface: 1 },
      { sessionId: sid, seq: 2, at: T0 + 2 * HOUR, speaker: 'user', text: '新一场第一句', inSurface: 1 },
    ]);
    const sceneId = repo.insertScene({
      sessionId: sid,
      startAt: T0 + 2 * HOUR,
      endAt: T0 + 2 * HOUR,
      msgCount: 1,
      createdAt: T0 + 2 * HOUR,
    });
    repo.updateSceneLinks(sceneId, {
      precededBy: null,
      followedBy: null,
      gapBeforeMs: 2 * HOUR,
      gapAfterMs: null,
      leadIn: JSON.stringify([
        { seq: 1, at: T0 - 60_000, speaker: 'user', text: 'SECRET_EXCLUDED_LINE', excluded: 1 },
        { seq: 2, at: T0, speaker: 'assistant', text: 'VISIBLE_LEAD_LINE', excluded: 0 },
      ]),
    });
    handle.db.prepare('UPDATE msg SET scene_id = ? WHERE session_id = ? AND seq = 2').run(sceneId, sid);

    const text = runTimelineRoute({
      repo,
      sessionId: sid,
      now: T0 + 3 * HOUR,
      window: { kind: 'latest', from: 0, to: T0 + 3 * HOUR, label: '' },
      includeExcluded: false,
    });
    assert.ok(!text.includes('SECRET_EXCLUDED_LINE'), '不得泄露 excluded=1 的 leadIn 条目');
    assert.ok(text.includes('VISIBLE_LEAD_LINE'), '应保留未排除的 leadIn 条目');
  } finally {
    handle.close();
  }
});

test('dbQuery：拦截绕过型 PRAGMA 与双引号引号错位注入', () => {
  const handle = openDb({ dbPath: ':memory:' });
  try {
    const api = createDbAdmin({
      handle,
      db: handle.db,
      stmt: (sql) => handle.db.prepare(sql),
      dbPath: ':memory:',
      dbRoot: '.',
      repo: createRepo(handle),
      extras: createExtras(handle),
      requireSession: () => 's',
      assertSessionId: (s) => s,
      intParam: (v, _k, { def }) => v ?? def,
      PanelError: class PanelError extends Error {
        constructor(code, msg, status) { super(msg); this.code = code; this.status = status; }
      },
      logger: {},
    });

    assert.throws(() => api.dbQuery({ sql: 'PRAGMA main.query_only = OFF' }), /禁止修改 PRAGMA/);
    assert.throws(() => api.dbQuery({ sql: 'PRAGMA query_only(0)' }), /禁止修改 PRAGMA/);
    assert.throws(() => api.dbQuery({ sql: 'SELECT "a\'b"; DELETE FROM msg WHERE \'x\'=\'y\'' }), /禁止多语句/);
    const ok = api.dbQuery({ sql: 'PRAGMA table_info(msg)' });
    assert.ok(ok.rows.length > 0);
  } finally {
    handle.close();
  }
});
