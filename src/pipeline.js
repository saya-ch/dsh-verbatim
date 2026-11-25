/**
 * pipeline.js —— 全链路编排（T8 集成与验收）
 *
 * 这一层只做「接线」，不重写任何模块内部：
 *
 *   T2 读日志 → T2 导出 → T1 入库（含 rewind 物理删除）→ T3 切场 + 邻接
 *                                        ↑
 *                     T5 gist / beat（可选，要 llm）
 *                     T6 向量索引（可选，要 embedding provider）
 *
 * 对外三件事：
 *   importSession(sessionFile, dbPath[, opts])   一次完整导入（幂等，可重跑）
 *   rebuildScenesForSession({repo, extras, ...})  只用 msg 重建场景（D-041 可重建原则）
 *   rebuildDerived([opts])                       场景 + gist + beat + 向量
 *
 * 每一步都打印「做了什么 / 花了多久」，验收报告可以直接抄。
 *
 * 约定：
 *   - 时间工具只有一份（T2 的 parseInstant / matchExcludeRange / dayKeyInZone，
 *     config 复用它们），这里不再写第二份；
 *   - 除了「全库重建要列出会话 id」那一条只读聚合（见 listSessionIds 的注释），
 *     不写 SQL —— 全部走 T1 的 repo / extras。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultDbPath, openDb } from './store/db.js';
import { createExtras, createRepo, deleteVecRows, withTx } from './store/repo.js';
import { createVectorStore, DEFAULT_DIM } from './search/vector-store.js';
import { buildSceneWindows } from './search/window.js';
import { coalesceTurns, buildExchanges } from './search/thread.js';
import { COMPANION_AVG_CHARS } from './search/session-shape.js';
import { readSessionFile, readSessionFileIncremental } from './ingest/reader.js';
import { exportMessages, isRewindEvent } from './ingest/export.js';
import { GAP_CUT_MS, GAP_JOIN_MS, HARD_MAX_SCENE_MSGS, splitScenesWithStats } from './scene/split.js';
import { linkScenes } from './scene/link.js';
import { buildExtractiveGist } from './derive/gist.js';
import {
  defaultSessionConfig,
  loadSessionConfig,
  sessionConfigExists,
  sessionConfigPath,
} from './config/session-config.js';

/** 一次取会话全部消息时给的上限（库才几千条，够用且不用分页） */
const ALL_MSGS_LIMIT = 5_000_000;

/** 时间上界：比任何真实 at 都大，右开区间也罩得住（注意别用位运算，会把数截成 int32） */
const TIME_MAX = Number.MAX_SAFE_INTEGER;

/* ============================== 进度与耗时 ============================== */

/**
 * 造一个「步骤打印器」：每步一行，带毫秒耗时。
 *
 * @param {{log?: (line: string) => void, quiet?: boolean, total?: number}} [opts]
 * @returns {{
 *   step: <T>(label: string, fn: () => Promise<T>, detail?: (v: T) => string) => Promise<T>,
 *   stepSync: <T>(label: string, fn: () => T, detail?: (v: T) => string) => T,
 *   note: (line: string) => void,
 *   timings: {label: string, ms: number}[],
 *   totalMs: () => number,
 * }}
 */
export function createProgress(opts = {}) {
  const quiet = opts.quiet === true;
  const log = typeof opts.log === 'function' ? opts.log : (line) => console.log(line);
  const total = Number.isFinite(opts.total) ? Number(opts.total) : null;
  const startedAt = performance.now();
  const timings = [];
  let index = 0;

  const mark = (label, ms, extra) => {
    timings.push({ label, ms });
    if (quiet) return;
    const head = total ? `[${index}/${total}]` : `[${index}]`;
    log(`${head} ${label}  …… ${ms} ms${extra ? `  ${extra}` : ''}`);
  };

  const stepSync = (label, fn, detail) => {
    index += 1;
    const t0 = performance.now();
    const out = fn();
    mark(label, Math.round(performance.now() - t0), typeof detail === 'function' ? detail(out) : '');
    return out;
  };

  const step = async (label, fn, detail) => {
    index += 1;
    const t0 = performance.now();
    const out = await fn();
    mark(label, Math.round(performance.now() - t0), typeof detail === 'function' ? detail(out) : '');
    return out;
  };

  return {
    step,
    stepSync,
    note(line) {
      if (!quiet) log(line);
    },
    timings,
    totalMs: () => Math.round(performance.now() - startedAt),
  };
}

