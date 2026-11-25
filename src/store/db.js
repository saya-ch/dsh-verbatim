// @ts-check
/**
 * 打开记忆库 —— 建库、装扩展、幂等建表
 *
 * 对外只有一个主入口 `openDb()`，返回：
 *   {
 *     db,          // node:sqlite 的 DatabaseSync 实例（T6 的 vector-store 要直接用）
 *     dbPath,      // 实际库路径（':memory:' 也支持，测试用）
 *     dshHome,
 *     hasVec,      // sqlite-vec 是否加载成功
 *     vecDllPath,  // 从哪个真实路径加载的（失败为 null）
 *     warnings,    // string[]，降级原因都记在这里
 *     close(),     // 关闭库
 *   }
 *
 * 三条硬规则（都来自实测）：
 * ① 必须 `new DatabaseSync(path, { allowExtension: true })`，
 *    否则 loadExtension 报 "extension loading is not allowed"（D-149 坑①）。
 * ② asar 内的 .dll 加载不了，必须先复制到 `$DSH_HOME/verbatim/native/vec0.dll`
 *    再从真实路径加载（D-149 坑③）。这里做"没就复制"。
 * ③ 加载失败绝不能抛：退回暴力余弦，接口层不感知（IMPLEMENTATION.md §1 降级路径）。
 */

import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录（src/store） */
const STORE_DIR = dirname(fileURLToPath(import.meta.url));

/** 扩展文件名：按平台取 */
const EXT_FILE_NAME =
  process.platform === 'win32'
    ? 'vec0.dll'
    : process.platform === 'darwin'
      ? 'vec0.dylib'
      : 'vec0.so';

/** sqlite-vec 的平台包名后缀（npm 包的打包约定） */
const PLATFORM_TAG =
  process.platform === 'win32'
    ? `windows-${process.arch}`
    : `${process.platform}-${process.arch}`;

/** schema.sql 路径 */
const SCHEMA_PATH = join(STORE_DIR, 'schema.sql');

/** 向量索引段的分隔标记（schema.sql 里成对出现） */
const VEC_BEGIN = '-- @@vec-begin';
const VEC_END = '-- @@vec-end';

const require = createRequire(import.meta.url);

/**
 * 取 DSH_HOME。Electron 里由宿主注入环境变量，命令行下回退到 ~/.dsh。
 * @param {string} [override]
 * @returns {string}
 */
export function resolveDshHome(override) {
  if (override) return pathResolve(override);
  if (process.env.DSH_HOME) return pathResolve(process.env.DSH_HOME);
  return join(homedir(), '.dsh');
}

/** 默认库路径：$DSH_HOME/verbatim/memory.db */
export function defaultDbPath(dshHome) {
  return join(resolveDshHome(dshHome), 'verbatim', 'memory.db');
}

/** 默认扩展落地路径：$DSH_HOME/verbatim/native/vec0.dll */
export function defaultVecDllPath(dshHome) {
  return join(resolveDshHome(dshHome), 'verbatim', 'native', EXT_FILE_NAME);
}

/**
 * 找 vec0 扩展的「源文件」候选。只负责找，不负责复制。
 * 顺序：显式指定 → 环境变量 → 扩展落地路径 → 包内自带 → node_modules 里的平台包。
 *
 * @param {{ vecDll?: string, dshHome?: string, forceCopy?: boolean }} [opts]
 * @returns {string|null}
 */
