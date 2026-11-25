/**
 * T1 仓储层单测 —— node:test + 内存库
 *
 * 跑法：
 *   node --test src/store/
 *   node --test src/store/repo.test.js
 *
 * 验收对齐 BUILD-PLAN.md §6.1：
 *   ✅ CRUD 全绿
 *   ✅ rewind 物理删后查不到
 *   ✅ FTS 触发器让 msg_fts 与 msg 同步
 *
 * sqlite-vec 相关用例在没有 vec0 扩展的机器上自动 skip；
 * 装好后（或在装了 sqlite-vec 的 node_modules 环境里）自动参与，
 * 也可以用 VERBATIM_VEC_DLL=<vec0.dll 绝对路径> 指定扩展位置。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb,
  findVecSource,
  ensureVecDll,
  loadVecExtension,
  splitSchema,
  applySchema,
  migrate,
  defaultDbPath,
  defaultVecDllPath,
  SCHEMA_VERSION,
  TUNING,
} from './db.js';
import {
  createRepo,
  createExtras,
  getDefaultRepo,
  closeDefault,
  repo,
  withTx,
  BEAT_KINDS,
} from './repo.js';

/* ------------------------------- 测试脚手架 ------------------------------- */

/** 静默 logger，避免降级 warning 刷测试输出 */
const silent = { warn: () => {} };

/** 临时目录，退出时清掉 */
const TMP = mkdtempSync(join(tmpdir(), 'verbatim-test-'));
process.on('exit', () => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
});

/** 开一个内存库 + repo + extras */
function fresh() {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  const repo = createRepo(handle.db);
  const extras = createExtras(handle.db);
  return { handle, db: handle.db, repo, extras };
}

/** 造一条消息的入参 */
function msg(seq, text, extra = {}) {
  return {
    sessionId: 'sess-1',
    seq,
    at: 1_700_000_000_000 + seq * 60_000,
    speaker: seq % 2 === 0 ? 'assistant' : 'user',
    text,
    ...extra,
  };
}

