/**
 * 回归测试 —— D-118「撤回失效比忘记可怕」的两条 P1 + v5 迁移
 *
 * 这两条都不是单模块的问题：单测各自全绿，但 repo 删行、向量表、场景重建
 * 三段合起来会出「撤回的话从向量路复活」。所以用例写在这里（跨模块），
 * 每条都按 R5 给的复现步骤一字不差地走一遍。
 *
 * 跑法：
 *   node --test src/search/
 *   node --test src/search/regression.test.js
 *
 * 覆盖：
 *   ① 撤回的消息建过向量 → 删掉 → 新消息**不能**复用 id → 查不到旧向量
 *   ② 场景重建 → 旧场景向量查不到新场景
 *   ③ v4 老库升级到 v5：数据一条不丢、FTS 还能查、id 从此不复用
 *   ④ deleteMsgsBySeqs（导入时的精确差集删除）也会清向量
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openDb, splitSchema, SCHEMA_VERSION } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import { textToVector } from '../model/mock.js';

import { createVectorStore } from './vector-store.js';
import { DIM, TMP, idsOf, silent } from './_fixtures.js';

/** 开一个库（可选降级模式），返回 repo / extras / 可共享的向量 store */
function setup({ loadVec = true, dbPath = ':memory:' } = {}) {
  const handle = openDb({ dbPath, loadVec, logger: silent });
  const repo = createRepo(handle);
  const extras = createExtras(handle);
  const store = createVectorStore(handle, { dim: DIM, logger: silent });
  return { handle, repo, extras, store, close: () => handle.close() };
}

const msg = (seq, text, at = 1_760_000_000_000 + seq * 60_000, sessionId = 's-rewind') => ({
  sessionId,
  seq,
  at,
  speaker: 'user',
  text,
});

/* ======================================================================
 * ① 撤回 + id 复用（R5 实测 P1：撤回的话挂到新消息上，score=1.0）
 * ====================================================================== */

for (const loadVec of [false, true]) {
  const label = loadVec ? 'vec0 路径' : '降级路径（hasVec=false）';

  test(`撤回的向量不会复活（${label}）`, () => {
    const ctx = setup({ loadVec });
    try {
      // 前置条件：确认走的是预期路径
      assert.equal(ctx.store.mode, loadVec ? 'vec0' : 'bruteforce');

      // ① 三条消息，其中 seq=3 马上要被撤回
      const id1 = ctx.repo.insertMsg(msg(1, '我怕黑，这是不想被记住的话'));
      const id2 = ctx.repo.insertMsg(msg(2, '普通的一句'));
      const id3 = ctx.repo.insertMsg(msg(3, '这条马上要被撤回'));
      ctx.store.insertMsgVecs([
        [id1, textToVector('我怕黑，这是不想被记住的话', DIM)],
        [id2, textToVector('普通的一句', DIM)],
        [id3, textToVector('这条马上要被撤回', DIM)],
      ]);
      assert.equal(ctx.store.countMsgVec(), 3);

      // ② rewind：物理删掉 seq >= 3
      assert.equal(ctx.repo.deleteMsgsBySeq('s-rewind', 3), 1);

      // 向量必须跟着消失（这是原实现漏掉的一步）
      assert.equal(ctx.store.countMsgVec(), 2, '被撤回那条的向量必须一起清掉');
      assert.equal(
        ctx.store.knnMsg(textToVector('这条马上要被撤回', DIM), 3).length,
        2,
        '库里只剩两条，向量路不该还能翻出第三条',
      );

      // ③ 插新消息 —— 重点：**不能复用**被删掉的 id
      const idNew = ctx.repo.insertMsg(msg(3, '完全无关的新消息'));
      assert.notEqual(idNew, id3, 'rewind 删掉的 id 不许复用（v5 的 AUTOINCREMENT）');
      assert.ok(idNew > id3, `新 id 应该更大：旧 ${id3} → 新 ${idNew}`);

      // ④ 用被撤回那条的向量查询：既不该返回新消息，也不该返回任何 id=3
      const hits = ctx.store.knnMsg(textToVector('这条马上要被撤回', DIM), 3);
      assert.ok(!idsOf(hits).includes(idNew), '撤回的话不许挂到新消息上（D-118）');
      assert.ok(!idsOf(hits).includes(id3), '被撤回的那条本身也必须查不到');
      for (const h of hits) {
        assert.notEqual(h.id, id3);
        assert.doesNotMatch(h.text, /撤回/, `命中的内容里不该有被撤回的原文：${h.text}`);
      }

      // ⑤ 全库扫一遍也确认一下
      const all = ctx.repo.msgsByTimeRange('s-rewind', 0, Number.MAX_SAFE_INTEGER, 100, true);
      assert.deepEqual(all.map((m) => m.seq).sort((a, b) => a - b), [1, 2, 3]);
      assert.ok(all.every((m) => m.text !== '这条马上要被撤回'));
    } finally {
      ctx.close();
    }
  });
}

