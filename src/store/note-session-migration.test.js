/**
 * 迁移 v5 → v6：note 表补 `session_id`（A1 会话隔离的存储侧）
 *
 * 为什么有这一条：会话隔离不能只在工具层过滤 —— `note` 表原本没有会话归属，
 * 于是TA记的笔记属于"所有会话"。加列之后必须回答一个数据问题：
 * **历史笔记（v5 及更早写的）归谁？**
 *
 * 实现策略（见 db.js 的 MIGRATIONS[5]）：
 *   - 库里只有一个会话 → 历史笔记必然是它的，**回填**（用户不会觉得笔记丢了）；
 *   - 库里多个会话 → 无法判断，保持 NULL 并告警（不猜、也不删）。
 *
 * 这个文件把两条路径都钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, SCHEMA_VERSION } from './db.js';
import { createRepo, createExtras } from './repo.js';

const silent = { warn: () => {} };

/** 造一个「v5 结构」的库：把 note.session_id 列和它的索引去掉，版本调回 5 */
function downgradeNoteToV5(handle) {
  handle.db.exec('DROP INDEX IF EXISTS idx_note_session');
  handle.db.exec('ALTER TABLE note DROP COLUMN session_id');
  handle.db.exec('PRAGMA user_version = 5');
  const cols = handle.db.prepare('PRAGMA table_info(note)').all().map((c) => c.name);
  assert.ok(!cols.includes('session_id'), '前置条件：v5 的 note 表没有 session_id');
  assert.equal(Number(handle.db.prepare('PRAGMA user_version').get().user_version), 5);
}

/** 每个用例一个临时目录，跑完删干净 */
function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verbatim-v6-migrate-'));
  const file = join(dir, 'memory.db');
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('迁移 v5→v6：note 补 session_id；单会话库的历史笔记自动回填（不丢）', () => {
  withTempDb((file) => {
    /* ① 造 v5 库：一个会话 + 一条没有归属的笔记 */
    const h1 = openDb({ dbPath: file, loadVec: false, logger: silent });
    h1.db.exec(`
      INSERT INTO msg (session_id, seq, at, speaker, text, in_surface, excluded)
        VALUES ('s-old', 1, 1000, 'user', '老数据', 1, 0)
    `);
    const noteId = createExtras(h1).note.insert({ content: 'v5 写的笔记', at: 2000 });
    downgradeNoteToV5(h1);
    h1.close();
    assert.ok(existsSync(file));

    /* ② 用现在的代码打开：补列 + 回填 */
    const h2 = openDb({ dbPath: file, loadVec: false, logger: silent });
    try {
      assert.equal(Number(h2.db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
      const cols = h2.db.prepare('PRAGMA table_info(note)').all().map((c) => c.name);
      assert.ok(cols.includes('session_id'), 'note 必须补上 session_id 列');

      const extras = createExtras(h2.db);
      const note = extras.note.byId(noteId);
      assert.ok(note, '历史笔记一条都不能丢');
      assert.equal(note.content, 'v5 写的笔记');
      assert.equal(note.sessionId, 's-old', '库里有唯一会话时，历史笔记必须回填到它，否则用户会以为笔记丢了');
      assert.equal(extras.note.list({ sessionId: 's-old' }).length, 1, '回填后按会话能查到');
    } finally {
      h2.close();
    }

    /* ③ 再开一次：迁移必须幂等（不重复 ALTER、不重复回填） */
    const h3 = openDb({ dbPath: file, loadVec: false, logger: silent });
    try {
      const again = createExtras(h3).note.byId(noteId);
      assert.equal(again.sessionId, 's-old');
    } finally {
      h3.close();
    }
  });
});

test('迁移 v5→v6：库里有多个会话时不猜归属，保持 NULL 并告警', () => {
  withTempDb((file) => {
    const h1 = openDb({ dbPath: file, loadVec: false, logger: silent });
    h1.db.exec(`
      INSERT INTO msg (session_id, seq, at, speaker, text, in_surface, excluded)
        VALUES ('s-1', 1, 1000, 'user', '会话一', 1, 0),
               ('s-2', 1, 2000, 'user', '会话二', 1, 0)
    `);
    const noteId = createExtras(h1).note.insert({ content: '不知道属于谁' });
    downgradeNoteToV5(h1);
    h1.close();

    const h2 = openDb({ dbPath: file, loadVec: false, logger: silent });
    try {
      const extras = createExtras(h2.db);
      const note = extras.note.byId(noteId);
      assert.ok(note, '不确定归属也不能删');
      assert.equal(note.sessionId, null, '多会话时不做无依据归属');
      assert.equal(extras.note.list({ sessionId: 's-1' }).length, 0);
      assert.ok(
        h2.warnings.some((w) => /note\.session_id/.test(w)),
        `必须留下可追的告警，实际：${JSON.stringify(h2.warnings)}`,
      );
    } finally {
      h2.close();
    }
  });
});

test('迁移 v9→v10：note.about 从旧视角翻成 Agent 视角（me→him，her→me，us/null 不变），且再开不二次翻转', () => {
  withTempDb((file) => {
    /* ① 造一个 v9 库：写入旧版 note.about 的四种取值 */
    const h1 = openDb({ dbPath: file, loadVec: false, logger: silent });
    const extras1 = createExtras(h1);
    const idOldMe = extras1.note.insert({ content: '旧口径：关于他', about: 'me', at: 1000 });
    const idOldHer = extras1.note.insert({ content: '旧口径：关于TA自己', about: 'her', at: 2000 });
    const idUs = extras1.note.insert({ content: '关于我们俩', about: 'us', at: 3000 });
    const idNull = extras1.note.insert({ content: '未标归属', about: null, at: 4000 });
    h1.db.exec('PRAGMA user_version = 9');
    assert.equal(Number(h1.db.prepare('PRAGMA user_version').get().user_version), 9);
    h1.close();

    /* ② 用当前代码打开：触发 v9→v10→... 迁移并升到当前 SCHEMA_VERSION */
    const h2 = openDb({ dbPath: file, loadVec: false, logger: silent });
    try {
      assert.equal(Number(h2.db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
      assert.ok(SCHEMA_VERSION >= 10);
      const extras2 = createExtras(h2);
      assert.equal(extras2.note.byId(idOldMe).about, 'him', "旧 'me' 应翻成 'him'");
      assert.equal(extras2.note.byId(idOldHer).about, 'me', "旧 'her' 应翻成 'me'");
      assert.equal(extras2.note.byId(idUs).about, 'us', "'us' 应保持不变");
      assert.equal(extras2.note.byId(idNull).about, null, 'null 应保持不变');
    } finally {
      h2.close();
    }

    /* ③ 再次 openDb：user_version 已是最新，绝不能把新 'me' 再翻成 'him' */
    const h3 = openDb({ dbPath: file, loadVec: false, logger: silent });
    try {
      assert.equal(Number(h3.db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
      const extras3 = createExtras(h3);
      assert.equal(extras3.note.byId(idOldMe).about, 'him');
      assert.equal(extras3.note.byId(idOldHer).about, 'me', "二次打开不得把 'me' 再翻成 'him'");
      assert.equal(extras3.note.byId(idUs).about, 'us');
      assert.equal(extras3.note.byId(idNull).about, null);
    } finally {
      h3.close();
    }
  });
});