/** 已存在的表名集合 */
function tableNames(db) {
  return new Set(prevAll(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
}

function prevAll(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}

function prevGet(db, sql, ...args) {
  return db.prepare(sql).get(...args);
}

/* ============================== 库结构（db.js） ============================== */

test('openDb: 内存库建出全部基础表，且重复建表幂等', () => {
  // loadVec:false —— 单测不碰真实 $DSH_HOME，也不依赖机器上装没装 sqlite-vec
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  const names = tableNames(handle.db);
  for (const t of ['msg', 'scene', 'beat', 'fact', 'media', 'note', 'audit', 'msg_fts', 'window']) {
    assert.ok(names.has(t), `缺表 ${t}`);
  }
  // window_fts 已在 v14 删除（trigram 对 2 字中文词无效，见 schema.sql 注释）
  assert.ok(!names.has('window_fts'), 'window_fts 应当已被删除');
  // 幂等：再跑一次不报错、不重复建
  applySchema(handle.db, { hasVec: false });
  assert.equal(prevAll(handle.db, "SELECT name FROM sqlite_master WHERE name = 'msg'").length, 1);
  // 触发器都在（窗口不再有 FTS 同步触发器）
  const triggers = prevAll(handle.db, "SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name);
  assert.deepEqual(triggers.sort(), ['msg_ad', 'msg_ad_cjk2', 'msg_ai', 'msg_au']);
  handle.close();
});

test('schema: msg 表含 vec_model / vec_dim 两列（D-152）', () => {
  const { db, handle } = fresh();
  const cols = prevAll(db, 'PRAGMA table_info(msg)').map((c) => c.name);
  assert.ok(cols.includes('vec_model'), '缺 vec_model');
  assert.ok(cols.includes('vec_dim'), '缺 vec_dim');
  assert.ok(cols.includes('in_surface'));
  assert.ok(cols.includes('compacted_at'));
  handle.close();
});

test('schema: splitSchema 能切出向量段，没有 vec 扩展时跳过不报错', () => {
  const { base, vec } = splitSchema(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'));
  assert.ok(base.includes('CREATE TABLE IF NOT EXISTS msg'));
  assert.ok(base.includes('msg_fts'));
  assert.ok(vec.includes('vec_msg'));
  assert.ok(vec.includes('vec_scene'));
  assert.ok(!base.includes('vec_msg'), '基础段不该包含 vec 表');

  // hasVec=false 时整段跳过：vec0 模块不存在也不该抛
  const dict = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  attachSchema(dict.db, { hasVec: false });
  const names = tableNames(dict.db);
  assert.ok(!names.has('vec_msg'));
  dict.close();
});

/** 小工具：在已有库上再套一次 schema（模拟重复打开） */
function attachSchema(db, opts) {
  applySchema(db, opts);
}

test('db.js: 扩展加载失败只降级不抛（hasVec=false，库仍可用）', () => {
  const handle = openDb({ dbPath: ':memory:', vecDll: join(TMP, 'no-such-vec0.dll'), logger: silent });
  assert.equal(handle.hasVec, false);
  assert.equal(handle.vecDllPath, null);
  assert.ok(handle.warnings.length > 0, '降级必须留下 warning');
  // 库本身照样能写能查
  const r = createRepo(handle.db);
  const id = r.insertMsg(msg(1, '降级也要能用'));
  assert.equal(r.msgsByIds([id]).length, 1);
  handle.close();
});

test('db.js: loadVecExtension 对不存在的文件返回 {ok:false}，不抛', () => {
  const { db, handle } = fresh();
  const result = loadVecExtension(db, join(TMP, 'nope.dll'));
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  handle.close();
});

test('db.js: 建库后 user_version 标成 SCHEMA_VERSION，库比代码新时只告警', () => {
  const handle = openDb({ dbPath: ':memory:', loadVec: false, logger: silent });
  assert.equal(prevGet(handle.db, 'PRAGMA user_version').user_version, SCHEMA_VERSION);
  // 模拟"库比代码新"：把版本调到未来，重开只告警、不破坏
  handle.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 9}`);
  const warnings = [];
  const v = migrate(handle.db, { logger: silent, warnings });
  assert.equal(v, SCHEMA_VERSION + 9);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /比本代码/);
  handle.close();
});

test('db.js: openDb 打开连接就套好 D-199 调优（64MB 页缓存 + 256MB mmap）', () => {
  const file = join(TMP, 'tuning.db');
  const handle = openDb({ dbPath: file, loadVec: false, logger: silent });
  // 负数是 KiB：-65536 → 64MB。默认 2MB 装不下 34MB 向量页（索引构建差 13~15 倍）
  assert.equal(prevGet(handle.db, 'PRAGMA cache_size').cache_size, -TUNING.cacheSizeKb);
  assert.equal(prevGet(handle.db, 'PRAGMA mmap_size').mmap_size, TUNING.mmapSizeBytes);
  handle.close();
});

test('db.js: 老库（v1）打开时自动补 msg.excluded / scene 派生列 / flag 表，升到最新版', () => {
  const file = join(TMP, 'old-v1.db');
  const sceneCols = [
    'has_excluded',
    'excluded_count',
    'has_out_of_surface',
    'out_of_surface_count',
    'crosses_compaction',
    'compacted_count',
  ];
  // 造一个"v1 的库"：结构等同当前 schema，只是去掉后来加的列与表
  const h1 = openDb({ dbPath: file, loadVec: false, logger: silent });
  createRepo(h1.db).insertMsg(msg(1, '老数据'));
  h1.db.exec('DROP INDEX IF EXISTS idx_msg_excluded');
  h1.db.exec('ALTER TABLE msg DROP COLUMN excluded');
  for (const col of sceneCols) h1.db.exec(`ALTER TABLE scene DROP COLUMN ${col}`);
  h1.db.exec('DROP TABLE IF EXISTS flag'); // v1 也没有 flag 表（v3 才有）
  h1.db.exec('PRAGMA user_version = 1');
  h1.close();

  const h2 = openDb({ dbPath: file, loadVec: false, logger: silent });
  assert.ok(prevAll(h2.db, 'PRAGMA table_info(msg)').some((c) => c.name === 'excluded'), '老库应补上 excluded 列');
  assert.equal(prevGet(h2.db, 'PRAGMA user_version').user_version, SCHEMA_VERSION);
  assert.equal(prevGet(h2.db, 'SELECT excluded FROM msg WHERE id = 1').excluded, 0, '老数据默认不排除');
  assert.equal(
    prevAll(h2.db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_msg_excluded'").length,
    1,
    '索引应随迁移重建',
  );
  const sceneColsNow = prevAll(h2.db, 'PRAGMA table_info(scene)').map((c) => c.name);
  for (const col of sceneCols) assert.ok(sceneColsNow.includes(col), `scene 应补上 ${col}`);
  assert.ok(tableNames(h2.db).has('flag'), 'v3 的 flag 表应补建出来');
  h2.close();
});

test('db.js: 默认路径落在 $DSH_HOME/verbatim 下', () => {
  assert.match(defaultDbPath('/tmp/dsh-home').replaceAll('\\', '/'), /\/tmp\/dsh-home\/verbatim\/memory\.db$/);
  assert.match(
    defaultVecDllPath('/tmp/dsh-home').replaceAll('\\', '/'),
    /\/tmp\/dsh-home\/verbatim\/native\/vec0\.(dll|so|dylib)$/,
  );
});

test('db.js: 文件库会真正落盘，重开数据还在', () => {
  const file = join(TMP, 'persist.db');
  const h1 = openDb({ dbPath: file, loadVec: false, logger: silent });
  createRepo(h1.db).insertMsg(msg(1, '落盘测试'));
  h1.close();
  assert.ok(existsSync(file));
  const h2 = openDb({ dbPath: file, loadVec: false, logger: silent });
  assert.equal(createRepo(h2.db).msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).length, 1);
  h2.close();
});

/* ============================== repo：写入 / 查询 ============================== */

test('repo 接口与 BUILD-PLAN §3.1 完全对齐（一个不多一个不少）', () => {
  const { repo: r, handle } = fresh();
  assert.deepEqual(Object.keys(r).sort(), [
    'beatsByKind',
    'deleteMsgsBySeq',
    // v5 新增（T8 在 pipeline 里留的 TODO 就是这个）：
    // rewind 的精确差集删除必须和向量清理同一个事务，所以只能进 repo，
    // 不能由编排层写裸 SQL。契约从 16 个方法变成 17 个。
    'deleteMsgsBySeqs',
    'factsBySubject',
    'insertBeat',
    'insertMsg',
    'insertMsgs',
    'insertScene',
    'msgsAround',
    'msgsByIds',
    'msgsByScene',
    'msgsByTimeRange',
    'sceneById',
    'scenesByTimeRange',
    'setSceneGist',
    'updateSceneLinks',
    'upsertFact',
  ]);
  handle.close();
});

test('insertMsg / msgsByIds：单条 CRUD 返回 MsgRow camelCase', () => {
  const { repo: r, handle } = fresh();
  const id = r.insertMsg({
    sessionId: 'sess-1',
    seq: 1,
    at: 1_700_000_000_000,
    speaker: 'user',
    text: '其实我有点怕黑',
  });
  assert.equal(typeof id, 'number');
  const [row] = r.msgsByIds([id]);
  assert.deepEqual(
    { ...row },
    {
      id,
      sessionId: 'sess-1',
      seq: 1,
      at: 1_700_000_000_000,
      speaker: 'user',
      text: '其实我有点怕黑',
      inSurface: 1,
      compactedAt: null,
      excluded: 0,
      sceneId: null,
    },
  );
  // 不存在的 id 跳过、顺序跟随入参、重复 id 去重
  const id2 = r.insertMsg(msg(2, '第二句'));
  assert.deepEqual(r.msgsByIds([id2, 999999, id]).map((x) => x.id), [id2, id]);
  assert.deepEqual(r.msgsByIds([]), []);
  handle.close();
});

test('insertMsg：非法 speaker 被拒', () => {
  const { repo: r, handle } = fresh();
  assert.throws(() => r.insertMsg({ ...msg(1, 'x'), speaker: 'system' }), /speaker/);
  handle.close();
});

test('insertMsg：同 (session_id, seq) 幂等 upsert，id 不变', () => {
  const { repo: r, handle } = fresh();
  const id1 = r.insertMsg(msg(1, '旧文本'));
  const id2 = r.insertMsg(msg(1, '新文本'));
  assert.equal(id1, id2, 'upsert 必须复用原 id');
  const rows = r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '新文本');
  handle.close();
});

test('insertMsgs：返回与入参同序 id，空数组返回空', () => {
  const { repo: r, handle } = fresh();
  const ids = r.insertMsgs([msg(1, '第一句'), msg(2, '第二句'), msg(3, '第三句')]);
  assert.equal(ids.length, 3);
  assert.deepEqual(r.msgsByIds(ids).map((x) => x.seq), [1, 2, 3]);
  assert.deepEqual(r.insertMsgs([]), []);
  handle.close();
});

test('insertMsgs：整批一个事务，中间失败全部回滚', () => {
  const { repo: r, handle } = fresh();
  const bad = [msg(1, '合法'), { ...msg(2, '非法'), speaker: 'nobody' }];
  assert.throws(() => r.insertMsgs(bad));
  assert.equal(r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).length, 0, '回滚后一条都不该留');
  handle.close();
});

test('msgsByTimeRange：区间左闭右开，按时间升序，limit 生效', () => {
  const { repo: r, handle } = fresh();
  const rows = [
    msg(1, 'a', { at: 1000 }),
    msg(2, 'b', { at: 2000 }),
    msg(3, 'c', { at: 3000 }),
  ];
  r.insertMsgs(rows);
  const got = r.msgsByTimeRange('sess-1', 2000, 3000);
  assert.deepEqual(got.map((x) => x.seq), [2], 'to 不含、from 含');
  assert.deepEqual(r.msgsByTimeRange('sess-1', 0, 10_000).map((x) => x.seq), [1, 2, 3]);
  assert.deepEqual(r.msgsByTimeRange('sess-1', 0, 10_000, 2).map((x) => x.seq), [1, 2]);
  // sessionId=null 表示不限会话
  r.insertMsg({ ...msg(1, '另一个会话'), sessionId: 'sess-2', at: 4000 });
  assert.equal(r.msgsByTimeRange(null, 0, 10_000).length, 4);
  assert.equal(r.msgsByTimeRange('sess-1', 0, 10_000).length, 3, '按会话隔离');
  handle.close();
});

test('withTx：嵌套用 SAVEPOINT，异常整层回滚；T8 可用来包 scene+assign', () => {
  const { db, repo: r, handle } = fresh();
  withTx(db, () => {
    r.insertMsg(msg(1, 'a'));
    withTx(db, () => r.insertMsg(msg(2, 'b')));
  });
  assert.equal(r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).length, 2);

  assert.throws(() =>
    withTx(db, () => {
      r.insertMsg(msg(3, 'c'));
      throw new Error('boom');
    }),
  );
  assert.equal(r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).length, 2, '外层回滚，不留半条');
  handle.close();
});

test('msgsByScene / msgsAround：场景内取消息、取邻居含自身', () => {
  const { repo: r, handle } = fresh();
  const ids = r.insertMsgs([msg(1, '一'), msg(2, '二'), msg(3, '三'), msg(4, '四'), msg(5, '五')]);
  const sceneId = r.insertScene({
    sessionId: 'sess-1',
    startAt: 1000,
    endAt: 9000,
    msgCount: 2,
  });
  r.updateSceneLinks(sceneId, {});
  // 手动把 seq 2、3 挂到这个场景
  handle.db.prepare('UPDATE msg SET scene_id = ? WHERE id IN (?, ?)').run(sceneId, ids[1], ids[2]);
  assert.deepEqual(r.msgsByScene(sceneId).map((x) => x.seq), [2, 3]);

  const around = r.msgsAround(ids[2], 2, 1);
  assert.deepEqual(around.map((x) => x.seq), [1, 2, 3, 4], '前 2 后 1，含自身，按 seq 升序');
  assert.deepEqual(r.msgsAround(123456, 1, 1), [], '不存在的锚点返回空');
  handle.close();
});

/* ============================== rewind 物理删（D-119） ============================== */

test('deleteMsgsBySeq：物理删除 seq>=X，查不到、FTS 也查不到、beat 级联删', () => {
  const { repo: r, db, handle } = fresh();
  const ids = r.insertMsgs([
    msg(1, '这句留着'),
    msg(2, '这句要撤回'),
    msg(3, '这句也要撤回'),
  ]);
  r.insertBeat(ids[1], 'vuln', 0.9);
  assert.equal(prevAll(db, 'SELECT * FROM beat').length, 1);

  // 先确认 FTS 里有（3 字以上才命中 trigram，2 字用 LIKE）
  assert.equal(prevAll(db, 'SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?', '这句要').length, 1);

  const deleted = r.deleteMsgsBySeq('sess-1', 2);
  assert.equal(deleted, 2);

  // 物理删：raw 表都查不到（不是打标记）
  assert.equal(prevGet(db, 'SELECT COUNT(*) AS c FROM msg').c, 1);
  assert.deepEqual(r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).map((x) => x.seq), [1]);
  // FTS 同步
  assert.equal(prevAll(db, 'SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?', '这句要').length, 0);
  assert.equal(prevGet(db, 'SELECT COUNT(*) AS c FROM msg_fts').c, 1);
  // beat 级联删（ON DELETE CASCADE）
  assert.equal(prevAll(db, 'SELECT * FROM beat').length, 0);
  // 已删的 id 再也取不到
  assert.deepEqual(r.msgsByIds([ids[1], ids[2]]), []);
  // 再删一次是 0，不报错
  assert.equal(r.deleteMsgsBySeq('sess-1', 2), 0);
  handle.close();
});

/* ============================== FTS 触发器同步 ============================== */

test('msg_fts 触发器：insert / update / delete 三向同步', () => {
  const { repo: r, db, handle } = fresh();
  const id = r.insertMsg(msg(1, '其实我有点怕黑，但不想开灯'));
  const match = (term) => prevAll(db, 'SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?', term).length;
  assert.equal(match('有点怕'), 1, 'insert 后应能命中');
  assert.equal(match('不想开灯'), 1);

  db.prepare('UPDATE msg SET text = ? WHERE id = ?').run('其实我一点都不怕了', id);
  assert.equal(match('有点怕'), 0, 'update 后旧词应失效');
  assert.equal(match('一点都不'), 1, 'update 后新词应命中');

  db.prepare('DELETE FROM msg WHERE id = ?').run(id);
  assert.equal(match('一点都不'), 0, 'delete 后应清干净');
  assert.equal(prevGet(db, 'SELECT COUNT(*) AS c FROM msg_fts').c, 0);
  // 外部索引坏了可以 rebuild，不应抛
  db.exec("INSERT INTO msg_fts(msg_fts) VALUES('rebuild')");
  handle.close();
});

/* ============================== 场景（scene） ============================== */

test('insertScene / sceneById / scenesByTimeRange / updateSceneLinks / setSceneGist', () => {
  const { repo: r, db, handle } = fresh();
  const s1 = r.insertScene({
    sessionId: 'sess-1',
    startAt: 1_700_000_000_000,
    endAt: 1_700_000_600_000,
    msgCount: 10,
    createdAt: 42,
  });
  const s2 = r.insertScene({
    sessionId: 'sess-1',
    startAt: 1_700_003_600_000,
    endAt: 1_700_004_000_000,
    msgCount: 6,
  });
  assert.equal(typeof s1, 'number');

  const got = r.sceneById(s1);
  assert.equal(got.id, s1);
  assert.equal(got.sessionId, 'sess-1');
  assert.equal(got.msgCount, 10);
  assert.equal(got.createdAt, 42);
  assert.equal(got.gist, null);
  assert.equal(r.sceneById(999999), null);

  // 时间相交：start_at < to AND end_at >= from
  const hit = r.scenesByTimeRange('sess-1', 1_700_000_500_000, 1_700_000_700_000);
  assert.deepEqual(hit.map((x) => x.id), [s1]);
  assert.deepEqual(r.scenesByTimeRange('sess-1', 0, 1_700_010_000_000).map((x) => x.id), [s1, s2]);
  assert.equal(r.scenesByTimeRange('sess-1', 0, 1_700_010_000_000, 1).length, 1);

  // 邻接回填：只更新传入字段
  r.updateSceneLinks(s2, { precededBy: s1, gapBeforeMs: 3_000_000, leadIn: [{ seq: 9, text: '尾巴' }] });
  r.updateSceneLinks(s1, { followedBy: s2, gapAfterMs: 3_000_000, leadIn: [] });
  const after = r.sceneById(s2);
  assert.equal(after.precededBy, s1);
  assert.equal(after.gapBeforeMs, 3_000_000);
  assert.equal(after.followedBy, null, '没传的字段保持原值');
  assert.deepEqual(JSON.parse(after.leadIn), [{ seq: 9, text: '尾巴' }]);

  // gist 只做检索锚点
  r.setSceneGist(s1, '【发生了什么】他半夜说睡不着');
  assert.equal(r.sceneById(s1).gist, '【发生了什么】他半夜说睡不着');
  assert.equal(r.sceneById(s1).msgCount, 10, 'gist 不影响其它字段');
  handle.close();
});

test('scene 派生字段（D-195）：insertScene 写入、mapScene 原样返回', () => {
  const { repo: r, handle } = fresh();
  const id = r.insertScene({
    sessionId: 'sess-1',
    startAt: 1000,
    endAt: 9000,
    msgCount: 6,
    hasExcluded: true,
    excludedCount: 2,
    hasOutOfSurface: 1,
    outOfSurfaceCount: 3,
    crossesCompaction: true,
    compactedCount: 1,
  });
  const got = r.sceneById(id);
  assert.deepEqual(
    {
      hasExcluded: got.hasExcluded,
      excludedCount: got.excludedCount,
      hasOutOfSurface: got.hasOutOfSurface,
      outOfSurfaceCount: got.outOfSurfaceCount,
      crossesCompaction: got.crossesCompaction,
      compactedCount: got.compactedCount,
    },
    {
      hasExcluded: 1,
      excludedCount: 2,
      hasOutOfSurface: 1,
      outOfSurfaceCount: 3,
      crossesCompaction: 1,
      compactedCount: 1,
    },
  );

  // 不传时全部默认 0（老消费者不用改）
  const plain = r.insertScene({ sessionId: 'sess-1', startAt: 10000, endAt: 20000, msgCount: 2 });
  const p = r.sceneById(plain);
  assert.equal(p.hasExcluded, 0);
  assert.equal(p.excludedCount, 0);
  assert.equal(p.hasOutOfSurface, 0);
  assert.equal(p.outOfSurfaceCount, 0);
  assert.equal(p.crossesCompaction, 0);
  assert.equal(p.compactedCount, 0);

  // 列表接口也一致带出
  const listed = r.scenesByTimeRange('sess-1', 0, 1_000_000).find((s) => s.id === id);
  assert.equal(listed.excludedCount, 2);
  assert.equal(listed.crossesCompaction, 1);
  handle.close();
});

/* ============================== 派生层：fact / beat ============================== */

test('upsertFact：按 (subject,key) 更新不新增，factsBySubject 倒序', () => {
  const { repo: r, handle } = fresh();
  const id1 = r.upsertFact({ subject: 'me', key: '称呼', value: '叫我外号', sourceSeq: 1, origin: 'extracted_from_user', createdAt: 100 });
  const id2 = r.upsertFact({ subject: 'me', key: '称呼', value: '平时叫我外号', sourceSeq: 5, origin: 'extracted_from_user' });
  assert.equal(id1, id2, '同一个 key 应更新而不是新增');

  r.upsertFact({ subject: 'her', key: '怕', value: '打雷', sourceSeq: 7, origin: 'her_claim', createdAt: 200 });
  const meFacts = r.factsBySubject('me');
  assert.equal(meFacts.length, 1);
  assert.equal(meFacts[0].value, '平时叫我外号');
  assert.equal(meFacts[0].sourceSeq, 5);
  assert.equal(meFacts[0].createdAt, 100, '更新不覆盖首次创建时间');
  assert.equal(r.factsBySubject('her').length, 1);
  assert.equal(r.factsBySubject('us').length, 0);
  assert.equal(r.factsBySubject('me', 1).length, 1);

  // schema 层的 subject CHECK 兜底
  assert.throws(() => r.upsertFact({ subject: 'them', key: 'x', value: 'y', sourceSeq: 1, origin: 'x' }));
  handle.close();
});

test('insertBeat / beatsByKind：12 类校验，按消息时间升序', () => {
  const { repo: r, handle } = fresh();
  assert.equal(BEAT_KINDS.length, 12);
  const ids = r.insertMsgs([msg(1, '早'), msg(2, '中'), msg(3, '晚')]);
  r.insertBeat(ids[2], 'vuln', 0.9);
  r.insertBeat(ids[0], 'vuln', 0.55);
  r.insertBeat(ids[1], 'tease', 0.8);
  assert.throws(() => r.insertBeat(ids[0], 'unknown-kind', 0.5), /kind/);

  const vuln = r.beatsByKind('vuln');
  assert.deepEqual(vuln.map((b) => b.msgSeq), [1, 3], '按 msg.at 升序');
  assert.equal(vuln[0].confidence, 0.55);
  assert.equal(vuln[0].msgId, ids[0]);
  assert.equal(vuln[0].sessionId, 'sess-1');
  assert.equal(r.beatsByKind('tease').length, 1);
  assert.equal(r.beatsByKind('vuln', 1).length, 1);
  assert.deepEqual(r.beatsByKind('care'), []);
  handle.close();
});

/* ============================== extras：note / audit（T7 用） ============================== */

test('extras.note：写/列/软删/恢复/过期清理', () => {
  const { extras, handle } = fresh();
  const n1 = extras.note.insert({ content: '今天我自己看了 B 站', about: 'me', at: 1000 });
  const n2 = extras.note.insert({ content: '我自己记的：他喜欢蜡', about: 'him', at: 2000 });
  assert.equal(typeof n1, 'number');

  assert.equal(extras.note.byId(n1).content, '今天我自己看了 B 站');
  assert.equal(extras.note.byId(999999), null);
  assert.deepEqual(extras.note.list().map((n) => n.id), [n2, n1], '新的在前');
  assert.deepEqual(extras.note.list({ about: 'me' }).map((n) => n.id), [n1]);
  assert.deepEqual(extras.note.list({ about: 'him' }).map((n) => n.id), [n2]);

  assert.equal(extras.note.softDelete(n1), true);
  assert.equal(extras.note.softDelete(n1), false, '重复软删返回 false');
  assert.deepEqual(extras.note.list().map((n) => n.id), [n2], '软删后默认不出现');
  assert.deepEqual(extras.note.list({ includeDeleted: true }).map((n) => n.id), [n2, n1]);
  assert.notEqual(extras.note.byId(n1).deletedAt, null, '30 天内可恢复');

  assert.equal(extras.note.restore(n1), true);
  assert.deepEqual(extras.note.list().map((n) => n.id), [n2, n1]);

  // 超过 30 天的软删才物理清
  extras.note.softDelete(n1, 1000);
  assert.equal(extras.note.purgeExpired(30 * 24 * 3600 * 1000, 2000), 0, '未过期不清');
  assert.equal(extras.note.purgeExpired(1, 2000), 1, '过了保留期才清');
  assert.equal(extras.note.byId(n1), null);
  handle.close();
});

test('extras.audit：remember / forget / restore 留痕可查', () => {
  const { extras, handle } = fresh();
  const noteId = extras.note.insert({ content: '一条笔记' });
  const target = `note:${noteId}`;
  extras.audit.insert({ action: 'remember', target, detail: { about: 'him' }, at: 100 });
  extras.note.softDelete(noteId, 200);
  extras.audit.insert({ action: 'forget', target, detail: { reason: 'TA要求忘掉' }, at: 200 });
  extras.note.restore(noteId);
  extras.audit.insert({ action: 'restore', target, at: 300 });

  assert.deepEqual(extras.audit.list().map((a) => a.action), ['restore', 'forget', 'remember']);
  const byTarget = extras.audit.byTarget(target);
  assert.equal(byTarget.length, 3);
  assert.deepEqual(JSON.parse(byTarget[1].detail), { reason: 'TA要求忘掉' });
  handle.close();
});

/* ============================== extras：向量元数据（T6 用） ============================== */

test('extras.vecMeta：记 model/dim、指认 pending、模型不一致时拒绝（D-152）', () => {
  const { repo: r, extras, handle } = fresh();
  const ids = r.insertMsgs([msg(1, '第一'), msg(2, '第二')]);

  const provider = { id: 'sf:Qwen/Qwen3-Embedding-4B@1024', dim: 1024 };
  assert.equal(extras.vecMeta.get().indexed, 0);
  assert.equal(extras.vecMeta.pending({ model: provider.id }).length, 2);
  // 还没建索引时不拦
  extras.vecMeta.assert(provider);

  assert.equal(extras.vecMeta.set([ids[0]], provider), 1);
  const meta = extras.vecMeta.get();
  assert.equal(meta.model, provider.id);
  assert.equal(meta.dim, 1024);
  assert.equal(meta.indexed, 1);
  assert.equal(meta.total, 2);

  // 换了模型：拒绝并提示重建
  assert.throws(
    () => extras.vecMeta.assert({ id: 'sf:bge-m3@1024', dim: 1024 }),
    /向量模型不一致/,
  );
  assert.throws(() => extras.vecMeta.assert({ id: provider.id, dim: 2560 }), /向量模型不一致/);
  // 同一个模型放行
  extras.vecMeta.assert(provider);
  // 换模型后，属于旧模型的消息也算 pending
  assert.equal(extras.vecMeta.pending({ model: 'sf:bge-m3@1024' }).length, 2);
  handle.close();
});

/* ============================== extras：场景挂载（T3 / T8 用） ============================== */

test('extras.sceneAssign：按 id / 按 seq 区间挂载，clear 重建', () => {
  const { repo: r, extras, handle } = fresh();
  const ids = r.insertMsgs([msg(1, 'a'), msg(2, 'b'), msg(3, 'c'), msg(4, 'd')]);
  const s1 = r.insertScene({ sessionId: 'sess-1', startAt: 1000, endAt: 2000, msgCount: 2 });

  assert.equal(extras.sceneAssign.assign([ids[0], ids[1]], s1), 2);
  assert.deepEqual(r.msgsByScene(s1).map((x) => x.seq), [1, 2]);
  assert.equal(extras.sceneAssign.assignSeqRange('sess-1', 3, 4, s1), 2);
  assert.deepEqual(r.msgsByScene(s1).map((x) => x.seq), [1, 2, 3, 4]);

  assert.equal(extras.sceneAssign.unassign(s1), 4);
  assert.deepEqual(r.msgsByScene(s1), []);

  extras.sceneAssign.assignSeqRange('sess-1', 1, 4, s1);
  const cleared = extras.sceneAssign.clear('sess-1');
  assert.deepEqual(cleared, { scenes: 1, msgs: 4 });
  assert.equal(r.sceneById(s1), null);
  // 原文一条不丢
  assert.equal(r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).length, 4);
  handle.close();
});

/* ============================== 默认单例（懒加载） ============================== */

test('repo 单例：懒加载到 $DSH_HOME，方法可直接调', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(TMP, 'home-singleton');
  try {
    // 第一次调用才真正开库
    assert.equal(repo.msgsByIds([]).length, 0);
    const id = repo.insertMsg(msg(1, '单例可用'));
    assert.equal(repo.msgsByIds([id]).length, 1);
    assert.ok(getDefaultRepo());
    closeDefault();
    assert.ok(existsSync(join(TMP, 'home-singleton', 'verbatim', 'memory.db')));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    closeDefault();
  }
});

/* ============================== extras：检索原语（T4 用） ============================== */

test('extras.search.keyword：≤2 字走 LIKE、≥3 字走 FTS、结果带场景时间区间', () => {
  const { repo: r, extras, handle } = fresh();
  const ids = r.insertMsgs([
    msg(1, '其实我有点怕黑，但不想开灯'),
    msg(2, '今天有点怕'),
    msg(3, '睡吧，明天再说'),
  ]);
  const sceneId = r.insertScene({ sessionId: 'sess-1', startAt: 1000, endAt: 2000, msgCount: 2 });
  extras.sceneAssign.assign([ids[0]], sceneId);

  // 两字查询：trigram 匹配不到，必须由 LIKE 兜住（中文最常见的查询就是两个字）
  const short = extras.search.keyword('怕黑');
  assert.equal(short.length, 1);
  assert.equal(short[0].id, ids[0]);
  assert.equal(short[0].sceneStartAt, 1000, '每条结果都要能说出属于哪一场');
  assert.equal(short[0].sceneEndAt, 2000);

  // 四字查询：走 FTS5 trigram
  const fts = extras.search.keyword('不想开灯');
  assert.equal(fts.length, 1);
  assert.equal(fts[0].id, ids[0]);
  assert.equal(extras.search.keyword('有点怕').length, 2, '跨两条命中');
  assert.equal(extras.search.keyword('有点怕', { limit: 1 }).length, 1);
  assert.equal(extras.search.keyword('不存在的词').length, 0);

  // 边界：空查询、带引号（FTS 语法炸弹）、会话/时间过滤
  assert.deepEqual(extras.search.keyword('   '), []);
  assert.doesNotThrow(() => extras.search.keyword('"'));
  assert.equal(extras.search.keyword('有点怕', { from: 0, to: 10 }).length, 0);
  assert.equal(extras.search.keyword('有点怕', { sessionId: 'other' }).length, 0);
  handle.close();
});

test('extras.stats：空结果时能报出库的范围（不是空白）', () => {
  const { repo: r, extras, handle } = fresh();
  assert.deepEqual(
    { ...extras.stats.get() },
    { msgs: 0, scenes: 0, notes: 0, chars: 0, excludedMsgs: 0, excludedChars: 0, firstAt: null, lastAt: null },
  );
  r.insertMsgs([msg(1, 'a', { at: 100 }), msg(2, 'bb', { at: 200 })]);
  r.insertScene({ sessionId: 'sess-1', startAt: 100, endAt: 200, msgCount: 2 });
  extras.note.insert({ content: 'n1' });
  assert.deepEqual(
    { ...extras.stats.get() },
    { msgs: 2, scenes: 1, notes: 1, chars: 3, excludedMsgs: 0, excludedChars: 0, firstAt: 100, lastAt: 200 },
  );
  handle.close();
});

/* ============================== 软排除（D-169 / D-170） ============================== */

test('excluded：写入 / 幂等重导保留旧标记 / 显式 0 可撤销', () => {
  const { repo: r, db, handle } = fresh();
  const id = r.insertMsg(msg(1, '11-08 的调试内容', { excluded: 1 }));
  assert.equal(prevGet(db, 'SELECT excluded FROM msg WHERE id = ?', id).excluded, 1);

  // 重导时没带 excluded：保留库里的旧值（重跑日志不会把已排除的又放出来）
  assert.equal(r.insertMsg(msg(1, '11-08 的调试内容')), id);
  assert.equal(prevGet(db, 'SELECT excluded FROM msg WHERE id = ?', id).excluded, 1);

  // 显式传 0 = 撤销排除（D-169 可逆）
  r.insertMsg(msg(1, '11-08 的调试内容', { excluded: 0 }));
  assert.equal(prevGet(db, 'SELECT excluded FROM msg WHERE id = ?', id).excluded, 0);

  // 批量插入也认这个字段（snake_case 同样接受）
  const ids = r.insertMsgs([
    msg(2, 'a', { excluded: 1 }),
    msg(3, 'b', { excluded: false }),
    { ...msg(4, 'c'), excluded: 1 },
  ]);
  assert.deepEqual(
    prevAll(db, 'SELECT excluded FROM msg WHERE id IN (?,?,?) ORDER BY id', ...ids).map((x) => x.excluded),
    [1, 0, 1],
  );
  // 读回来的 MsgRow 带 excluded
  assert.equal(r.msgsByIds([ids[0]])[0].excluded, 1);
  handle.close();
});

test('excluded：三个检索方法默认查不到，includeExcluded 才查得到', () => {
  const { repo: r, extras, handle } = fresh();
  const ids = r.insertMsgs([
    msg(1, '某条测试文本 这是第一天的'),
    msg(2, '明天见 这是 11-09 的'),
    msg(3, '晚安'),
  ]);
  r.insertMsg({ ...msg(1, '某条测试文本 这是第一天的'), excluded: 1 }); // 把 11-08 那条排除

  // 时间路
  assert.deepEqual(
    r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).map((m) => m.seq),
    [2, 3],
    '默认跳过 excluded',
  );
  assert.deepEqual(
    r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER, 500, true).map((m) => m.seq),
    [1, 2, 3],
    'includeExcluded=true 时带出来',
  );

  // 场景路
  const sceneId = r.insertScene({ sessionId: 'sess-1', startAt: 0, endAt: 9e15, msgCount: 3 });
  extras.sceneAssign.assign(ids, sceneId);
  assert.deepEqual(r.msgsByScene(sceneId).map((m) => m.seq), [2, 3]);
  assert.deepEqual(r.msgsByScene(sceneId, true).map((m) => m.seq), [1, 2, 3]);

  // 关键词路（FTS 与 LIKE 两条都过滤）
  assert.equal(extras.search.keyword('某条测试文本').length, 0);
  assert.equal(extras.search.keyword('某条测试文本', { includeExcluded: true }).length, 1);
  assert.equal(extras.search.keyword('某条').length, 0, '两字路径（LIKE）也要过滤');
  assert.equal(extras.search.keyword('某条', { includeExcluded: true }).length, 1);
  assert.equal(extras.search.keyword('明天见').length, 1, '正常消息照旧能查');

  // msgsByIds 不过滤：T7 判断 id 是不是一条 msg 时要看得见被排除的行
  assert.equal(r.msgsByIds([ids[0]])[0].excluded, 1);

  // 向量索引默认不给被排除的烧 embedding（D-169）
  assert.deepEqual(extras.vecMeta.pending({ limit: 10 }).map((m) => m.seq), [2, 3]);
  assert.deepEqual(extras.vecMeta.pending({ limit: 10, includeExcluded: true }).map((m) => m.seq), [1, 2, 3]);
  handle.close();
});

test('msgsAround：先按 seq 取 N 条再过滤 excluded（不跨段），锚点照返回', () => {
  const { repo: r, handle } = fresh();
  const ids = r.insertMsgs([msg(1, '一'), msg(2, '二'), msg(3, '三'), msg(4, '四'), msg(5, '五')]);
  r.insertMsg({ ...msg(2, '二'), excluded: 1 });
  r.insertMsg({ ...msg(3, '三'), excluded: 1 });

  // 锚点被排除（seq3）：窗口 [2,3,4] → 过滤 2 → [3,4]，锚点照返回
  assert.deepEqual(r.msgsAround(ids[2], 1, 1).map((m) => m.seq), [3, 4]);
  // 核实模式：窗口原样带回
  assert.deepEqual(r.msgsAround(ids[2], 1, 1, true).map((m) => m.seq), [2, 3, 4]);

  // 锚点正常（seq4），前 2 条（seq2、seq3）全被排除：
  // 关键断言 —— 不能跨过它们去拿 seq1 当"前文"，结果是只剩锚点一条
  assert.deepEqual(r.msgsAround(ids[3], 2, 0).map((m) => m.seq), [4]);
  // 后一条正常 → [4,5]
  assert.deepEqual(r.msgsAround(ids[3], 2, 1).map((m) => m.seq), [4, 5]);
  // 核实模式把整段带出来
  assert.deepEqual(r.msgsAround(ids[3], 2, 1, true).map((m) => m.seq), [2, 3, 4, 5]);

  // 锚点不存在 → 空
  assert.deepEqual(r.msgsAround(999999, 1, 1), []);
  handle.close();
});

test('extras.stats：excludedMsgs / excludedChars 是 msgs / chars 的子集（D-170）', () => {
  const { repo: r, extras, handle } = fresh();
  r.insertMsgs([
    msg(1, 'abc', { at: 100 }), // 3 字
    msg(2, 'de', { at: 200, excluded: 1 }), // 2 字，排除
    msg(3, 'fghij', { at: 300, excluded: 1 }), // 5 字，排除
  ]);
  const st = extras.stats.get();
  assert.equal(st.msgs, 3);
  assert.equal(st.chars, 10);
  assert.equal(st.excludedMsgs, 2);
  assert.equal(st.excludedChars, 7);
  assert.equal(st.msgs - st.excludedMsgs, 1, '可检索条数');
  handle.close();
});

test('extras.search.keyword：LIMIT 是「过滤后 N 条」，被排除的不占名额', () => {
  const { repo: r, extras, handle } = fresh();
  // 8 条命中，其中 5 条被排除；未排除的只有 3 条
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    rows.push(msg(i, `不想开灯 第${i}条`, { excluded: i <= 5 ? 1 : 0 }));
  }
  r.insertMsgs(rows);

  // 过滤发生在 SQL 的 WHERE 里，所以在 LIMIT 之前 —— 不会出现"搜出 0 条"的假空
  assert.equal(extras.search.keyword('不想开灯', { limit: 2 }).length, 2, '应是 2 条正常结果，不是 0 条');
  assert.deepEqual(
    extras.search.keyword('不想开灯', { limit: 3 }).map((m) => m.excluded),
    [0, 0, 0],
  );
  assert.equal(extras.search.keyword('不想开灯', { limit: 10 }).length, 3);
  // 核实模式才能看到全部 8 条
  assert.equal(extras.search.keyword('不想开灯', { limit: 10, includeExcluded: true }).length, 8);
  // 两字 LIKE 路径口径相同
  assert.equal(extras.search.keyword('开灯', { limit: 2 }).length, 2);
  assert.equal(extras.search.keyword('开灯', { limit: 10, includeExcluded: true }).length, 8);
  handle.close();
});

test('extras.search.countKeyword：与 keyword 同源过滤，M / N 不会对不上（D-196）', () => {
  const { repo: r, extras, handle } = fresh();
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    rows.push(msg(i, `不想开灯 第${i}条`, { excluded: i <= 5 ? 1 : 0 }));
  }
  r.insertMsgs(rows);

  assert.equal(extras.search.countKeyword('不想开灯'), 3, '默认不含被排除的');
  assert.equal(extras.search.countKeyword('不想开灯', { includeExcluded: true }), 8);
  // 与 keyword 的真实返回条数一致（同源过滤）
  assert.equal(extras.search.countKeyword('不想开灯'), extras.search.keyword('不想开灯', { limit: 100 }).length);
  // limit 不影响总数
  assert.equal(extras.search.countKeyword('不想开灯', { limit: 1 }), 3);
  // 两字 LIKE 路径
  assert.equal(extras.search.countKeyword('开灯'), 3);
  assert.equal(extras.search.countKeyword('开灯', { includeExcluded: true }), 8);
  // 边界
  assert.equal(extras.search.countKeyword('   '), 0);
  assert.equal(extras.search.countKeyword('不存在的内容'), 0);
  assert.equal(extras.search.countKeyword('"'), 0, 'FTS 语法炸弹不抛');
  assert.equal(extras.search.countKeyword('不想开灯', { sessionId: 'other' }), 0);
  assert.equal(extras.search.countKeyword('不想开灯', { from: 0, to: 10 }), 0);
  handle.close();
});

test('extras.note.list：offset 分页（D-196）', () => {
  const { extras, handle } = fresh();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(extras.note.insert({ content: `笔记${i}`, at: 1000 + i }));
  const ordered = [...ids].reverse(); // 按 at 倒序

  assert.deepEqual(extras.note.list({ limit: 2 }).map((n) => n.id), ordered.slice(0, 2));
  assert.deepEqual(extras.note.list({ limit: 2, offset: 2 }).map((n) => n.id), ordered.slice(2, 4));
  assert.deepEqual(extras.note.list({ limit: 10, offset: 10 }), []);
  // 与 about / includeDeleted 组合仍正常
  const selfNote = extras.note.insert({ content: '我自己的', about: 'me', at: 5000 });
  assert.equal(extras.note.list({ about: 'me', limit: 1, offset: 0 })[0].id, selfNote);
  handle.close();
});

/* ============================== 标记（D-167 / D-168） ============================== */

test('extras.flag：只留痕不影响检索，可同 msg 多条，按 at 倒序，可取消', () => {
  const { repo: r, extras, handle } = fresh();
  const ids = r.insertMsgs([msg(1, '其实我有点怕黑'), msg(2, '晚安')]);

  const f1 = extras.flag.insert({ msgId: ids[0], reason: '库与日志不一致', at: 100 });
  const f2 = extras.flag.insert({ msgId: ids[0], reason: '第二条标记', at: 200 });
  assert.equal(extras.flag.count(), 2);
  assert.equal(extras.flag.count({ openOnly: true }), 2);

  const list = extras.flag.list();
  assert.deepEqual(list.map((f) => f.id), [f2, f1], '同一 msg 的多条标记按 at 倒序');
  assert.equal(list[0].msgId, ids[0]);
  assert.equal(list[0].sessionId, 'sess-1');
  assert.equal(list[0].msgSeq, 1);
  assert.equal(list[0].resolvedAt, null);
  assert.equal(list[0].reason, '第二条标记');

  // D-167：标记不影响任何检索、不删任何东西
  assert.equal(extras.search.keyword('有点怕黑').length, 1);
  assert.equal(r.msgsByTimeRange('sess-1', 0, Number.MAX_SAFE_INTEGER).length, 2);

  // 取消标记（重复取消返回 false）
  assert.equal(extras.flag.resolve(f1), true);
  assert.equal(extras.flag.resolve(f1), false);
  assert.equal(extras.flag.count({ openOnly: true }), 1);
  assert.equal(extras.flag.count(), 2, '取消不等于删除');
  assert.equal(extras.flag.list({ openOnly: true }).length, 1);
  assert.notEqual(extras.flag.list().find((f) => f.id === f1).resolvedAt, null);

  // 按会话过滤
  const other = r.insertMsg({ ...msg(1, '别的会话'), sessionId: 'sess-2' });
  extras.flag.insert({ msgId: other, reason: 'x' });
  assert.equal(extras.flag.count({ sessionId: 'sess-2' }), 1);
  assert.equal(extras.flag.list({ sessionId: 'sess-1' }).length, 2);

  // 不存在的 msgId 被外键拦下（不会留孤儿标记）
  assert.throws(() => extras.flag.insert({ msgId: 999999, reason: 'x' }), /FOREIGN KEY|constraint/i);

  // rewind 物理删时标记随 ON DELETE CASCADE 一起消失
  assert.equal(r.deleteMsgsBySeq('sess-2', 1), 1);
  assert.equal(extras.flag.count({ sessionId: 'sess-2' }), 0);
  handle.close();
});

/* ============================== sqlite-vec（有扩展才跑） ============================== */

test('sqlite-vec：vec 表能建、BigInt 主键能插、KNN 能查、物理删会清向量', async (t) => {
  const source = findVecSource();
  if (!source) {
    t.skip('没找到 vec0 扩展（可用 VERBATIM_VEC_DLL 指定，或 npm i sqlite-vec）');
    return;
  }

  // ensureVecDll 会复制到 $DSH_HOME/verbatim/native/（D-149 坑③）
  const dshHome = join(TMP, 'home-vec');
  const copied = ensureVecDll({ vecDll: source, dshHome });
  assert.ok(copied, 'ensureVecDll 应返回真实可加载路径');
  assert.equal(copied, defaultVecDllPath(dshHome), '应落到 native/vec0.dll');

  const handle = openDb({ dbPath: ':memory:', dshHome, vecDll: source, logger: silent });
  assert.equal(handle.hasVec, true, 'sqlite-vec 应加载成功');
  try {
    const names = tableNames(handle.db);
    assert.ok(names.has('vec_msg'), '缺 vec_msg');
    assert.ok(names.has('vec_scene'), '缺 vec_scene');

    const r = createRepo(handle.db);
    const id = r.insertMsg(msg(1, '向量测试'));

    // 1024 维随机向量
    const vec = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i / 7) * 0.1);
    const blob = new Uint8Array(vec.buffer.slice(0));

    // 坑②：主键必须是 BigInt
    handle.db.prepare('INSERT INTO vec_msg (msg_id, emb) VALUES (?, ?)').run(BigInt(id), blob);
    assert.throws(
      () => handle.db.prepare('INSERT INTO vec_msg (msg_id, emb) VALUES (?, ?)').run(id + 1000, blob),
      /Only integers are allows/i,
      'Number 主键应被 vec0 拒绝（D-149 坑②）',
    );

    const q = new Uint8Array(Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i / 7) * 0.1).buffer);
    const knn = handle.db
      .prepare('SELECT msg_id, distance FROM vec_msg WHERE emb MATCH ? AND k = ?')
      .all(q, 5);
    assert.equal(knn.length, 1);
    assert.equal(Number(knn[0].msg_id), id);

    // repo 物理删时必须一并清向量，否则向量路会召回已撤回的话（D-119）
    assert.equal(r.deleteMsgsBySeq('sess-1', 1), 1);
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS c FROM vec_msg').get().c, 0);
  } finally {
    handle.close();
  }
});