test('撤回清的是持久化那份：降级表里也查不到（不只是内存 Map）', () => {
  const ctx = setup({ loadVec: false });
  try {
    const id = ctx.repo.insertMsg(msg(1, '要撤回的话'));
    ctx.store.insertMsgVec(id, textToVector('要撤回的话', DIM));
    assert.equal(ctx.handle.db.prepare('SELECT COUNT(*) AS c FROM vec_fallback_msg').get().c, 1);

    ctx.repo.deleteMsgsBySeq('s-rewind', 1);
    // 直接查表：即使进程里那份 Map 没被清，落盘这份也必须是空的
    assert.equal(
      ctx.handle.db.prepare('SELECT COUNT(*) AS c FROM vec_fallback_msg').get().c,
      0,
      '降级表（vec_fallback_msg）必须一起清 —— 原实现只清 vec_msg，这里就是漏洞所在',
    );
    // 内存那份靠「表比 Map 少就以表为准」自动重载，不需要调用方记得清
    assert.equal(ctx.store.countMsgVec(), 0, '内存索引也要跟着对账重载');
  } finally {
    ctx.close();
  }
});

test('deleteMsgsBySeqs（导入时的精确差集）也会清向量', () => {
  const ctx = setup({ loadVec: true });
  try {
    const ids = [1, 2, 3, 4].map((seq) => ctx.repo.insertMsg(msg(seq, `第${seq}条`)));
    ctx.store.insertMsgVecs(ids.map((id, i) => [id, textToVector(`第${i + 1}条`, DIM)]));
    assert.equal(ctx.store.countMsgVec(), 4);

    // 只删 seq=2（rewind 之后它不在存活集合里）
    assert.equal(ctx.repo.deleteMsgsBySeqs('s-rewind', [2]), 1);
    assert.equal(ctx.store.countMsgVec(), 3, '被删那条的向量必须一起清');
    const hits = idsOf(ctx.store.knnMsg(textToVector('第2条', DIM), 4));
    assert.ok(!hits.includes(ids[1]), '删掉的那条不该还能被查出来');

    // 空数组 / 重复 seq 都不该出问题
    assert.equal(ctx.repo.deleteMsgsBySeqs('s-rewind', []), 0);
    assert.equal(ctx.repo.deleteMsgsBySeqs('s-rewind', [999, 999]), 0);
  } finally {
    ctx.close();
  }
});

/* ======================================================================
 * ② 场景重建：旧场景向量命中新场景（R5 实测 P1）
 * ====================================================================== */