/** 千分位（不引 Intl，跨机器一致） */
export function n(value) {
  const v = Math.trunc(Number(value) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 百分比，保留一位小数 */
export function pct(part, whole) {
  if (!whole) return '0.0%';
  return `${((Number(part) / Number(whole)) * 100).toFixed(1)}%`;
}

/* ============================== 打开与装配 ============================== */

/**
 * 打开库并把 repo / extras 一起装好（同一连接 —— 事务才能跨命名空间生效）。
 *
 * @param {{
 *   dbPath?: string, dshHome?: string, vecDll?: string, loadVec?: boolean,
 *   logger?: {warn(msg:string):void},
 * }} [opts]
 * @returns {{
 *   handle: { db: import('node:sqlite').DatabaseSync, dbPath: string, dshHome: string, hasVec: boolean, vecDllPath: string|null, warnings: string[], close(): void },
 *   db: import('node:sqlite').DatabaseSync, repo: Record<string, any>, extras: Record<string, any>,
 *   dbPath: string, hasVec: boolean, warnings: string[], close(): void,
 * }}
 */
export function openPipelineDb(opts = {}) {
  const handle = openDb({
    dbPath: opts.dbPath,
    dshHome: opts.dshHome,
    vecDll: opts.vecDll,
    loadVec: opts.loadVec,
    logger: opts.logger,
  });
  return {
    handle,
    db: handle.db,
    repo: createRepo(handle),
    extras: createExtras(handle),
    dbPath: handle.dbPath,
    hasVec: handle.hasVec,
    warnings: handle.warnings ?? [],
    close: () => handle.close(),
  };
}

/** 把「已打开的 handle」或「各种形态的依赖」统一成 pipeline 内部的形状 */
function adaptStore(opts) {
  if (opts.handle) {
    return {
      handle: opts.handle,
      db: opts.handle.db,
      repo: opts.repo ?? createRepo(opts.handle),
      extras: opts.extras ?? createExtras(opts.handle),
      dbPath: opts.handle.dbPath ?? opts.dbPath ?? '(调用方传入)',
      hasVec: opts.handle.hasVec === true,
      warnings: [],
      close: () => {},
    };
  }
  return openPipelineDb(opts);
}

/**
 * 会话 id 从哪来：显式传 > 日志头 > 目录名（`.../<session-id>/session.v4.jsonl.zstd`）。
 * @param {string} sessionFile
 * @param {any} header
 * @param {string} [override]
 * @returns {string}
 */
export function resolveSessionId(sessionFile, header, override) {
  if (typeof override === 'string' && override.trim()) return override.trim();
  if (header && typeof header.id === 'string' && header.id.trim()) return header.id.trim();
  return path.basename(path.dirname(path.resolve(sessionFile)));
}

/**
 * 读一个会话的配置。
 *
 * `opts.excludeRanges` 显式给了就不再读盘（验收/测试用）；
 * 否则走 T9 的 `loadSessionConfig(sessionId, { dbRoot })`，
 * 路径口径是 `<dbRoot>/sessions/<session-id>.json`。
 *
 * @param {string} sessionId
 * @param {{dbRoot?: string, dshHome?: string, excludeRanges?: object[],
 *          onWarn?: (m: string) => void}} [opts]
 * @returns {{record: boolean, tools: boolean, autoRecall: boolean,
 *            excludeRanges: object[], source: string}}
 */
export function resolveSessionConfig(sessionId, opts = {}) {
  if (Array.isArray(opts.excludeRanges)) {
    return { ...defaultSessionConfig(), excludeRanges: opts.excludeRanges, source: '调用方显式传入' };
  }
  const cfgOpts = { dbRoot: opts.dbRoot, dshHome: opts.dshHome, onWarn: opts.onWarn };
  const cfg = loadSessionConfig(sessionId, cfgOpts);
  const file = sessionConfigPath(sessionId, cfgOpts);
  const source = sessionConfigExists(sessionId, cfgOpts) ? file : '默认值（没配过）';
  return { ...cfg, source };
}

/* ============================== 场景重建 ============================== */

/**
 * 从库里的 msg 重建某个会话的场景（切分 + 邻接 + 把 msg 挂回 scene）。
 *
 * 为什么从库里读而不是用内存里的导出结果：D-041「一切派生数据可重建」。
 * 场景是派生层，唯一事实来源是 msg —— 导入和重建走同一条代码路径，
 * 「导入后切的场」和「rebuild 后的场」因此天然一致。
 *
 * **场景向量必须跟着场景一起消失**（R5 实测 P1）：删场而留向量，
 * 新场一旦拿到同一个 id，用旧场的 gist 向量就能命中一条无关的新对话。
 * 持久化那份由 `extras.sceneAssign.clear()` 在**同一个事务**里清掉（不依赖本函数），
 * 这里额外的 `vectorStore.deleteSceneVecs` 负责本进程内存里那份（降级模式），
 * 两者都清是幂等的。
 *
 * @param {{repo: object, extras: object, sessionId: string,
 *          vectorStore?: {deleteSceneVecs(ids: number[]): number}}} opts
 * @returns {{
 *   scenes: number, msgsAssigned: number, splitStats: object,
 *   scenesWithOutOfSurface: number, scenesWithExcluded: number,
 *   sceneIds: number[], sceneVectorsCleared: number,
 * }}
 */
/**
 * 从库里读取该会话已有的消息向量（优先 vec_msg，降级 vec_fallback_msg）。
 * 用于场景切分的阶段 B（TextTiling 语义边界精修），零额外模型调用；
 * 读不到或尚无向量时返回 null，自动回落为纯规则阶段 A。
 */
import {
  rebuildScenesForSession,
  syncScenesForSession,
  buildAdaptiveWindowsForScene,
  ensureWindowsForSession,
} from './pipeline-scenes.js';

export {
  rebuildScenesForSession,
  syncScenesForSession,
  buildAdaptiveWindowsForScene,
  ensureWindowsForSession,
};

/* ============================== 导入主流程 ============================== */

/**
 * 导入一个会话日志：读 → 导出 → 入库 → 切场 → 自检。
 *
 * 幂等：`insertMsg` 是 `(session_id, seq)` upsert，重跑不会炸 UNIQUE，
 * 也不会把已有 scene_id 弄丢；rewind 区间先物理删、再补插本轮存活的消息。
 *
 * @param {string} sessionFile session.v4.jsonl.zstd 路径
 * @param {string|object} [dbPathOrOpts] 库路径，或全部选项对象
 * @param {object} [maybeOpts] 见下
 * @param {string} [maybeOpts.dbPath] 库路径（默认 $DSH_HOME/verbatim/memory.db）
 * @param {string} [maybeOpts.dbRoot] 会话配置根（`<dbRoot>/sessions/<id>.json`）
 * @param {string} [maybeOpts.dshHome] DSH_HOME（config 与库都用它派生）
 * @param {string} [maybeOpts.sessionId] 覆盖会话 id
 * @param {object[]} [maybeOpts.excludeRanges] 显式排除区间（不读配置）
 * @param {boolean} [maybeOpts.loadVec] 是否加载 sqlite-vec
 * @param {boolean} [maybeOpts.quiet] 不打印进度
 * @param {(line: string) => void} [maybeOpts.log] 打印函数
 * @returns {Promise<Record<string, any>>} 导入报告（统计 + 耗时）
 */
export async function importSession(sessionFile, dbPathOrOpts, maybeOpts) {
  const opts =
    typeof dbPathOrOpts === 'string'
      ? { ...(maybeOpts ?? {}), dbPath: dbPathOrOpts }
      : { ...(dbPathOrOpts ?? {}) };
  const quiet = opts.quiet === true;
  const log = typeof opts.log === 'function' ? opts.log : (line) => console.log(line);
  const progress = opts.progress ?? createProgress({ log, quiet, total: 6 });
  const warnings = [];

  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw new Error(`会话日志不存在：${sessionFile}`);
  }

  // ── ① 读日志（支持传 readerCache / readerState 进行尾部增量解压） ──
  const absSessionFile = path.resolve(sessionFile);
  const readerCache = opts.readerCache instanceof Map ? opts.readerCache : null;
  const prevReaderState = opts.readerState ?? (readerCache ? readerCache.get(absSessionFile) : null) ?? null;

  const reader = progress.stepSync(
    '读日志（zstd 逐帧解压 + 按 seq 排序）',
    () => (readerCache || opts.readerState !== undefined
      ? readSessionFileIncremental(absSessionFile, prevReaderState)
      : readSessionFile(absSessionFile)),
    (r) => `${n(r.stats.bytes)} 字节 / ${n(r.stats.eventCount)} 事件${r.incremental === 'tail' ? '（尾部增量）' : r.incremental === 'hit' ? '（缓存命中）' : ''}`,
  );
  if (readerCache && reader.state) {
    readerCache.set(absSessionFile, reader.state);
  }

  // ── ② 配置 ──────────────────────────────────────────────────
  const sessionId = resolveSessionId(sessionFile, reader.header, opts.sessionId);
  const cfg = progress.stepSync(
    '读会话配置（record / tools / excludeRanges）',
    () =>
      resolveSessionConfig(sessionId, {
        dbRoot: opts.dbRoot,
        dshHome: opts.dshHome,
        excludeRanges: opts.excludeRanges,
        onWarn: (m) => warnings.push(m),
      }),
    (c) => `${c.excludeRanges.length} 个排除区间（${typeof c.source === 'string' && c.source.includes(path.sep) ? path.basename(c.source) : c.source}）`,
  );

  // **生产安全闸门**：会话没开 `record` 就不入库（隐私优先，默认关）。
  // 批量回放或导入历史日志时，显式传 `forceRecord: true` 才能绕过。
  // 注意：这只影响「导入」这一个动作，不改变磁盘上的会话配置。
  if (cfg.record !== true && opts.forceRecord !== true) {
    progress.note('record = false：这场不记录，直接返回。');
    return {
      sessionId,
      skipped: true,
      reason: 'record=false',
      config: cfg,
      warnings,
      timings: progress.timings,
      totalMs: progress.totalMs(),
    };
  }

  // ── ③④ 导出与入库 ──────────────────────────────────────────
  const store = adaptStore(opts);
  const tailEvents = Array.isArray(reader.tailEvents) ? reader.tailEvents : null;
  const excludeSig = JSON.stringify(cfg.excludeRanges ?? []);
  const prevExcludeSig = prevReaderState?.excludeSig ?? null;
  const canTailFastPath = Boolean(
    reader.incremental === 'tail'
    && tailEvents
    && prevExcludeSig === excludeSig
    && tailEvents.every((ev) => (
      !isRewindEvent(ev)
      && ev?.type !== 'compaction/summary'
      && ev?.type !== 'compaction/end'
      && ev?.type !== 'agent/inbox/spliced'
      && (typeof ev?.seq !== 'number' || reader.prevSeqMax === null || ev.seq > reader.prevSeqMax)
    ))
    && Number(store.db.prepare('SELECT COUNT(*) AS c FROM msg WHERE session_id = ?').get(sessionId)?.c ?? 0) > 0,
  );

  let exported;
  let messages;
  let exportStats;
  let ingest;

  if (canTailFastPath) {
    exported = progress.stepSync(
      '导出增量尾部（无 rewind / compaction，跳过全量重放）',
      () =>
        exportMessages(tailEvents, {
          sessionId,
          includeRewound: true,
          excludeRanges: cfg.excludeRanges,
        }),
      (r) => `增量 ${n(r.messages.length)} 条 / ${n(r.stats.totalChars)} 字`,
    );
    messages = exported.messages;
    exportStats = exported.stats;
    ingest = progress.stepSync(
      '增量入库（仅写入新增消息与媒体）',
      () => withTx(store.db, () => {
        if (messages.length > 0) store.repo.insertMsgs(messages);
        const mediaWritten = exported.media?.length
          ? store.extras.media.replaceForSession(sessionId, exported.media)
          : 0;
        return {
          inserted: messages.length,
          deleted: 0,
          media: mediaWritten,
          rewoundRanges: 0,
          incremental: true,
        };
      }),
      (r) => `新增 ${n(r.inserted)} 条`,
    );
  } else {
    exported = progress.stepSync(
      '导出（rewind 丢弃、compaction 标记、系统注入过滤）',
      () =>
        exportMessages(reader.events, {
          sessionId,
          includeRewound: true,
          excludeRanges: cfg.excludeRanges,
        }),
      (r) => `${n(r.messages.length)} 条 / ${n(r.stats.totalChars)} 字`,
    );
    messages = exported.messages;
    exportStats = exported.stats;

    ingest = progress.stepSync(
      '入库（先删本轮消失的 seq，再 upsert 正文；同一事务）',
      () => {
        // rewind 的语义是「这些 seq 不算发生过」。但**不能**按 `seq >= X` 一刀切删：
        // rewind 之后新到的消息 seq 也 >= X，它们是存活的。一起删再插会
        //   ① CASCADE 掉它们身上的 flag / beat / media（D-167 说这仨只该增不该丢）
        //   ② 让 msg.id 漂移，外部持有的 `msg:123` 类引用指错行
        // 正确做法：算差集 —— 库里已有、但本轮存活集合里没有的 seq，才是真的消失了。
        const alive = new Set(messages.map((m) => m.seq));
        const existing = store.repo
          .msgsByTimeRange(sessionId, 0, Number.MAX_SAFE_INTEGER, 1_000_000, true)
          .map((m) => m.seq);
        const gone = existing.filter((s) => !alive.has(s));

        // 删除与插入必须同一事务：插入一旦失败（脏日志 / SQLITE_BUSY / 磁盘满），
        // 不能留下「已删未插」的半截库 —— 那违反「原文是唯一事实来源」。
        return withTx(store.db, () => {
          const deleted = gone.length ? store.repo.deleteMsgsBySeqs(sessionId, gone) : 0;
          store.repo.insertMsgs(messages);
          const mediaWritten = exported.media?.length
            ? store.extras.media.replaceForSession(sessionId, exported.media)
            : 0;
          return {
            inserted: messages.length,
            deleted,
            media: mediaWritten,
            rewoundRanges: (exportStats.rewindRanges ?? []).length,
            incremental: false,
          };
        });
      },
      (r) =>
        `${n(r.inserted)} 条（删掉本轮消失的 ${n(r.deleted)} 条；rewind 区间 ${r.rewoundRanges} 个）`,
    );
  }
  if (reader.state) reader.state.excludeSig = excludeSig;

  // ── ⑤ 增量切场（稳定时间窗 + rewind 局部修复 + compaction 派生刷新）+ 邻接回填 ──
  const sceneReport = progress.stepSync(
    '增量切场（稳定窗 30min + 局部修复）+ 邻接回填',
    () => syncScenesForSession({
      repo: store.repo,
      extras: store.extras,
      sessionId,
      db: store.db,
      now: opts.now,
      settleMs: opts.settleMs,
    }),
    (r) => `${n(r.scenes)} 场（新增 ${n(r.scenesAdded)} / 挂回 ${n(r.msgsAssigned)} 条 / 未封场 ${n(r.pendingMsgs)} 条）`,
  );

  // ── ⑥ 自检 ──────────────────────────────────────────────────
  const report = progress.stepSync(
    '自检（条数 / 字数 / in_surface / 场景）',
    () =>
      buildReport({
        sessionId,
        reader,
        exportStats,
        sceneReport,
        stats: store.extras.stats.get(),
      }),
    (r) => `${n(r.msgs)} 条 / ${n(r.chars)} 字 / ${n(r.scenes)} 场`,
  );

  const out = {
    sessionId,
    skipped: false,
    dbPath: store.dbPath,
    hasVec: store.hasVec,
    reader: reader.stats,
    config: cfg,
    export: { stats: exportStats, count: messages.length },
    ingest,
    scenes: sceneReport,
    report,
    warnings,
    timings: progress.timings,
    totalMs: progress.totalMs(),
  };

  if (opts.handle === undefined) store.close();
  return out;
}

/**
 * 把各步统计拼成一份可打印的报告（验收拿它对基线数字）。
 * @param {{sessionId: string, reader: any, exportStats: any,
 *          sceneReport: any, stats: any}} p
 */
export function buildReport(p) {
  const exp = p.exportStats ?? {};
  return {
    sessionId: p.sessionId,
    events: p.reader?.stats?.eventCount ?? null,
    msgs: exp.totalMessages ?? 0,
    chars: exp.totalChars ?? 0,
    inSurface0Count: exp.inSurface0Count ?? 0,
    inSurface0Chars: exp.inSurface0Chars ?? 0,
    inSurface0MsgRatio: exp.inSurface0MsgRatio ?? 0,
    inSurface0CharRatio: exp.inSurface0CharRatio ?? 0,
    excludedCount: exp.excludedCount ?? 0,
    excludedChars: exp.excludedChars ?? 0,
    excludedRanges: exp.excludedHits ?? [],
    rewoundCount: exp.rewoundCount ?? 0,
    rewoundRanges: (exp.rewindRanges ?? []).length,
    scenes: p.sceneReport?.scenes ?? 0,
    searchable: exp.searchableCount ?? 0,
    dbMsgs: p.stats?.msgs ?? 0,
    dbScenes: p.stats?.scenes ?? 0,
    dbFirstAt: p.stats?.firstAt ?? null,
    dbLastAt: p.stats?.lastAt ?? null,
  };
}

/** 打印导入报告（跟 IMPLEMENTATION.md §10 的基线数字一一对应） */
export function printImportReport(report, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : (line) => console.log(line);
  const rows = [
    ['会话', report.sessionId],
    ['事件', n(report.events ?? 0)],
    ['入库', `${n(report.msgs)} 条 / ${n(report.chars)} 字`],
    [
      'in_surface=0',
      `${n(report.inSurface0Count)} 条 / ${n(report.inSurface0Chars)} 字 = ` +
        `${pct(report.inSurface0Count, report.msgs)}（按字 ${pct(report.inSurface0CharRatio * 100, 100)}）`,
    ],
    ['按日期软排除', `${n(report.excludedCount)} 条 / ${n(report.excludedChars)} 字`],
    ['rewind 丢掉', `${n(report.rewoundCount)} 条（${n(report.rewoundRanges)} 个区间，不入库）`],
    ['场景', `${n(report.scenes)} 场`],
    ['可检索', `${n(report.searchable)} 条`],
    ['库内合计', `${n(report.dbMsgs)} 条 / ${n(report.dbScenes)} 场`],
  ];
  for (const [k, v] of rows) log(`  ${k.padEnd(12, ' ')} ${v}`);
}

/* ============================== 派生层重建 ============================== */

/**
 * 从 msg 重建全部派生数据（D-041）：场景 → gist → beat → 向量。
 *
 * 每一项都可单独关掉；没有 provider 的步骤**显式说清为什么跳过**，
 * 不静默消失（否则验收时会以为跑过了）。
 *
 * @param {{
 *   handle?: any,
 *   dbPath?: string,
 *   sessionId?: string,
 *   llm?: any,
 *   embedding?: any,
 *   gist?: boolean,
 *   beats?: boolean,
 *   vectors?: boolean,
 *   force?: boolean,
 *   beatLimit?: number,
 *   quiet?: boolean,
 *   log?: (line: string) => void,
 *   progress?: any,
 *   onProgress?: (info: any) => void,
 * }} [opts]
 * @returns {Promise<any>}
 */
export async function rebuildDerived(opts = {}) {
  const quiet = opts.quiet === true;
  const log = typeof opts.log === 'function' ? opts.log : (line) => console.log(line);
  const progress = opts.progress ?? createProgress({ log, quiet, total: 4 });
  const warnings = [];

  const store = adaptStore(opts);
  const { repo, extras } = store;

  /* 向量 store 全流程只建一个实例：
   *   ① 场景重建要用它清掉旧场景的内存向量（降级模式下是独立一份拷贝）
   *   ② 索引器也要用它 —— 如果各建各的，降级模式下会有两份 30MB 的 Map
   * 只有「这次真要碰向量」时才建，别为了删几条向量就白加载一遍。 */
  const wantVectors = opts.vectors !== false && Boolean(opts.embedding);
  let sharedVectorStore = null;
  const getVectorStore = () => {
    if (sharedVectorStore) return sharedVectorStore;
    sharedVectorStore = createVectorStore(store.handle ?? store, {
      dim: opts.embedding?.dim ?? DEFAULT_DIM,
      logger: { warn: (m) => warnings.push(m) },
    });
    return sharedVectorStore;
  };

  const sessionIds = opts.sessionId
    ? [opts.sessionId]
    : listSessionIds({ db: store.db });
  if (sessionIds.length === 0) warnings.push('库里没有任何消息，派生层无从重建');

  /* ① 场景 */
  const sceneTotals = progress.stepSync(
    `重建场景（${n(sessionIds.length)} 个会话）`,
    () => {
      let scenes = 0;
      let assigned = 0;
      let vecCleared = 0;
      const vectorStore = wantVectors ? getVectorStore() : undefined;
      for (const sid of sessionIds) {
        const r = rebuildScenesForSession({ repo, extras, sessionId: sid, vectorStore, db: store.db });
        scenes += r.scenes;
        assigned += r.msgsAssigned;
        vecCleared += r.sceneVectorsCleared;
      }
      return { scenes, assigned, vecCleared };
    },
    (r) => `${n(r.scenes)} 场，挂回 ${n(r.assigned)} 条${r.vecCleared ? `，清掉 ${n(r.vecCleared)} 条旧场景向量` : ''}`,
  );

  /** 每步都现取场景行：gist 写回之后再取，向量才有东西可嵌（先取会全是 null） */
  const readSceneRows = () =>
    sessionIds.flatMap((sid) => repo.scenesByTimeRange(sid, 0, TIME_MAX, ALL_MSGS_LIMIT));

  /* ② gist（要 llm） */
  const gistReport = await progress.step(
    '生成 gist（T5，需 llm）',
    async () => {
      if (opts.gist === false) return { skipped: '显式关闭' };
      if (!opts.llm) return { skipped: '没给 llm，跳过 gist（场景照样可切分、可检索原话）' };
      return generateGists({ repo, llm: opts.llm, scenes: readSceneRows(), log, quiet });
    },
    (r) => (r.skipped ? r.skipped : `${n(r.ok)} 场成功 / ${n(r.failed)} 场失败`),
  );

  /* ③ beat（要 llm，默认关） */
  const beatReport = await progress.step(
    '分类 beat（T5，需 llm）',
    async () => {
      if (opts.beats !== true) return { skipped: '默认关闭（每条一次模型调用）' };
      if (!opts.llm) return { skipped: '没给 llm' };
      return classifyBeats({ repo, llm: opts.llm, sessionIds, limit: opts.beatLimit ?? 50 });
    },
    (r) => (r.skipped ? r.skipped : `${n(r.classified)} 条 → ${n(r.beats)} 个标记`),
  );

  /* ④ 向量索引（要 embedding） */
  const vectorReport = await progress.step(
    '重建向量索引（T6，需 embedding）',
    async () => {
      if (opts.vectors === false) return { skipped: '显式关闭' };
      if (!opts.embedding) return { skipped: '没给 embedding provider，跳过向量索引（时间 / 关键词路不受影响）' };
      if (!store.hasVec) warnings.push('sqlite-vec 未加载，向量走暴力余弦降级路径（接口不变）');
      const { createIndexer } = await import('./search/indexer.js');
      const indexer = createIndexer({
        handle: store.handle ?? store,
        provider: opts.embedding,
        // 复用上面那个实例：降级模式下只有它持有的内存索引是最新的（场景重建刚清过）
        store: getVectorStore(),
        logger: { warn: (m) => warnings.push(m) },
        onProgress: opts.onProgress,
      });
      // ① gist 已写回，现取场景才有内容可嵌
      // ② T6 的 rebuild 现在两条分支都会「清向量表 + 清指纹 + 全量重算」
      //    （v6 修掉了「指纹在、表空了 → 产出 0 条」的坑），所以 force 只影响
      //    「要不要先校验旧模型」。这里仍默认 force：重建就该是真的重建。
      return indexer.rebuild({
        force: opts.force !== false,
        scenes: readSceneRows().map((s) => ({ id: s.id, gist: s.gist })),
      });
    },
    (r) => (r.skipped ? r.skipped : `${n(r.msgs)} 条向量 / ${n(r.scenes)} 场`),
  );

  const out = {
    dbPath: store.dbPath,
    sessions: sessionIds,
    scenes: sceneTotals,
    gist: gistReport,
    beats: beatReport,
    vectors: vectorReport,
    warnings,
    timings: progress.timings,
    totalMs: progress.totalMs(),
  };

  // 场景重建会换掉 scene.id；已有向量如果没跟着重建，vec_scene 就指向不存在的场景了
  // （KNN 后 JOIN 会把它们过滤掉，功能上不炸，但索引是坏的）。这里必须说出来。
  if (vectorReport?.skipped) {
    try {
      const meta = extras.vecMeta.get();
      if (meta.indexed > 0) {
        warnings.push(
          `场景已重建，但这次没跑向量索引（${vectorReport.skipped}）：` +
            `现有 ${n(meta.indexed)} 条向量仍指向旧场景，需要带 embedding provider 再跑一次 rebuildDerived 才能对齐`,
        );
      }
    } catch {
      // 向量元信息读不出来不影响主流程
    }
  }

  if (opts.handle === undefined) store.close();
  return out;
}

/**
 * 列出库里有消息的会话 id。
 *
 * 唯一的例外：repo / extras 契约里**没有**「列会话」的方法，而全库重建必须知道
 * 有哪些会话。这里读一条只读聚合 SQL（不改任何数据），仍然不碰业务表逻辑。
 * 只给编排层用；各模块内部依旧一律不写 SQL。
 *
 * @param {{db: any}} [opts]
 * @returns {string[]}
 */
export function listSessionIds({ db } = /** @type {any} */ ({})) {
  if (!db || typeof db.prepare !== 'function') return [];
  return db
    .prepare('SELECT DISTINCT session_id AS sid FROM msg ORDER BY sid')
    .all()
    .map((r) => r.sid);
}

/** 逐场生成 gist 并写回 scene.gist */
async function generateGists({ repo, llm, scenes, log, quiet }) {
  const { generateGist } = await import('./derive/gist.js');
  let ok = 0;
  let failed = 0;
  let unresolved = 0;
  for (const scene of scenes) {
    const msgs = repo.msgsByScene(scene.id, true);
    if (msgs.length === 0) continue;
    try {
      const r = await generateGist({
        llm,
        msgs: msgs.map((m) => ({ seq: m.seq, speaker: m.speaker, text: m.text, at: m.at })),
        startAt: scene.startAt,
        endAt: scene.endAt,
      });
      if (r.ok && r.gist) {
        repo.setSceneGist(scene.id, r.gist);
        ok += 1;
        unresolved += (r.unresolved ?? []).length;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      if (!quiet) log(`    gist 场景 #${scene.id} 失败：${error?.message ?? error}`);
    }
  }
  return { scenes: scenes.length, ok, failed, unresolved };
}

/** 逐条分类 beat 并写库（只在显式开启时跑） */
async function classifyBeats({ repo, llm, sessionIds, limit }) {
  const { classifyBeat } = await import('./derive/beat.js');
  let classified = 0;
  let beats = 0;
  for (const sid of sessionIds) {
    if (classified >= limit) break;
    const msgs = repo.msgsByTimeRange(sid, 0, TIME_MAX, Math.max(limit - classified + 1, 100));
    for (let i = 0; i < msgs.length && classified < limit; i++) {
      const msg = msgs[i];
      try {
        const r = await classifyBeat({
          llm,
          msg: { seq: msg.seq, speaker: msg.speaker, text: msg.text },
          before: msgs[i - 1] ?? null,
          after: msgs[i + 1] ?? null,
        });
        for (const beat of r.beats ?? []) {
          repo.insertBeat(msg.id, beat.kind, beat.confidence);
          beats += 1;
        }
        classified += 1;
      } catch {
        // 单条失败不影响整轮（分类是增强项，原文才是事实来源）
      }
    }
  }
  return { classified, beats, limit };
}

/* ============================== 命令行入口 ============================== */

/**
 * `node src/pipeline.js import <session.v4.jsonl.zstd> [--db path] [--db-root root]`
 * `node src/pipeline.js rebuild [--db path] [--session id]`
 *
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  if (cmd === 'import') {
    const file = flags._[0];
    if (!file) {
      console.error('用法: node src/pipeline.js import <session.v4.jsonl.zstd> [--db path] [--db-root root]');
      return 2;
    }
    const result = await importSession(file, {
      dbPath: flags.db,
      dbRoot: flags['db-root'],
      loadVec: flags.vec !== false,
    });
    console.log('');
    printImportReport(result.report);
    if (result.warnings.length) {
      console.log('');
      console.log('警告：');
      for (const w of result.warnings) console.log(`  · ${w}`);
    }
    console.log('');
    console.log(`总耗时 ${result.totalMs} ms`);
    return 0;
  }
  if (cmd === 'rebuild') {
    const out = await rebuildDerived({ dbPath: flags.db, sessionId: flags.session });
    console.log('');
    console.log(`场景 ${n(out.scenes.scenes)} 场，挂回 ${n(out.scenes.assigned)} 条消息`);
    console.log(`总耗时 ${out.totalMs} ms`);
    return 0;
  }
  console.error('用法: node src/pipeline.js <import|rebuild> ...');
  return 2;
}

/** `--key value` / `--flag` / `--no-flag` → 对象 */
function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const body = a.slice(2);
    if (body.startsWith('no-')) {
      out[body.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[body] = true;
    else {
      out[body] = next;
      i += 1;
    }
  }
  return out;
}

/** 默认库路径（给 acceptance / 面板提示用） */
export function defaultMemoryDbPath(dshHome) {
  return defaultDbPath(dshHome);
}

/* 直接跑：node src/pipeline.js ... */
const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
}