export function findVecSource(opts = {}) {
  // 显式指定就只认它：找不到算没有，不悄悄换成别的文件（否则「显式关掉」会失效）
  if (opts.vecDll) return isRealFile(opts.vecDll) ? opts.vecDll : null;

  const candidates = [];
  if (process.env.VERBATIM_VEC_DLL) candidates.push(process.env.VERBATIM_VEC_DLL);

  const nativePath = defaultVecDllPath(opts.dshHome);
  candidates.push(nativePath);

  // 插件包内自带的原生文件（打包时随 bundle 走，可能在 store 同级或上一级）
  candidates.push(join(STORE_DIR, 'native', EXT_FILE_NAME));
  candidates.push(join(STORE_DIR, '..', 'native', EXT_FILE_NAME));
  candidates.push(join(STORE_DIR, '..', '..', 'native', EXT_FILE_NAME));

  for (const c of candidates) {
    if (c && isRealFile(c)) return c;
  }

  // sqlite-vec 官方包的跨平台解析（支持 npm optionalDependencies 与 Electron unpacked）
  try {
    const pkg = require('sqlite-vec');
    const loadable = typeof pkg?.getLoadablePath === 'function' ? pkg.getLoadablePath() : null;
    if (loadable) {
      const unpacked = loadable.includes('app.asar') ? loadable.replace('app.asar', 'app.asar.unpacked') : null;
      if (unpacked && isRealFile(unpacked)) return unpacked;
      if (isRealFile(loadable)) return loadable;
    }
  } catch {
    // 没装主包就继续按平台子包探测
  }

  // node_modules 里的平台包（开发期/测试期最常见）
  try {
    const resolved = require.resolve(`sqlite-vec-${PLATFORM_TAG}/${EXT_FILE_NAME}`);
    const unpacked = resolved.includes('app.asar') ? resolved.replace('app.asar', 'app.asar.unpacked') : null;
    if (unpacked && isRealFile(unpacked)) return unpacked;
    if (isRealFile(resolved)) return resolved;
  } catch {
    // 没装就往下走
  }
  // 从 store 目录一路向上找 node_modules，兼容"装了但不在当前 cwd"的情况
  let dir = STORE_DIR;
  for (let i = 0; i < 8; i++) {
    const guess = join(dir, 'node_modules', `sqlite-vec-${PLATFORM_TAG}`, EXT_FILE_NAME);
    if (isRealFile(guess)) return guess;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 确保扩展落在可加载的真实路径上，返回该路径（找不到返回 null）。
 *
 * 为什么必须复制：DSH 是 asar 打包，虚拟文件系统里的 .dll 不能 loadExtension。
 * 目标已存在且非空就复用（避免每次启动都写盘）。
 *
 * @param {{ vecDll?: string, dshHome?: string, forceCopy?: boolean }} [opts]
 * @returns {string|null}
 */
export function ensureVecDll(opts = {}) {
  const target = defaultVecDllPath(opts.dshHome);
  const source = findVecSource(opts);
  // 已经复制过且未强制刷新、且源文件体积一致（或无独立源文件）时直接复用
  if (!opts.vecDll && !opts.forceCopy && isRealFile(target)) {
    if (!source || pathResolve(source) === pathResolve(target)) return target;
    try {
      if (statSync(source).size === statSync(target).size) return target;
    } catch {
      return target;
    }
  }

  if (!source) return !opts.vecDll && isRealFile(target) ? target : null;

  if (pathResolve(source) === pathResolve(target)) return target;

  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    return isRealFile(target) ? target : null;
  } catch {
    // 复制失败（只读目录等）：退而求其次，直接加载源文件。
    // 在 asar 内这条路会失败，但至少不会因为复制不了就连库都打不开。
    return isRealFile(source) ? source : null;
  }
}

/**
 * 尝试加载 sqlite-vec。永不抛异常。
 * @param {DatabaseSync} db
 * @param {string|null} dllPath
 * @returns {{ ok: boolean, error?: string }}
 */
export function loadVecExtension(db, dllPath) {
  if (!dllPath) return { ok: false, error: `没找到 vec0 扩展文件（${EXT_FILE_NAME}）` };
  try {
    db.loadExtension(dllPath);
    // 探活：只有能查到版本号才算真的加载成功
    db.prepare('SELECT vec_version() AS v').get();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 读 schema.sql 并切分成「基础段」和「向量段」。
 *
 * 为什么切分：vec0 是虚拟表，模块没加载时 `CREATE VIRTUAL TABLE ... vec0(...)`
 * 直接报 "no such module: vec0"，光加 IF NOT EXISTS 压不住。所以按标记切，
 * 加载失败就整段不执行。
 *
 * @param {string} [schemaText]
 * @returns {{ base: string, vec: string }}
 */
export function splitSchema(schemaText = readFileSync(SCHEMA_PATH, 'utf8')) {
  const beginAt = schemaText.indexOf(VEC_BEGIN);
  const endAt = schemaText.indexOf(VEC_END);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    return { base: schemaText, vec: '' };
  }
  const base = schemaText.slice(0, beginAt);
  const vec = schemaText.slice(beginAt + VEC_BEGIN.length, endAt);
  return { base, vec };
}

/**
 * 幂等建表。已有的表/索引/触发器一律跳过。
 *
 * @param {DatabaseSync} db
 * @param {{ hasVec?: boolean, dim?: number }} [opts]
 *   dim —— vec0 表的向量维度。schema.sql 里默认写的是 `float[1024]`，
 *          这里按需替换成模型实际维度（例如 2560）。
 *          **注意**：已有表的维度是建表时定死的，改维度必须重建库 —— 这里的替换只对
 *          新建的表生效，不会静默改动已有表结构。
 */
export function applySchema(db, opts = {}) {
  const { base, vec } = splitSchema();
  db.exec(base);
  if (opts.hasVec && vec.trim()) {
    const dim = Number(opts.dim);
    const vecSql = Number.isInteger(dim) && dim > 0
      ? vec.replace(/float\[1024\]/g, `float[${dim}]`)
      : vec;
    db.exec(vecSql);
  }
}

/**
 * 读取已有 vec_msg 虚表的维度（未建表返回 null）。
 * @param {DatabaseSync} db
 * @returns {number|null}
 */
export function getVecTableDim(db) {
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_msg'")
      .get();
    const m = /float\[(\d+)\]/i.exec(String(row?.sql ?? ''));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 当用户切换了非 1024 维的 Embedding 模型并执行向量重建时，按新维度重建 vec0 虚表，
 * 并清理旧模型维度标记，确保不会被旧表 float[1024] 硬锁死。
 *
 * @param {DatabaseSync} db
 * @param {number} dim
 * @param {{ hasVec?: boolean }} [opts]
 * @returns {boolean} 是否实际执行了重建
 */
export function recreateVecTables(db, dim, opts = {}) {
  const targetDim = Math.trunc(Number(dim));
  if (!Number.isInteger(targetDim) || targetDim <= 0) return false;
  if (!opts.hasVec) return false;
  const currentDim = getVecTableDim(db);
  if (currentDim === targetDim) return false;

  const { vec } = splitSchema();
  if (!vec.trim()) return false;

  for (const tbl of ['vec_msg', 'vec_scene', 'vec_chunk', 'vec_note', 'vec_window']) {
    try { db.exec(`DROP TABLE IF EXISTS ${tbl}`); } catch { /* ignore */ }
  }
  const vecSql = vec.replace(/float\[1024\]/g, `float[${targetDim}]`);
  db.exec(vecSql);
  try { db.exec('UPDATE msg SET vec_model = NULL, vec_dim = NULL WHERE vec_dim IS NOT NULL AND vec_dim != ' + targetDim); } catch { /* ignore */ }
  try { db.exec('UPDATE window SET vec_model = NULL, vec_dim = NULL WHERE vec_dim IS NOT NULL AND vec_dim != ' + targetDim); } catch { /* ignore */ }
  return true;
}

/**
 * schema.sql 的结构版本。加字段/加表时 +1，并在 MIGRATIONS 里补一步。
 *
 * v5：msg / scene 主键加 AUTOINCREMENT（D-118：rewind 删掉的 id 不能复用，
 *     否则向量表里的旧向量会认到新消息上，撤回的话就复活了）。
 * v6：note 增加 session_id（A1 会话隔离）。没有它，TA自己在 A 会话记的笔记
 *     会出现在 B 会话的检索结果里，甚至能被 B 会话的 memory_forget 删掉。
 * v10：note.about 从用户视角（me/her/us）修正为 Agent 第一人称视角（me/him/us）。
 */
export const SCHEMA_VERSION = 16;

/** 连接级调优（D-199 / D-198）：每次 openDb 都要重设，pragma 不落库 */
export const TUNING = Object.freeze({
  /** 页缓存 64MB（负数是 KiB）。默认 2MB 装不下 34MB 向量页：索引构建 457ms → 7.3~8.0s（D-199） */
  cacheSizeKb: 65536,
  /** 内存映射 256MB：对顺序扫描有帮助；对 KNN 没救（D-198），但加上无害 */
  mmapSizeBytes: 268435456,
});

/**
 * 给一个连接套上 PRAGMA 调优。失败只告警不抛——旧版本 SQLite 或受限文件系统
 * 可能不认这些 pragma，不能因此连库都打不开。
 *
 * @param {DatabaseSync} db
 * @param {{ logger?: { warn(msg: string): void }, warnings?: string[] }} [opts]
 */
export function applyTuning(db, opts = {}) {
  const warnings = opts.warnings ?? [];
  const logger = opts.logger ?? { warn: (m) => console.warn(m) };
  const set = (sql) => {
    try {
      db.exec(sql);
    } catch (error) {
      const msg = `连接调优失败（可忽略）：${sql} — ${error?.message ?? error}`;
      warnings.push(msg);
      logger.warn(`[verbatim] ${msg}`);
    }
  };
  set(`PRAGMA cache_size = -${TUNING.cacheSizeKb}`);
  set(`PRAGMA mmap_size = ${TUNING.mmapSizeBytes}`);
}

/**
 * 迁移步骤：MIGRATIONS[n] 负责把版本 n 升到 n+1。
 * 每一步都必须幂等（重复执行不报错）—— 半途崩掉后下次打开能接着补。
 */
const MIGRATIONS = [
  // v0 → v1：结构全部由幂等建表（applySchema）补齐，这一步没有额外动作
  () => {},
  // v1 → v2：msg 增加 excluded（D-169/170 软排除）
  (db) => {
    // 新库还没有 msg 表（migrate 跑在 applySchema 之前）：什么都不用做，
    // schema.sql 里的 CREATE TABLE 已经带 excluded 了。
    // 注意不能直接 PRAGMA table_info(msg)：表不存在时 prepare 阶段就会报 no such table。
    const hasMsgTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'msg'")
      .get();
    if (!hasMsgTable) return;
    const cols = db.prepare('PRAGMA table_info(msg)').all().map((c) => c.name);
    if (!cols.includes('excluded')) {
      db.exec('ALTER TABLE msg ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0');
    }
  },
  // v2 → v3：新增 flag 表（D-167/168）
  // 纯建表，交给 applySchema 的 CREATE TABLE IF NOT EXISTS；这里不需要 ALTER。
  () => {},
  // v3 → v4：scene 增加 T3 的派生字段（D-195）
  // 这些字段每个消费者都要用，必须在库里，不能每次自己算（口径容易不一致）。
  (db) => {
    const hasSceneTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scene'")
      .get();
    if (!hasSceneTable) return; // 新库：schema.sql 直接建出带这些列的表
    const cols = new Set(db.prepare('PRAGMA table_info(scene)').all().map((c) => c.name));
    for (const col of [
      'has_excluded',
      'excluded_count',
      'has_out_of_surface',
      'out_of_surface_count',
      'crosses_compaction',
      'compacted_count',
    ]) {
      if (!cols.has(col)) db.exec(`ALTER TABLE scene ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
  },
  // v4 → v5：msg / scene 的主键加 AUTOINCREMENT（D-118）
  //
  // 为什么非改不可：没有 AUTOINCREMENT 时 SQLite 会复用被删行的 rowid。
  // rewind 物理删掉 #3 → 下一条新消息拿到 id=3 → vec_msg / vec_fallback_msg 里
  // #3 的旧向量就挂到这条无关的新消息上了（向量路让撤回的话复活，实测 score=1.0）。
  //
  // SQLite 改不了主键，只能重建表。安全做法（官方 12 步的简化版）：
  //   ① 关 foreign_keys（必须在事务**之前**；事务内是 no-op）
  //      —— 否则 DROP TABLE msg 会顺着 ON DELETE CASCADE 把 beat / media / flag 清空
  //   ② 用**库里现存的 DDL** 生成新表名（不手抄 schema.sql，避免和后来加的列漂移）
  //   ③ INSERT INTO new SELECT * FROM old —— 两边列顺序一致，id 原样保留
  //      （id 不变，所以 msg_fts 这个 external content 表的 rowid 仍然对得上）
  //   ④ DROP 旧表 → RENAME → 开 foreign_keys → foreign_key_check
  // 索引 / 触发器（含 FTS 的三个触发器）由 DROP TABLE 带走，
  // 随后 applySchema 里的 CREATE ... IF NOT EXISTS 会重建。
  //
  // 幂等：DDL 里已经有 AUTOINCREMENT 就直接跳过（第二次跑什么都不做）。
  (db, ctx) => {
    for (const table of ['scene', 'msg']) rebuildWithAutoincrement(db, table, ctx?.warnings);
  },
  // v5 → v6：note 增加 session_id（A1 / D-014 会话隔离）
  //
  // 为什么非加不可：note（TA自己记的）原本没有会话归属，于是
  //   - memory_search（scope=note）在 A 会话里能翻到 B 会话的笔记；
  //   - memory_forget 在 A 会话里能删掉 B 会话的笔记（跨会话改写，最严重）。
  // 只加列不算完：历史笔记没有归属信息，直接留 NULL 会让它们在绑定的会话里
  // **彻底看不见**（用户会以为笔记丢了）。所以这里做一次谨慎回填：
  //   库里只有**一个**会话时，这些笔记必然是那个会话的（回填）；
  //   有多个会话时无法判断，保持 NULL 并记 warning（不猜、不丢数据）。
  //
  // 幂等：列已存在就跳过 ALTER；回填只在本步刚加过列时做一次
  // （新库的 note 表由 schema.sql 直接建出带列结构，这里不会走到回填）。
  (db, ctx) => {
    const notes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note'").get();
    if (!notes) return; // 新库：migrate 跑在 applySchema 之前，表还不存在
    const cols = new Set(db.prepare('PRAGMA table_info(note)').all().map((c) => c.name));
    if (cols.has('session_id')) return; // 已经迁移过（幂等）

    db.exec('ALTER TABLE note ADD COLUMN session_id TEXT');

    // 回填：只回填「没有任何归属、且库里只有一个会话」的那种情况
    let sessions = [];
    try {
      sessions = db.prepare('SELECT DISTINCT session_id FROM msg LIMIT 2').all().map((r) => r.session_id);
    } catch {
      // msg 表不存在（极端老库）：没有依据，保持 NULL
    }
    if (sessions.length === 1 && sessions[0]) {
      db.prepare('UPDATE note SET session_id = ? WHERE session_id IS NULL').run(sessions[0]);
    } else if (sessions.length > 1) {
      const msg =
        '迁移 v6：note.session_id 已补上，但库里有多个会话、历史笔记无法判断属于哪个，' +
        '保留为 NULL（不猜）。它们在每个会话里都查不到，需要时请手工回填 note.session_id。';
      ctx?.warnings?.push(msg);
      ctx?.logger?.warn?.(`[verbatim] ${msg}`);
    }
  },
  // v6 → v7：删掉 lexicon（梗词典）—— 作者 2026-11-18 决定不要了
  // 它从来没真正跑过（表里 0 行），删掉是清理不是丢数据。
  (db) => {
    try { db.exec('DROP TABLE IF EXISTS lexicon'); } catch { /* 表不存在就当成功 */ }
  },
    // v7 → v8：长文本分片（D-247）。chunk 表和 vec_chunk 都由 applySchema 幂等建，
    // 这里没有额外的数据迁移 —— 已有的 vec_msg（消息级向量）照旧有效，
    // 只有**新索引**的超长消息才会走分片路径。
    () => {},
    // v8 → v9：**存量超长消息重新索引**（D-247 的补齐）
    //
    // 分片是 v8 引入的，但 v7→v8 的迁移当时是空的 —— 结果库里已有的 473 条
    // 超 800 字消息仍是「一条一个向量」（被截断到 2000 字），后半段永远搜不到。
    // 这一步把它们的指纹清掉，让 pending() 重新捞出来走分片路径；
    // 同时删掉它们的旧消息级向量，避免「同一条既有 msg 向量又有 chunk 向量」的重复。
    (db) => {
      try {
        const n = Number(
          db.prepare('SELECT COUNT(*) AS c FROM msg WHERE LENGTH(text) >= 800 AND vec_model IS NOT NULL').get()?.c ?? 0,
        );
        if (n === 0) return;
        db.exec(
          'UPDATE msg SET vec_model = NULL, vec_dim = NULL '
          + 'WHERE vec_model IS NOT NULL AND LENGTH(text) >= 800',
        );
        // vec_msg 可能不存在（老库没装 vec 扩展）—— 清不掉就算了，检索端会去重
        try {
          db.exec('DELETE FROM vec_msg WHERE msg_id IN (SELECT id FROM msg WHERE LENGTH(text) >= 800)');
        } catch { /* 没有 vec_msg 表 */ }
      } catch { /* 表结构异常时不影响升级本身 */ }
    },
  // v9 → v10：将 note.about 从旧版用户视角（me=用户 / her=Agent / us=双方）
  // 翻转为 Agent 第一人称视角（me=Agent 自己 / him=用户 / us=双方）。
  // 原因：memory_remember 由 Agent 以第一人称调用，旧版把 me 对应用户、her 对应 Agent 自己，
  // 与 Agent 的自然第一人称直觉相反，容易记反；旧库已有笔记需要同步翻转 me → him、her → me。
  (db) => {
    const hasNoteTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note'")
      .get();
    if (!hasNoteTable) return;
    db.exec(
      "UPDATE note SET about = CASE about WHEN 'me' THEN 'him' WHEN 'her' THEN 'me' ELSE about END WHERE about IN ('me', 'her')",
    );
  },
  // v10 → v11：scene 新增 gist_source 列（'extractive' | 'llm'），用于精确区分是否已做过 LLM 精炼
  (db) => {
    const hasSceneTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scene'")
      .get();
    if (!hasSceneTable) return;
    const cols = db.prepare('PRAGMA table_info(scene)').all().map((c) => c.name);
    if (!cols.includes('gist_source')) {
      db.exec('ALTER TABLE scene ADD COLUMN gist_source TEXT');
    }
  },
  // v11 → v12：scene 新增 locked 列（人工微调保护），media 新增 caption 列（视觉描述）
  (db) => {
    const hasScene = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scene'")
      .get();
    if (hasScene) {
      const cols = db.prepare('PRAGMA table_info(scene)').all().map((c) => c.name);
      if (!cols.includes('locked')) {
        db.exec('ALTER TABLE scene ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
      }
    }
    const hasMedia = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media'")
      .get();
    if (hasMedia) {
      const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
      if (!cols.includes('caption')) {
        db.exec('ALTER TABLE media ADD COLUMN caption TEXT');
      }
    }
  },
  // v12 → v13：新增场景内滑动对话窗（window / window_fts / vec_window），
  // 均由紧随其后的 applySchema 幂等创建，不改动任何已有数据。
  () => {},
  // v13 → v14：删除 window_fts 及其 3 个同步触发器。
  //
  // 为什么删：FTS5 trigram 只索引 ≥3 字的串，「妈妈」「歌单」这类 2 字中文词根本不进索引；
  // 中文按标点切词后多为整句，`A AND B` 在四个样本 778 条多词查询上命中 0.0%。
  // 现行实现改用 `window.text LIKE` 的 OR 召回 + 「≥N 个不同词」过滤（repo.window.searchKeyword），
  // 召回率 3.9%~37.1%。留着 FTS 表等于每次窗口写入多 3 次触发器开销，且永远不被读。
  //
  // window 表本身、vec_window、索引**一律不动**（窗口向量是有效功能，实测陪伴型 +10.3pt）。
  (db) => {
    db.exec('DROP TRIGGER IF EXISTS window_ai');
    db.exec('DROP TRIGGER IF EXISTS window_ad');
    db.exec('DROP TRIGGER IF EXISTS window_au');
    db.exec('DROP TABLE IF EXISTS window_fts');
  },
  // v14 → v15：window 表新增 kind 列（'window' | 'exchange' | 'thread'），
  // 统一承载滑动对话窗、Q&A 交互原子（陪伴）与语义拐点微话题（Thread）。
  (db) => {
    const hasWindow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'window'")
      .get();
    if (!hasWindow) return;
    const cols = db.prepare('PRAGMA table_info(window)').all().map((c) => c.name);
    if (!cols.includes('kind')) {
      db.exec("ALTER TABLE window ADD COLUMN kind TEXT NOT NULL DEFAULT 'window'");
    }
  },
  // v15 → v16：fact 表新增 session_id 列，补齐历史遗留表的会话隔离边界
  (db) => {
    const hasFact = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact'")
      .get();
    if (!hasFact) return;
    const cols = db.prepare('PRAGMA table_info(fact)').all().map((c) => c.name);
    if (!cols.includes('session_id')) {
      db.exec('ALTER TABLE fact ADD COLUMN session_id TEXT');
    }
  },
  // v16 → v17：新增 2-gram 中文短词辅助 FTS5 索引并回填存量消息
  (db) => {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'msg_cjk2_fts'")
      .get();
    if (!exists) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS msg_cjk2_fts USING fts5(
          bigrams,
          tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS msg_ad_cjk2 AFTER DELETE ON msg BEGIN
          DELETE FROM msg_cjk2_fts WHERE rowid = old.id;
        END;
      `);
      const ins = db.prepare('INSERT INTO msg_cjk2_fts(rowid, bigrams) VALUES (?, ?)');
      for (const r of db.prepare('SELECT id, text FROM msg').iterate()) {
        const out = [];
        for (const m of String(r.text ?? '').matchAll(/[\u4e00-\u9fff]{2,}/g)) {
          const run = m[0];
          for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
        }
        if (out.length > 0) ins.run(Number(r.id), out.join(' '));
      }
    }
  },
];

/**
 * 把一张表重建成 `id INTEGER PRIMARY KEY AUTOINCREMENT`（数据一字不动）。
 *
 * 表不存在、或已经是 AUTOINCREMENT 时直接返回 —— 迁移步骤必须可重复执行。
 *
 * @param {DatabaseSync} db
 * @param {string} table 'msg' | 'scene'
 * @param {string[]} [warnings]
 * @returns {boolean} 是否真的重建了
 */
function rebuildWithAutoincrement(db, table, warnings = []) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!row?.sql) return false; // 新库还没有这张表：schema.sql 建出来的已经是新结构
  const rowSql = String(row.sql);
  if (/\bAUTOINCREMENT\b/i.test(rowSql)) return false; // 已经改过了

  // 从现存的 DDL 派生新表：表名换掉，只给 id 那一行加 AUTOINCREMENT
  const newTable = `${table}__v5`;
  let ddl = rowSql
    .replace(/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE TABLE ')
    .replace(new RegExp(`^CREATE\\s+TABLE\\s+(\`|"|\\[)?${table}(\`|"|\\])?`, 'i'), `CREATE TABLE ${newTable}`);
  ddl = ddl.replace(/^(\s*)id\s+INTEGER\s+PRIMARY\s+KEY\b/im, '$1id INTEGER PRIMARY KEY AUTOINCREMENT');
  if (!/\bAUTOINCREMENT\b/i.test(ddl)) {
    // 兜底：DDL 长得不像预期（比如 id 定义换了写法）。宁可不迁移也不能写坏库。
    warnings.push(`迁移 v5：${table} 的主键定义不认识，跳过 AUTOINCREMENT（D-118 的 id 复用防护未生效）`);
    return false;
  }

  const fkWasOn = Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1;
  if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF'); // 必须在 BEGIN 之前
  try {
    db.exec('BEGIN');
    try {
      db.exec(ddl);
      db.exec(`INSERT INTO ${newTable} SELECT * FROM ${table}`);
      db.exec(`DROP TABLE ${table}`); // 旧表的索引 / 触发器 / FTS 触发器一起没了
      db.exec(`ALTER TABLE ${newTable} RENAME TO ${table}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败就让它带着原始错误抛上去
      }
      throw error;
    }
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
  }

  // 重建后确认引用没断（beat.msg_id → msg.id 这类子表）
  try {
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) {
      warnings.push(`迁移 v5 重建 ${table} 后发现 ${broken.length} 处外键断链：${JSON.stringify(broken.slice(0, 3))}`);
    }
  } catch {
    // foreign_key_check 本身失败不影响结论
  }
  return true;
}

/**
 * 结构迁移：给老库补列、写版本号。
 * 新建库时 schema.sql 里已经带了新结构，这里只是把 user_version 标上去（各步幂等）。
 *
 * 调用顺序：**必须在 applySchema 之前**（老库要先补列，schema 里的索引才建得出来）。
 *
 * @param {DatabaseSync} db
 * @param {{ logger?: { warn(msg: string): void }, warnings?: string[] }} [opts]
 * @returns {number} 迁移后的版本号
 */
export function migrate(db, opts = {}) {
  const warnings = opts.warnings ?? [];
  const logger = opts.logger ?? { warn: (m) => console.warn(m) };
  const current = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
  if (current > SCHEMA_VERSION) {
    const msg = `库结构版本（${current}）比本代码（${SCHEMA_VERSION}）新，可能有未知字段；本次不做降级处理`;
    warnings.push(msg);
    logger.warn(`[verbatim] ${msg}`);
    return current;
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    const step = MIGRATIONS[version];
    if (step) step(db, { warnings, logger }); // ctx 给需要记账的步骤（比如 v5 的表重建）
  }
  if (current < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return SCHEMA_VERSION;
}

/**
 * 打开（必要时创建）记忆库。
 *
 * @param {{
 *   dbPath?: string,       // 默认 $DSH_HOME/verbatim/memory.db；':memory:' 支持
 *   dshHome?: string,
 *   vecDll?: string,       // 显式指定 vec0 文件（测试用）
 *   loadVec?: boolean,     // false = 明确不要向量表（纯 FTS 环境）
 *   vecDim?: number,       // vec0 表维度（默认 1024）
 *   readOnly?: boolean,
 *   logger?: { warn(msg: string): void },
 * }} [opts]
 * @returns {{
 *   db: DatabaseSync, dbPath: string, dshHome: string,
 *   hasVec: boolean, vecDllPath: string|null, warnings: string[],
 *   close(): void,
 * }}
 */
export function openDb(opts = {}, extra = {}) {
  // **兼容两种调用形式**（这个坑很贵，务必别改回去）：
  //   openDb({ dbPath, logger, dshHome, readOnly })   ← 本项目的实际签名
  //   openDb('/path/to.db', { logger })                ← 早期文档写的形式
  //
  // 如果只认第一种，照文档写第二种的调用方会静默打开**默认库**：
  // 字符串没有 `.dbPath` 属性 → undefined → 落到 defaultDbPath()。
  // 结果是「以为在写临时库，其实写进了用户的真实记忆库」——不报错，只污染。
  if (typeof opts === 'string') opts = { ...extra, dbPath: opts };
  const dshHome = resolveDshHome(opts.dshHome);
  const dbPath = opts.dbPath ?? defaultDbPath(dshHome);
  const warnings = [];
  const logger = opts.logger ?? { warn: (msg) => console.warn(msg) };

  const isMemory = dbPath === ':memory:';
  if (!isMemory && !opts.readOnly) mkdirSync(dirname(pathResolve(dbPath)), { recursive: true });

  // ① allowExtension —— 少写这一个选项，后面 loadExtension 必失败（D-149 坑①）
  const openOptions = { allowExtension: true };
  if (opts.readOnly) openOptions.readOnly = true;
  const db = new DatabaseSync(dbPath, openOptions);

  // ② 连接调优（每次打开都要重设，pragma 不落库）。
  // 页缓存 64MB 是硬要求（D-199）：默认 2MB 装不下 34MB 向量页，索引构建差 13~15 倍。
  // 注意：vec0 在文件库上比 JS 暴力余弦慢 2.4 倍（D-198），所以 hasVec=false 的降级
  // 不只是"功能等价"，性能上反而更优——扩展加载失败完全不影响使用体验。
  applyTuning(db, { logger, warnings });

  // ③ 装扩展。失败只记 warning，不抛（降级路径）
  let hasVec = false;
  let vecDllPath = null;
  if (opts.loadVec !== false && !opts.readOnly) {
    let dllPath = ensureVecDll({ vecDll: opts.vecDll, dshHome });
    let result = loadVecExtension(db, dllPath);
    // 若缓存的 native 副本损坏或过期，从源文件强制刷新一次再试
    if (!result.ok && !opts.vecDll && dllPath === defaultVecDllPath(dshHome)) {
      const refreshed = ensureVecDll({ dshHome, forceCopy: true });
      if (refreshed) {
        dllPath = refreshed;
        result = loadVecExtension(db, dllPath);
      }
    }
    hasVec = result.ok;
    vecDllPath = result.ok ? dllPath : null;
    if (!result.ok) {
      const msg = `sqlite-vec 加载失败，已降级为暴力余弦（D-198 实测文件库下更快，无感）：${result.error}`;
      warnings.push(msg);
      logger.warn(`[verbatim] ${msg}`);
    }
  } else if (opts.loadVec === false) {
    warnings.push('调用方明确要求不加载 sqlite-vec（loadVec: false）');
  }

  // ④ 先迁移、再幂等建表（只读库不改结构，假定表已存在）
  //
  // 顺序不能反：老库（v1）的 msg 表还缺 excluded 列，而 schema.sql 里有
  // `CREATE INDEX ... ON msg(excluded, at)` —— 先建索引会直接报 no such column。
  // 迁移步骤都带"表不存在就跳过"，所以新库上这两步等价于只标版本号。
  if (!opts.readOnly) {
    try {
      migrate(db, { logger, warnings });
      applySchema(db, { hasVec, dim: opts.vecDim });
    } catch (error) {
      db.close();
      throw new Error(`建表失败：${error?.message ?? error}`);
    }
  }

  // 库里已有向量表、但这次没装上扩展 —— 只读或降级时仍能开库，但向量路不可用
  if (!hasVec) {
    try {
      const hasVecTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vec_msg','vec_scene') LIMIT 1")
        .get();
      if (hasVecTable) {
        const msg = '库里已有 vec_msg/vec_scene，但本次 sqlite-vec 未加载；这些表本进程不可用';
        warnings.push(msg);
        logger.warn(`[verbatim] ${msg}`);
      }
    } catch {
      // 探测失败不影响主流程
    }
  }

  return {
    db,
    dbPath,
    dshHome,
    hasVec,
    vecDllPath,
    warnings,
    close() {
      try {
        db.close();
      } catch {
        // 已关闭就忽略
      }
    },
  };
}

/**
 * 判断路径是否真实存在的普通文件（asar 内的虚拟文件对 fs 也可见，
 * 但 loadExtension 加载不了 —— 那种情况交给 loadVecExtension 兜底）。
 * @param {string} p
 * @returns {boolean}
 */
function isRealFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;
  } catch {
    return false;
  }
}