test('场景重建后，旧场景的 gist 向量查不到新场景', () => {
  const ctx = setup({ loadVec: true });
  try {
    const CAT = '【发生了什么】TA在说猫，猫把杯子推下桌了【原话】"它又推"';
    const OTHER = '【发生了什么】在聊明天的面试和地铁换乘【原话】"几点到"';

    // 第一代场景：猫
    const oldSceneId = ctx.repo.insertScene({
      sessionId: 's-scene',
      startAt: 1_760_000_000_000,
      endAt: 1_760_000_600_000,
      msgCount: 8,
    });
    ctx.repo.setSceneGist(oldSceneId, CAT);
    ctx.store.insertSceneVecs([[oldSceneId, textToVector(CAT, DIM)]]);
    assert.equal(ctx.store.countSceneVec(), 1);
    assert.equal(idsOf(ctx.store.knnScene(textToVector(CAT, DIM), 1))[0], oldSceneId);

    // 重建：清旧场（msg.scene_id 置空 + 删 scene + 清这些场的向量）
    const cleared = ctx.extras.sceneAssign.clear('s-scene', { withIds: true });
    assert.equal(cleared.scenes, 1);
    assert.deepEqual(cleared.sceneIds, [oldSceneId], 'withIds 要给出被删的场 id');
    assert.equal(ctx.store.countSceneVec(), 0, '旧场景的向量必须跟着场景一起消失');

    // 新一代场景：完全无关的内容
    const newSceneId = ctx.repo.insertScene({
      sessionId: 's-scene',
      startAt: 1_760_001_000_000,
      endAt: 1_760_001_600_000,
      msgCount: 6,
    });
    ctx.repo.setSceneGist(newSceneId, OTHER);
    assert.notEqual(newSceneId, oldSceneId, '场景 id 也不许复用（v5 AUTOINCREMENT）');
    ctx.store.insertSceneVecs([[newSceneId, textToVector(OTHER, DIM)]]);

    // 用「猫」那份旧向量查询：绝不能命中这条无关的新对话。
    // 注意断言口径 —— 库里此时只有一条场景向量（OTHER），任何查询都会把它排第一，
    // 所以不能断言"没有结果"，而要断言**分数很低**：
    // 如果旧向量还挂在复用的 id 上，这里会是 1.0000（P1 的现场）。
    const hits = ctx.store.knnScene(textToVector(CAT, DIM), 3);
    assert.ok(!idsOf(hits).includes(oldSceneId), '旧场景已经不在了');
    assert.ok(
      hits.every((h) => h.score < 0.3),
      `旧场景向量不许命中新场景（P1）：${JSON.stringify(hits.map((h) => ({ id: h.id, score: h.score })))}`,
    );
    assert.ok(
      !hits.some((h) => h.score > 0.9),
      '不该有任何场景以接近 1 的相似度被「猫」命中（那就是旧向量复活的现场）',
    );

    // 反向确认：新场景自己的向量仍然工作
    const own = ctx.store.knnScene(textToVector(OTHER, DIM), 1);
    assert.equal(own[0].id, newSceneId);
    assert.ok(own[0].score > 0.9999);
  } finally {
    ctx.close();
  }
});

test('rebuildScenesForSession 会把旧场景向量的内存那份也清掉', async () => {
  // 这条测 pipeline 里那个「store 存在但没人调 clearSceneVec」的洞
  const { rebuildScenesForSession } = await import('../pipeline.js');
  const ctx = setup({ loadVec: false });
  try {
    // 降级模式下内存 Map 是独立一份，repo 清落盘表不会动它 —— 必须显式清
    const s1 = ctx.repo.insertScene({
      sessionId: 's-scene',
      startAt: 1_760_000_000_000,
      endAt: 1_760_000_600_000,
      msgCount: 2,
    });
    ctx.repo.setSceneGist(s1, '【发生了什么】第一代的猫');
    ctx.repo.insertMsgs([msg(1, 'a', 1_760_000_000_000, 's-scene'), msg(2, 'b', 1_760_000_100_000, 's-scene')]);
    ctx.store.insertSceneVecs([[s1, textToVector('【发生了什么】第一代的猫', DIM)]]);
    assert.equal(ctx.store.countSceneVec(), 1);

    const r = rebuildScenesForSession({
      repo: ctx.repo,
      extras: ctx.extras,
      sessionId: 's-scene',
      vectorStore: ctx.store,
    });
    assert.equal(r.scenes, 1, '两分钟内的两条消息应切成一场');
    assert.equal(r.sceneVectorsCleared, 1, '内存里那条旧场景向量应被显式清掉');
    assert.equal(ctx.store.countSceneVec(), 0);
  } finally {
    ctx.close();
  }
});

/* ======================================================================
 * ③ 迁移 v4 → v5：老库升级不丢数据
 * ====================================================================== */

test('v4 老库升级到 v5：数据一条不丢，FTS 还能查，id 从此不复用', () => {
  const dbPath = join(TMP, `legacy-v4-${process.pid}-${Date.now()}.db`);

  /* ① 造一个「v4 结构」的库：拿现在的 schema.sql 基础段，把 AUTOINCREMENT 抹掉 */
  const { base } = splitSchema(readFileSync(join(import.meta.dirname, '..', 'store', 'schema.sql'), 'utf8'));
  const legacySchema = base.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'INTEGER PRIMARY KEY');
  assert.doesNotMatch(
    legacySchema,
    /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i,
    '前置条件：老库的建表语句里不能有 AUTOINCREMENT（注释里提到不算）',
  );

  const old = new DatabaseSync(dbPath);
  try {
    old.exec(legacySchema);
    old.exec(`
      INSERT INTO scene (id, session_id, start_at, end_at, msg_count, gist, preceded_by, created_at)
        VALUES (1, 's-old', 1760000000000, 1760000600000, 3, '【发生了什么】老场的 gist', NULL, 1760000000000);
      INSERT INTO scene (id, session_id, start_at, end_at, msg_count, gist, created_at)
        VALUES (2, 's-old', 1760001000000, 1760001600000, 2, '【发生了什么】第二场', 1760001000000);
      INSERT INTO msg (id, session_id, seq, at, speaker, text, in_surface, compacted_at, excluded, scene_id, vec_model, vec_dim)
        VALUES (1, 's-old', 1, 1760000000000, 'user', '我怕黑，这句要留着', 1, NULL, 0, 1, NULL, NULL),
               (2, 's-old', 2, 1760000100000, 'assistant', '我在', 1, NULL, 0, 1, NULL, NULL),
               (7, 's-old', 3, 1760000200000, 'user', '第三句', 0, 1760000300000, 1, 1, NULL, NULL);
      INSERT INTO beat (msg_id, kind, confidence, created_at) VALUES (1, 'fear', 0.8, 1760000000000);
    `);
    // 注意：老库没有 AUTOINCREMENT，也就没有 sqlite_sequence 这张表
    old.exec('PRAGMA user_version = 4');
  } finally {
    old.close();
  }

  /* ② 用现在的代码打开：应自动迁移到 v5 */
  const handle = openDb({ dbPath, logger: silent });
  try {
    assert.equal(
      Number(handle.db.prepare('PRAGMA user_version').get().user_version),
      SCHEMA_VERSION,
      'migrate 应把 user_version 标到当前版本',
    );
    // v6 起多了 note.session_id（会话隔离）；v7 删了 lexicon（该表从来没填过）。
    // 这条断言只是跟着 SCHEMA_VERSION 走，别让它挡住后续迁移。
    // v8 起多了 chunk 表（长文本分片，D-247）；v9 把存量超长消息重新排队索引；
    // v10 把 note.about 翻成 Agent 视角；v11 加 scene.gist_source；v12 加 scene.locked 与 media.caption；
    // v13 加 window / vec_window；v14 删掉 window_fts（trigram 对 2 字中文词无效，见 schema.sql）
    assert.equal(SCHEMA_VERSION, 15);

    // 结构变了
    const ddl = handle.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'msg'").get().sql;
    assert.match(ddl, /AUTOINCREMENT/i, 'msg.id 应已带 AUTOINCREMENT');
    const sceneDdl = handle.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'scene'").get().sql;
    assert.match(sceneDdl, /AUTOINCREMENT/i, 'scene.id 也应带 AUTOINCREMENT');

    const repo = createRepo(handle);
    const extras = createExtras(handle);

    // 数据一条不丢、字段一字不改
    const msgs = repo.msgsByTimeRange('s-old', 0, Number.MAX_SAFE_INTEGER, 100, true);
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs.map((m) => m.id), [1, 2, 7], 'id 必须原样保留（FTS 的 rowid 靠它对上）');
    assert.equal(msgs[0].text, '我怕黑，这句要留着');
    assert.equal(msgs[2].inSurface, 0);
    assert.equal(msgs[2].compactedAt, 1760000300000);
    assert.equal(msgs[2].excluded, 1);
    assert.equal(msgs[0].sceneId, 1, 'msg → scene 的关联不能断');

    // 场景（含外键 preceded_by）也都在
    const scene = repo.sceneById(1);
    assert.equal(scene.gist, '【发生了什么】老场的 gist');
    assert.equal(scene.msgCount, 3);
    assert.equal(repo.sceneById(2).gist, '【发生了什么】第二场');

    // 子表没被 CASCADE 掉（这就是迁移必须关 foreign_keys 的原因）
    assert.equal(repo.beatsByKind('fear', 10).length, 1, 'beat 不该在重建 msg 表时被级联删除');

    // FTS 照常工作（external content 表靠 rowid 对齐）
    const found = extras.search.keyword('我怕黑', { limit: 5 });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 1);

    // 触发器也重建了：迁移之后新插的消息能被 FTS 搜到
    const triggered = repo.insertMsg({ sessionId: 's-old', seq: 8, at: 1760008000000, speaker: 'user', text: '迁移之后新加的一句话' });
    const foundNew = extras.search.keyword('迁移之后', { limit: 5 });
    assert.deepEqual(foundNew.map((m) => m.id), [triggered], 'FTS 触发器必须随建表一起恢复');

    // ③ 迁移后 id 不再复用
    const newId = repo.insertMsg({ sessionId: 's-old', seq: 9, at: 1760009000000, speaker: 'user', text: '新的一条' });
    assert.ok(newId > 7, `新 id 必须大于历史最大 id 7，实际 ${newId}`);
    const reuseId = repo.insertMsg({ sessionId: 's-old', seq: 10, at: 1760009100000, speaker: 'user', text: '又一条' });
    assert.ok(reuseId > newId);

    // 删掉最大的那条再插：id 仍然不能回头复用
    assert.equal(repo.deleteMsgsBySeq('s-old', 10), 1);
    const afterDelete = repo.insertMsg({ sessionId: 's-old', seq: 11, at: 1760009200000, speaker: 'user', text: '删完再插' });
    assert.ok(afterDelete > reuseId, `删掉 id=${reuseId} 之后不许复用，实际 ${afterDelete}`);
  } finally {
    handle.close();
  }

  /* ④ 再开一次：迁移必须幂等（不能第二次又重建一遍或报错） */
  const again = openDb({ dbPath, logger: silent });
  try {
    assert.equal(Number(again.db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
    const repo = createRepo(again);
    // 老库 3 条 + 迁移后陆续插了 3 条、删了 1 条 = 6 条
    assert.equal(repo.msgsByTimeRange('s-old', 0, Number.MAX_SAFE_INTEGER, 100, true).length, 6);
    const againDdl = again.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'msg'").get().sql;
    assert.match(againDdl, /AUTOINCREMENT/i);
  } finally {
    again.close();
  }
});

/* ======================================================================
 * ④ 卫生：老库里已经存在的孤儿向量能被清掉
 * ====================================================================== */

test('pruneOrphans：清掉原文已经不在的向量（v5 之前的老库会留下这种）', () => {
  const ctx = setup({ loadVec: true });
  try {
    const keep = ctx.repo.insertMsg(msg(1, '留着的'));
    const gone = ctx.repo.insertMsg(msg(2, '要删的'));
    ctx.store.insertMsgVecs([
      [keep, textToVector('留着的', DIM)],
      [gone, textToVector('要删的', DIM)],
    ]);
    // 绕过 repo 直接删原文，模拟"v5 之前的老库 / 删除与清理之间崩过"
    ctx.handle.db.prepare('DELETE FROM msg WHERE id = ?').run(gone);
    assert.equal(ctx.store.countMsgVec(), 2, '前置条件：孤儿向量还在');

    const removed = ctx.store.pruneOrphans();
    assert.equal(removed.msgVectors, 1);
    assert.equal(ctx.store.countMsgVec(), 1);
    assert.deepEqual(idsOf(ctx.store.knnMsg(textToVector('要删的', DIM), 2)), [keep]);
  } finally {
    ctx.close();
  }
});
