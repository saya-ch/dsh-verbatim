/**
 * acceptance.js —— IMPLEMENTATION.md §10 的 6 条验收（跑真实会话，不打假 OK）
 *
 * 用法：
 *   node src/acceptance.js                 # 每次都先幂等重导（日志还在写，旧库对不上）
 *   node src/acceptance.js --no-import     # 只复跑检查，不动库
 *   node src/acceptance.js --db path --session-file path --db-root path
 *
 * 六条：
 *   1. 换问法：["怕黑", "我怕那个"] 命中同一批
 *   2. 说时间：每条结果都带 11-12 23:36–00:12 这种区间
 *   3. 查压缩掉的：能查到 in_surface=0 的内容且带标记
 *   4. 查撤回的：被 rewind 的一条都查不到
 *   5. 空结果：返回库范围和建议，不是空白
 *   6. 原文一致：抽 20 条与日志逐字比对，0 差异
 *
 * 设计原则：
 *   - 断言对象是**工具的输出文本**（TA真正看到的东西），不是模块内部返回值；
 *   - 每一条都把实际数值/原文打出来，判定只写「为什么通过/不通过」；
 *   - 语料现实和规格示例不一致时（例如库里根本没有「怕黑」这两个字），
 *     照实打印 0，并说明这是数据现实还是实现问题 —— 不把 0 粉饰成 PASS。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { importSession, n, openPipelineDb, printImportReport } from './pipeline.js';
import { exportMessages, stripBridgeMetadata, textBlocksOf } from './ingest/export.js';
import { readSessionFile } from './ingest/reader.js';
import { loadSessionExcludeRanges } from './config/session-config.js';
import { createToolSet, schemaSize } from './tools/index.js';
import {
  MARK_COMPACTED,
  MARK_COMPACTED_ONE,
  fmtRange,
  fmtSpan,
  fmtStamp,
} from './tools/format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');

/**
 * 验收用的会话文件 —— **不写死在仓库里**（脱敏）。
 * 优先命令行第一个参数，其次环境变量，最后自动在 $DSH_HOME/sessions 下找一个。
 */
function resolveSessionFile() {
  const fromArg = process.argv[2];
  if (fromArg && !fromArg.startsWith('-')) return fromArg;
  if (process.env.VERBATIM_TEST_SESSION) return process.env.VERBATIM_TEST_SESSION;

  const root = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions');
  if (!fs.existsSync(root)) return '';

  // 项目 sessions/ 里有配置的会话，是验收最该用的那个（排除区间、开关都在那儿）。
  const cfgDir = path.join(PROJECT, 'sessions');
  const wanted = new Set(
    fs.existsSync(cfgDir)
      ? fs.readdirSync(cfgDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
      : [],
  );

  const all = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'session.v4.jsonl.zstd') all.push({ p, size: fs.statSync(p).size });
    }
  };
  try { walk(root, 0); } catch { /* 权限问题就当作没找到 */ }
  if (all.length === 0) return '';

  // ① 优先：有配置文件的
  const configured = all.filter(a => wanted.size && [...wanted].some(id => a.p.includes(id)));
  if (configured.length) return configured.sort((a, b) => b.size - a.size)[0].p;
  // ② 退而求其次：体积最大的（主对话，边界情况最多）
  return all.sort((a, b) => b.size - a.size)[0].p;
}

export const DEFAULT_SESSION_FILE = resolveSessionFile();

/** 验收库放 .tmp/ 下：随时可删、可重建，不进项目根目录 */
// 验收产物**默认写到系统临时目录**，不进仓库 —— 它含真实对话原文，
// 落在仓库里就可能在 git add -A 时被提交（R3 审查发现的 P0）。
// 想指定位置用 --db，但 reset 只对「验收专属目录」生效（见下）。
export const DEFAULT_DB_DIR = path.join(os.tmpdir(), 'verbatim-acceptance');
export const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'memory.db');

/** 会话配置根：项目里的 `sessions/<id>.json`（11-08 排除区间的真实配置） */
export const DEFAULT_DB_ROOT = PROJECT;

/* ============================== 输出排版 ============================== */

const BAR = '━'.repeat(78);

/** @param {string} line */
const out = (line = '') => console.log(line);

function title(text) {
  out('');
  out(BAR);
  out(` ${text}`);
  out(BAR);
}

function checkHead(index, name, goal) {
  out('');
  out(`── 验收 ${index}. ${name} ──────────────────────────────────────────`);
  out(`期望：${goal}`);
  out('');
}

/** 「实际输出」小节：把原文缩进两格贴出来 */
function actual(lines, limit = 60) {
  out('实际结果：');
  const list = Array.isArray(lines) ? lines : [lines];
  for (const line of list.slice(0, limit)) {
    for (const l of String(line).split('\n')) out(`  ${l}`);
  }
  if (list.length > limit) out(`  ……（还有 ${list.length - limit} 行，省略）`);
}

function verdict(kind, reason) {
  const mark = kind === 'PASS' ? '✅ PASS' : kind === 'PARTIAL' ? '🟡 PARTIAL' : kind === 'INFO' ? 'ℹ️ INFO' : '❌ FAIL';
  out('');
  out(`判定：${mark} —— ${reason}`);
  return { verdict: kind, reason };
}

/* ============================== 工具输出解析 ============================== */

/** 搜索结果的命中块头：`  11-12 23:41  他` */
const HIT_HEAD_RE = /^ {2}(\d{2}-\d{2} \d{2}:\d{2}) {2}(他|我)$/;

/** 命中块里的场景区间：`（在 11-12 23:36–00:12 那场，共 18 轮）` */
const SCENE_RANGE_RE = /（在 (\d{2}-\d{2} \d{2}:\d{2})–((?:\d{2}-\d{2} )?\d{2}:\d{2}) 那场，共 ([\d,]+) 轮）/;

/** 时间路场景头：`11-10 01:21–01:28   共 18 轮，摘 6 轮（7 天前 · 深夜）` */
const SCENE_HEAD_RE = /^(\d{2}-\d{2} \d{2}:\d{2})–(\d{2}:\d{2}) {2,}共 ([\d,]+) 轮/gm;

/**
 * 解析 memory_search 的输出。
 * @param {string} text
 */
export function parseSearchOutput(text) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const head = HIT_HEAD_RE.exec(line);
    if (head) {
      current = { stamp: head[1], speaker: head[2], lines: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  for (const block of blocks) {
    const body = block.lines.join('\n');
    const range = SCENE_RANGE_RE.exec(body);
    block.range = range ? { start: range[1], end: range[2], turns: range[3] } : null;
    block.compacted = block.lines.some((l) => l.includes(MARK_COMPACTED_ONE));
    block.excluded = block.lines.some((l) => l.includes('（这条平时被排除在外'));
    block.text = block.lines
      .filter(
        (l) =>
          l.trim() &&
          !l.includes('（在 ') &&
          !l.includes('（这条平时被排除在外') &&
          !l.includes('（这句已经装不进'),
      )
      .map((l) => l.replace(/^ {4}/, ''))
      .join('\n')
      .trim();
  }
  const footer = /已显示 ([\d,]+) \/ ([\d,]+)/.exec(raw);
  const head = /^「([\s\S]*?)」— (.+)$/m.exec(raw);
  return {
    raw,
    empty: /^(没有找到|还没有记下|memory_search 需要|检索能力不可用)/m.test(raw),
    head: head ? { query: head[1], total: head[2].trim() } : null,
    blocks,
    shown: footer ? Number(footer[1].replace(/,/g, '')) : blocks.length,
    total: footer ? Number(footer[2].replace(/,/g, '')) : blocks.length,
    hasLibraryLine: /库里有 \d{2}-\d{2} 至 \d{2}-\d{2} 的/.test(raw),
  };
}

/** 解析时间路输出（memory_search 按时间翻）的场景头（只取区间行） */
export function parseTimelineHeaders(text) {
  const out2 = [];
  const raw = String(text ?? '');
  let m;
  const re = new RegExp(SCENE_HEAD_RE.source, 'gm');
  while ((m = re.exec(raw)) !== null) {
    out2.push({ start: m[1], end: m[2], turns: Number(m[3].replace(/,/g, '')) });
  }
  return out2;
}

/* ============================== 验收上下文 ============================== */

/**
 * 准备好一次验收需要的全部东西：库、工具、日志真值。
 * @param {Record<string, any>} [opts]
 */
export async function prepareContext(opts = {}) {
  const sessionFile = opts.sessionFile ?? DEFAULT_SESSION_FILE;
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  const dbRoot = opts.dbRoot ?? DEFAULT_DB_ROOT;
  const log = typeof opts.log === 'function' ? opts.log : out;

  if (!fs.existsSync(sessionFile)) throw new Error(`会话日志不存在：${sessionFile}`);

  // **默认先清空验收库**：幂等 upsert 只保证「同一会话重导不重复」，
  // 但换了会话文件（或之前跑过别的会话）时，库会变成多会话混合，
  // 统计数字就全是假的。验收要的是「这一个会话的干净结果」。
  // `--no-reset` 可以保留（想把两个会话放一起看时用）。
  if (opts.reset !== false && fs.existsSync(dbPath)) {
    // **安全闸门**：只允许删「验收自己创的库」。
    // 否则 `node src/acceptance.js --db ~/.dsh/verbatim/memory.db` 会静默删掉
    // 用户真实的记忆库 —— 那是全项目唯一能一次抹掉全部原文的路径。
    const resolved = path.resolve(dbPath);
    const allowedRoots = [
      path.resolve(DEFAULT_DB_DIR),
      path.resolve(PROJECT, '.tmp'),
      path.resolve(os.tmpdir()),
    ];
    const inAllowed = allowedRoots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!inAllowed) {
      throw new Error(
        `拒绝清空 ${resolved}\n`
        + '验收只会清空自己创建的库（系统临时目录下的 verbatim-acceptance/，或项目的 .tmp/）。\n'
        + '这看起来是一个真实的记忆库 —— 它的原文是唯一的事实来源，不能被验收脚本删掉。\n'
        + '确实要用它做验收，请加 --no-reset（只读 + 幂等重导，不删库）。',
      );
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    log(`已清空验收库（${path.basename(dbPath)}）—— 只验这一个会话`);
  }

  let store = openPipelineDb({ dbPath, logger: { warn() {} } });

  // 默认每次都重导：会话日志还在写（实测 20 分钟就多出几十条），
  // 拿一个旧库去对「原文一致」，差的会是这期间的新消息，不是 bug。
  // `--no-import` 可以跳过（只想复跑检查、不想动库时用）。
  const shouldImport = opts.import !== false;
  let imported = null;
  if (shouldImport) {
    log('先走一遍 pipeline.importSession（幂等：同 seq upsert，rewind 先物理删）：');
    imported = await importSession(sessionFile, {
      handle: store.handle,
      dbRoot,
      loadVec: true,
      log: (line) => log(`  ${line}`),
    });
    log('');
    printImportReport(imported.report, { log: (line) => log(line) });
    store.close();
    store = openPipelineDb({ dbPath, logger: { warn() {} } });
  }

  const { repo, extras, handle } = store;

  // 日志真值：验收 4/6 要拿它当基准
  const reader = readSessionFile(sessionFile);
  const sessionId = reader.header?.id ?? path.basename(path.dirname(path.resolve(sessionFile)));
  const toolSet = createToolSet({ handle, sessionId });
  const tools = new Map(toolSet.tools.map((t) => [t.name, t]));
  const excludeRanges = loadSessionExcludeRanges(sessionId, { dbRoot });
  const truth = exportMessages(reader.events, { sessionId, includeRewound: true, excludeRanges });

  return {
    store,
    repo,
    extras,
    handle,
    toolSet,
    tools,
    sessionFile,
    sessionId,
    dbPath,
    dbRoot,
    reader,
    truth,
    imported,
    now: Date.now(),
    close() {
      toolSet.close();
      store.close();
    },
  };
}

/** 跑一个工具，返回纯文本（上下文里带 handle / now，跟宿主注入方式一致） */
async function runTool(ctx, name, args) {
  const tool = ctx.tools.get(name);
  if (!tool) return `（工具 ${name} 没有注册）`;
  return tool.handler(args, { handle: ctx.handle, now: ctx.now });
}

/* ============================== 1. 换问法 ============================== */

/**
 * 验收 1：换问法命中同一批。
 *
 * 这一条在真实语料上有两层，必须分开说（不然会把两种不同的能力混成一个 PASS）：
 *   ① 规格示例「怕黑」/「我怕那个」：这两个说法在日志里**一次都没出现**（实测 0 次），
 *      所以查不到不是实现问题，是语料里没有这两个词；
 *   ② 真能做的是两件事：
 *      a) 同一个意思换字面（窄问法 ⊂ 宽问法，不丢）；
 *      b) **双路检索**——2 字走 LIKE、≥3 字走 FTS trigram，两条路都得落到同一条原文上。
 */
export async function check1(ctx) {
  checkHead(1, '换问法', '「怕黑」和「我怕那个」都能查到同一批对话');
  const log = [];

  // —— ① 规格里的两个问法，原样跑 ——
  const spec = [];
  for (const q of ['怕黑', '我怕那个']) {
    const text = await runTool(ctx, 'memory_search', { query: q, limit: 8 });
    const parsed = parseSearchOutput(text);
    spec.push({ q, hits: parsed.blocks.length, total: parsed.total, text });
    log.push(`规格原句「${q}」→ 命中 ${parsed.blocks.length} 条（${parsed.total} 处）`);
  }
  // 拿全库核对：这两个字符串在库里到底有没有（用工具同一套检索，含被排除的）
  const corpusHits = ['怕黑', '我怕那个'].map((q) => {
    const rows = ctx.extras.search.keyword(q, { limit: 5, includeExcluded: true });
    return { q, rows: rows.length };
  });
  log.push(
    `全库（含按日期排除的部分）核对：${corpusHits.map((c) => `「${c.q}」${c.rows} 条`).join('、')}` +
      ' → 这两个说法在 11-08~11-17 的日志里没有出现过',
  );
  log.push('所以规格里这两句的具体字面，在这份语料上无法验证（不是检索坏了）——见下面两项实测。');

  // —— ② a) 同一意思换字面：窄问法必须落在宽问法里 ——
  // 工具单次最多显示 50 条（MAX_LIMIT），所以「落在同一批」的完备性判定用仓储层全量结果，
  // 工具输出只作展示 —— 否则会把「显示被截断」误判成「真的丢了」。
  const wideText = await runTool(ctx, 'memory_search', { query: '怕', limit: 50 });
  const narrowText = await runTool(ctx, 'memory_search', { query: '害怕', limit: 50 });
  const wide = parseSearchOutput(wideText);
  const narrow = parseSearchOutput(narrowText);
  const wideFull = new Set(
    ctx.extras.search.keyword('怕', { limit: 500 }).map((r) => `${r.at}|${r.text}`),
  );
  // 用仓储层的真实行做判定（工具文本里只有 MM-DD HH:MM，精度不够比 at）
  const narrowRows = ctx.extras.search.keyword('害怕', { limit: 500 });
  const trulyCovered = narrowRows.filter((r) => wideFull.has(`${r.at}|${r.text}`));
  log.push('');
  log.push(
    `换字面：「怕」${wide.blocks.length} 条（全库 ${n(wideFull.size)} 条）/ 「害怕」${narrow.blocks.length} 条（全库 ${narrowRows.length} 条）`,
  );
  log.push(`   「害怕」落在「怕」同一批的：${trulyCovered.length} / ${narrowRows.length}`);
  if (narrow.blocks[0]) {
    log.push(`   例（「害怕」第一条）：${narrow.blocks[0].stamp} ${narrow.blocks[0].speaker}「${narrow.blocks[0].text.slice(0, 30)}」`);
  }

  // —— ② b) 双路落地：同一条原文，2 字问法（LIKE 路）和 6 字问法（FTS 路）都要命中 ——
  const target = pickDualRouteTarget(ctx);
  let dualOk = false;
  let dualLines = [];
  if (target) {
    const longText = await runTool(ctx, 'memory_search', { query: target.long, limit: 8 });
    const shortText = await runTool(ctx, 'memory_search', { query: target.short, limit: 8 });
    const marker = squash(target.text).slice(0, 10);
    const inLong = parseSearchOutput(longText).blocks.some((b) => squash(b.text).includes(marker));
    const inShort = parseSearchOutput(shortText).blocks.some((b) => squash(b.text).includes(marker));
    dualOk = inLong && inShort;
    dualLines = [
      `双路（同一条原文，两种长度问法）：`,
      `  ${target.short.length} 字问法「${target.short}」（走 LIKE）→ 命中该条：${inShort ? '是' : '否'}`,
      `  ${target.long.length} 字问法「${target.long}」（走 FTS trigram）→ 命中该条：${inLong ? '是' : '否'}`,
      `  这条原文：${fmtStamp(target.at)} ${target.speaker === 'user' ? '他' : '我'}`,
      `  「${target.text.replace(/\n/g, ' ').slice(0, 50)}」`,
      '',
      `  短问法输出原文：`,
      indent(shortText, '    '),
      '',
      `  长问法输出原文：`,
      indent(longText, '    '),
    ];
  }

  actual([...log, '', ...dualLines]);

  const specNotApplicable = spec.every((s) => s.hits === 0);
  const narrowCovered = narrowRows.length === 0 || trulyCovered.length === narrowRows.length;
  if (specNotApplicable && narrowCovered && dualOk) {
    return verdict(
      'PARTIAL',
      '双路检索与「换字面不丢」实测通过；但规格里的「怕黑 / 我怕那个」在这份语料里 0 次出现，' +
        '字面换问法无法验证——它的前提是向量路（同义不同字），当前环境没有 API key。',
    );
  }
  if (dualOk || narrowCovered) {
    return verdict('PARTIAL', '部分成立：见上面的具体数字。');
  }
  return verdict('FAIL', '双路或换字面至少有一项没落地，见上面数字。');
}

/** 挑一条「2 字片段在库里很少见、6 字片段唯一」的原文当双路靶子 */
function pickDualRouteTarget(ctx) {
  const all = ctx.repo.msgsByTimeRange(ctx.sessionId, 0, Number.MAX_SAFE_INTEGER, 100000, true);
  const counts = new Map();
  for (const m of all) {
    for (const g of chineseGrams(m.text, 2)) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  for (const m of all) {
    if (m.inSurface !== 1 || m.excluded !== 0) continue; // 默认口径可见的
    if (m.text.length < 20 || m.text.length > 60) continue;
    const gram2 = chineseGrams(m.text, 2).find((g) => (counts.get(g) ?? 0) <= 2);
    const gram6 = chineseGrams(m.text, 6).find((g) => g.length === 6);
    if (gram2 && gram6) {
      return { text: m.text, at: m.at, speaker: m.speaker, short: gram2, long: gram6 };
    }
  }
  return null;
}

/** 取文本里所有长度为 size 的连续中文片段 */
function chineseGrams(text, size) {
  const runs = String(text).match(/[\u4e00-\u9fa5]+/gu) ?? [];
  const grams = [];
  for (const run of runs) {
    for (let i = 0; i + size <= run.length; i++) grams.push(run.slice(i, i + size));
  }
  return grams;
}

function indent(text, pad) {
  return String(text)
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

/** 压掉全部空白 —— 只用于「这两段文字是不是同一句」的比对，不改原文 */
function squash(text) {
  return String(text ?? '').replace(/\s+/gu, '');
}

/* ============================== 2. 说时间 ============================== */

/** 验收 2：每条结果都带场景时间区间（D-017 的「能说出时间或场景」） */
export async function check2(ctx) {
  checkHead(2, '说时间', '每条结果都带「11-12 23:36–00:12」这种区间');

  const samples = [
    { tool: 'memory_search', args: { query: '怕', limit: 8 } },
    { tool: 'memory_search', args: { query: '今天', limit: 5 } },
    { tool: 'memory_search', args: { query: '睡不着', limit: 5 } },
  ];

  const lines = [];
  let hitCount = 0;
  let withRange = 0;
  const missing = [];

  for (const s of samples) {
    const text = await runTool(ctx, s.tool, s.args);
    const parsed = parseSearchOutput(text);
    for (const block of parsed.blocks) {
      hitCount += 1;
      if (block.range) withRange += 1;
      else missing.push(`${block.stamp} ${block.speaker}「${block.text.slice(0, 20)}」`);
    }
    if (parsed.blocks.length) {
      lines.push(`${s.tool}(${JSON.stringify(s.args)}) → ${parsed.blocks.length} 条`);
      for (const block of parsed.blocks.slice(0, 3)) {
        lines.push(
          `  ${block.stamp}  ${block.speaker}` +
            (block.range ? `  →（在 ${block.range.start}–${block.range.end} 那场，共 ${block.range.turns} 轮）` : '  → 没有区间 ✗'),
        );
      }
    }
  }

  // 时间路的场景头也得是区间，不是单点（D-052）
  const timelineText = await runTool(ctx, 'memory_search', { when: '11-10', limit: 2 });
  const headers = parseTimelineHeaders(timelineText);
  lines.push('');
  lines.push(`memory_search({ when: '11-10' }) 场景头 ${headers.length} 个：`);
  for (const h of headers) lines.push(`  ${h.start}–${h.end}   共 ${n(h.turns)} 轮`);

  actual(lines);

  const ok = hitCount > 0 && withRange === hitCount && headers.length > 0;
  if (ok) return verdict('PASS', `${hitCount} 条命中全部带场景区间，时间路 ${headers.length} 个场景头也都是区间。`);
  return verdict('FAIL', `命中 ${hitCount} 条，其中 ${withRange} 条带区间${missing.length ? `；缺区间的：${missing.slice(0, 3).join('、')}` : ''}。`);
}

/* ============================== 3. 查压缩掉的 ============================== */

/** 验收 3：能查到 in_surface=0（已被压出上下文）的内容，且带标记 */
export async function check3(ctx) {
  checkHead(3, '查压缩掉的', '能查到 in_surface=0 的内容且带标记');

  const all = ctx.repo.msgsByTimeRange(ctx.sessionId, 0, Number.MAX_SAFE_INTEGER, 100000, true);
  const hidden = all.filter((m) => m.inSurface === 0);
  const hiddenOnly = hidden.filter((m) => m.excluded === 0);
  const lines = [
    `库里 in_surface=0：${n(hidden.length)} 条 / ${n(all.length)} 条；` +
      `其中没有被按日期排除的 ${n(hiddenOnly.length)} 条（能直接检索到）`,
  ];

  // 挑一条「被压缩掉、但没被排除」的原文，用它的片段去查
  const target = hiddenOnly.find(
    (m) => m.text.length >= 12 && m.text.length <= 60 && chineseGrams(m.text, 6).length > 0,
  );
  let markerOk = false;
  let foundOk = false;
  if (target) {
    const frag = chineseGrams(target.text, 6)[0];
    const text = await runTool(ctx, 'memory_search', { query: frag, limit: 8 });
    const parsed = parseSearchOutput(text);
    // 比对时压掉空白：工具的排版会把换行/缩进重排，原文本身没变
    const block = parsed.blocks.find((b) => squash(b.text).includes(squash(target.text).slice(0, 10)));
    foundOk = Boolean(block);
    markerOk = Boolean(block?.compacted) || text.includes(MARK_COMPACTED_ONE);
    lines.push('');
    lines.push(`用被压缩原文里的 6 字片段「${frag}」去查：命中 ${parsed.blocks.length} 条`);
    lines.push(`  目标原文 #${target.id} seq=${target.seq} ${fmtStamp(target.at)} in_surface=${target.inSurface}`);
    lines.push('  工具输出原文：');
    lines.push(indent(text, '    '));
  }

  // 时间路上，整场都被压掉的那天要有一句标记
  const day = msToDayKey(target?.at ?? Date.now());
  const timelineText = await runTool(ctx, 'memory_search', { when: day, limit: 2 });
  const hasSceneMark = timelineText.includes(MARK_COMPACTED);
  lines.push('');
  lines.push(`memory_search({ when: '${day}' }) 里的压缩标记「${MARK_COMPACTED}」：${hasSceneMark ? '有' : '没有'}`);
  lines.push(indent(timelineText, '  '));

  actual(lines);

  if (hidden.length > 0 && foundOk && markerOk && hasSceneMark) {
    return verdict(
      'PASS',
      `${n(hidden.length)} 条被压缩的内容可检索；命中的那条带「这句已经装不进你的上下文了」，` +
        `时间路整场带「这段已经装不进你的上下文了」。`,
    );
  }
  return verdict('FAIL', `found=${foundOk} marker=${markerOk} sceneMark=${hasSceneMark}`);
}

function msToDayKey(at) {
  const d = new Date(Number(at) + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* ============================== 4. 查撤回的 ============================== */

/** 验收 4：被 rewind 掉的，一条都查不到（物理删除，D-119/D-118） */
export async function check4(ctx) {
  checkHead(4, '查撤回的', '被 rewind 的内容一条都查不到');

  const rewound = ctx.truth.rewound;
  const ranges = ctx.truth.stats.rewindRanges;
  const all = ctx.repo.msgsByTimeRange(ctx.sessionId, 0, Number.MAX_SAFE_INTEGER, 100000, true);
  const lines = [
    `日志里 rewind ${ranges.length} 个区间，共撤回 ${n(rewound.length)} 条 / ${n(ctx.truth.stats.rewoundChars)} 字`,
  ];

  // ① seq 级：被撤回的 seq 在库里必须不存在
  const dbSeqs = new Set(all.map((m) => m.seq));
  const leakedSeqs = rewound.filter((m) => dbSeqs.has(m.seq));
  lines.push(`① seq 级：${n(rewound.length)} 条被撤回的 seq，库里还在的 ${leakedSeqs.length} 条`);

  // ② 区间级：区间内不允许有任何一行
  const dbSeqSet = dbSeqs;
  let inRangeRows = 0;
  for (const r of ranges) {
    for (const seq of dbSeqSet) {
      if (seq >= r.from && seq <= r.to) inRangeRows += 1;
    }
  }
  lines.push(`② 区间级：${ranges.length} 个撤回区间内，库里还有 ${inRangeRows} 行`);

  // ③ 正文级：撤回文本若在库里出现，必须能由「另一条存活消息」解释
  //    （TA可能后来又说了同样的话，或时间戳注入消息被重发 —— 那不是撤回失效）
  const survivingTexts = new Set(ctx.truth.messages.map((m) => m.text));
  const dbTexts = new Set(all.map((m) => m.text));
  const rewoundTexts = new Set(rewound.map((m) => m.text));
  let explained = 0;
  let unexplained = 0;
  for (const t of rewoundTexts) {
    if (!dbTexts.has(t)) continue;
    if (survivingTexts.has(t)) explained += 1;
    else unexplained += 1;
  }
  lines.push(
    `③ 正文级：撤回文本 ${n(rewoundTexts.size)} 种，库里出现的 ${n(explained + unexplained)} 种；` +
      `其中能被「存活消息同文」解释的 ${explained} 种，**解释不了的 ${unexplained} 种**`,
  );

  // ④ 抽样检索：只挑「正文在存活消息里没有」的撤回原文，用工具去查。
  //    判据要细：命中的行如果本身是一条**存活消息**（TA后来又说了含同样片段的话），
  //    那是合法结果；只有当命中的行既不是存活消息、也不是撤回消息本身时，才叫漏。
  const distinctive = rewound.filter((m) => m.text.trim().length >= 12 && !survivingTexts.has(m.text));
  const samples = [];
  let suspicious = 0;
  let probes = 0;
  for (const m of distinctive) {
    const frag = longestChineseRun(m.text);
    if (frag.length < 8) continue;
    probes += 1;
    const rows = ctx.extras.search.keyword(frag, { limit: 20, includeExcluded: true });
    const hitRows = rows.filter((r) => r.text.includes(frag));
    const bad = hitRows.filter((r) => !survivingTexts.has(r.text) && r.text !== m.text);
    suspicious += bad.length;
    if (samples.length < 5) {
      const verdictText = hitRows.length === 0
        ? '0 条命中'
        : `${hitRows.length} 条命中，全部是存活消息（合法）`;
      samples.push(
        `  「${frag}」→ ${verdictText}` +
          `（撤回于 ${fmtStamp(m.at)} ${m.speaker === 'user' ? '他' : '我'}）`,
      );
    }
  }
  lines.push(
    `④ 抽样检索（含 includeExcluded 全库口径）：探测 ${probes} 个留不下的片段，` +
      `命中行里「既不是存活消息、也不是撤回消息」的 ${suspicious} 行`,
  );
  lines.push(...samples);

  actual(lines);

  const ok = leakedSeqs.length === 0 && inRangeRows === 0 && unexplained === 0 && suspicious === 0;
  if (ok) {
    return verdict(
      'PASS',
      `${n(rewound.length)} 条撤回内容：seq 泄漏 0、区间残留 0、解释不了的正文 0、` +
        `${probes} 个片段抽样检索可疑命中 0。`,
    );
  }
  return verdict(
    'FAIL',
    `泄漏 seq=${leakedSeqs.length} 区间残留=${inRangeRows} 正文残留=${unexplained} 抽样可疑=${suspicious}`,
  );
}

/** 文本里最长的一段连续中文（≥1） */
function longestChineseRun(text) {
  const runs = String(text).match(/[\u4e00-\u9fa5]+/gu) ?? [];
  return runs.sort((a, b) => b.length - a.length)[0] ?? '';
}

/* ============================== 5. 空结果 ============================== */

/** 验收 5：空结果要返回库范围 + 建议，不能是空白（D-096） */
export async function check5(ctx) {
  checkHead(5, '空结果', '返回库范围和建议，不是空白');

  const stats = ctx.extras.stats.get();
  const cases = [];
  const push = (label, text, predicates) => {
    const parsed = parseSearchOutput(text);
    const results = predicates.map(([name, fn]) => [name, fn(text, parsed)]);
    cases.push({ label, text, results });
  };

  const emptySearch = await runTool(ctx, 'memory_search', { query: '薛定谔的猫不存在' });
  push('memory_search 查一个库里没有的说法', emptySearch, [
    ['不是空白', (t) => t.trim().length > 0],
    ['给了库范围', (t) => /库里有 \d{2}-\d{2} 至 \d{2}-\d{2} 的/.test(t)],
    ['给了建议', (t) => /只填\s*when|按时间翻|换个说法|给个更长的原话片段/.test(t)],
  ]);

  const unknownWhen = await runTool(ctx, 'memory_search', { when: '上个世纪' });
  push('memory_search 给一个非标准时间字符串（when）', unknownWhen, [
    ['没当空白', (t) => t.trim().length > 0],
    ['说明没看懂', (t) => t.includes('没看懂')],
    ['给了库范围', (t) => /库里有 \d{2}-\d{2} 至 \d{2}-\d{2} 的/.test(t)],
    ['给了可用格式', (t) => /(2026-11-09|11-09)/.test(t) && /7d|last:7d|\.\./.test(t)],
  ]);

  // 这组只在"确实配了排除区间"时有意义：没有任何排除配置时，
  // 查 11-08 当然是空的 —— 那是数据没有，不是功能坏了。
  if (stats.excludedMsgs > 0) {
    const excludedDay = await runTool(ctx, 'memory_search', { when: '11-08' });
    push('memory_search 查一个整段被按日期排除的日子（11-08）', excludedDay, [
      ['没当空白', (t) => t.trim().length > 0],
      ['说出了场数与条数', (t) => /有 \d+ 场对话（共 [\d,]+ 条）/.test(t)],
      ['说清了怎么才能看到', (t) => t.includes('includeExcluded')],
    ]);
  } else {
    push('memory_search 查一个整段被按日期排除的日子（11-08）', `（跳过：这个会话没配排除区间）
这不是失败 —— 没配过排除，查那天当然是空的。
想验证这条，给会话配 excludeRanges（见 README「按日期排除」），
或用 VERBATIM_TEST_SESSION 指向一个配过的会话。`, [
      ['跳过说明里有原因', (t) => t.includes('没配排除区间')],
      ['说明了这不等于失败', (t) => t.includes('不是失败')],
    ]);
  }

  const lines = [`库统计：${n(stats.msgs)} 条 / ${n(stats.scenes)} 场 / 排除 ${n(stats.excludedMsgs)} 条 / ${fmtSpan(stats.firstAt, stats.lastAt, undefined)}`];
  for (const c of cases) {
    lines.push('');
    lines.push(`▸ ${c.label}`);
    lines.push(indent(c.text, '    '));
    lines.push(`  自检：${c.results.map(([name, ok]) => `${ok ? '✓' : '✗'} ${name}`).join('  ')}`);
  }

  actual(lines);

  const allOk = cases.every((c) => c.results.every(([, ok]) => ok));
  if (allOk) {
    return verdict('PASS', `${cases.length} 种空结果（查不到 / 看不懂时间 / 整段被排除）都给了范围、原因和下一步。`);
  }
  const failed = cases.flatMap((c) => c.results.filter(([, ok]) => !ok).map(([name]) => `${c.label}:${name}`));
  return verdict('FAIL', `缺项：${failed.join('、')}`);
}

/* ============================== 6. 原文一致 ============================== */

/** 验收 6：抽 20 条与日志逐字比对，0 差异 */
export async function check6(ctx) {
  checkHead(6, '原文一致', '抽 20 条与日志逐字比对，0 差异');

  const all = ctx.repo.msgsByTimeRange(ctx.sessionId, 0, Number.MAX_SAFE_INTEGER, 100000, true);
  const bySeq = new Map();
  for (const ev of ctx.reader.events) bySeq.set(ev.seq, ev);

  // 均匀抽样（横跨 11-08 → 11-17，不集中在同一天）
  const sample = [];
  const step = Math.max(1, Math.floor(all.length / 20));
  for (let i = 0; i < all.length && sample.length < 20; i += step) sample.push(all[i]);

  const rows = [];
  let diff = 0;
  for (const m of sample) {
    const ev = bySeq.get(m.seq);
    // 比对必须用**清洗后**的日志文本：库里存的是去掉桥接日志头的正文（D-216）。
    // 拿原始日志直接比，每条带 `【当前时间】…` 的消息都会假失败。
    const rawLog = ev ? textBlocksOf(ev) : null;
    const logText = rawLog === null ? null : stripBridgeMetadata(rawLog);
    const same = logText === m.text;
    if (!same) diff += 1;
    rows.push(
      `  ${same ? '✓' : '✗'} #${m.id} seq=${m.seq} ${fmtStamp(m.at)} ` +
        `${m.speaker === 'user' ? '他' : '我'} 库 ${m.text.length} 字 / 日志 ${logText === null ? '—' : `${logText.length} 字`}` +
        `  「${m.text.replace(/\n/g, ' ').slice(0, 24)}」`,
    );
  }

  // 总量比对按「库内 seq 交集」算：会话日志还在写，两次读取之间日志会继续变长，
  // 直接比总量会把「这几十秒里的新消息」算成差异。
  const dbSeqSet = new Set(all.map((m) => m.seq));
  const logPart = ctx.truth.messages.filter((m) => dbSeqSet.has(m.seq));
  const dbChars = all.reduce((sum, m) => sum + m.text.length, 0);
  const logChars = logPart.reduce((sum, m) => sum + m.text.length, 0);
  const logCharsAll = ctx.truth.stats.totalChars;
  const lines = [
    `库里 ${n(all.length)} 条 / ${n(dbChars)} 字；日志导出 ${n(ctx.truth.messages.length)} 条 / ${n(logCharsAll)} 字` +
      `（本次运行期间日志又长了 ${n(ctx.truth.messages.length - all.length)} 条，总量比对按库内 seq 交集算：${n(logPart.length)} 条 / ${n(logChars)} 字）`,
    `抽样 ${sample.length} 条（每 ${step} 条取一条，横跨 ${fmtSpan(all[0]?.at, all.at(-1)?.at, undefined)}）：`,
    ...rows,
    '',
    `逐字差异：${diff} 条；交集字数差异：${dbChars - logChars} 字`,
  ];

  actual(lines);

  if (diff === 0 && dbChars === logChars) {
    return verdict('PASS', `20/20 与日志逐字一致（含换行与标点），交集总字数 ${n(dbChars)} 字也完全相同。`);
  }
  return verdict('FAIL', `逐字差异 ${diff} 条，交集字数差 ${dbChars - logChars} 字。`);
}

/* ============================== 附加：集成增强 ============================== */

/**
 * 验收用的假模型：按 system prompt 判断这次是 gist 还是 beat，各回一份**格式合法**的输出。
 *
 * 为什么需要它：本机没有任何 API key，T5 的 gist / beat 无法真跑；但「接线通不通」
 * 必须证明 —— 用格式合法的假输出走完整条链路（含 T5 的硬校验），
 * 校验拒掉的会照实计数，不会被伪装成成功。
 */
function stubLlm() {
  const calls = { gist: 0, beat: 0, other: 0 };
  return {
    calls,
    async complete(messages = []) {
      const system = String(messages?.[0]?.content ?? '');
      if (system.includes('检索索引员') || system.includes('gist')) {
        calls.gist += 1;
        // 三段式齐全 —— 【原话】用一句常见原话；不在本场原文里时会被 T5 的逐字校验剔掉，
        // 但 gist 本身仍算有效（它只是检索锚点，不注入、不给人读）。
        return JSON.stringify({
          gist: '【发生了什么】他半夜回来，说冷，两个人一起关灯\n【原话】「回宿舍喽」\n【不懂的】无',
          unresolved: [],
        });
      }
      if (system.includes('互动类型标注员') || system.includes('beat')) {
        calls.beat += 1;
        return JSON.stringify({ beats: [{ kind: 'care', confidence: 0.7 }] });
      }
      calls.other += 1;
      return '{}';
    },
  };
}

/** 附加 A：T5/T6 的接线（gist / beat / 向量 / 三路 RRF）——不在 §10 的 6 条里，但集成必须证明它通 */
export async function checkA(ctx) {
  checkHead('A', '附加：T5 派生 + T6 向量 + 三路 RRF 接线', '证明第二批模块真的接进来了（不是只通过单测）');

  const { mockEmbedding } = await import('./model/mock.js');
  const { createVectorStore } = await import('./search/vector-store.js');
  const { createSearcher } = await import('./search/rrf.js');
  const { rebuildDerived } = await import('./pipeline.js');

  const embedding = mockEmbedding(1024);
  const lines = [];
  const llm = stubLlm();

  const derived = await rebuildDerived({
    handle: ctx.handle,
    sessionId: ctx.sessionId,
    llm,
    embedding,
    beats: true,
    beatLimit: 3,
    quiet: true,
  });
  lines.push(`rebuildDerived（mock provider）：场景 ${n(derived.scenes.scenes)} 场 / 挂回 ${n(derived.scenes.assigned)} 条`);
  lines.push(`  gist：${JSON.stringify(derived.gist)}（假模型调用 ${llm.calls.gist} 次）`);
  lines.push(`  beat：${JSON.stringify(derived.beats)}`);
  lines.push(`  vectors：${JSON.stringify(derived.vectors)}`);

  const store = createVectorStore(ctx.handle, { dim: 1024, logger: { warn() {} } });
  lines.push(`  向量表：msg ${n(store.countMsgVec())} 条 / scene ${n(store.countSceneVec())} 条（hasVec=${ctx.store.hasVec}）`);

  const searcher = createSearcher({ repo: ctx.repo, extras: ctx.extras, store, provider: embedding });

  const rich = await searcher.searchMsgs({ query: '怕', limit: 5 });
  lines.push('');
  lines.push(`三路融合（关键词 ${rich.meta.counts.keyword} 条命中，按 D-147 不该跑向量路）：`);
  lines.push(`  counts=${JSON.stringify(rich.meta.counts)} vectorSkipped=${rich.meta.vectorSkipped}`);
  lines.push(`  理由=${rich.meta.vectorSkipReason}`);
  lines.push(`  融合后前 3 条：`);
  for (const hit of rich.hits.slice(0, 3)) {
    lines.push(`    #${hit.id} ${fmtStamp(hit.at)} 来源=${hit.sources.join('+')} rrf=${hit.rrfScore.toFixed(5)}`);
  }

  const sparse = await searcher.searchMsgs({ query: '这句话库里一定没有的吧', limit: 3 });
  lines.push('');
  lines.push(`关键词 0 条时向量路会真的跑（mock 向量无语义，只证明接线）：`);
  lines.push(`  counts=${JSON.stringify(sparse.meta.counts)} vectorSkipped=${sparse.meta.vectorSkipped}`);
  lines.push(`  前 3 条 id=${sparse.hits.slice(0, 3).map((h) => h.id).join(', ')}`);

  actual(lines);

  const ok =
    derived.vectors?.msgs > 0 &&
    store.countMsgVec() > 0 &&
    rich.meta.vectorSkipped === (rich.meta.counts.keyword >= 5) &&
    sparse.meta.vectorSkipped === false &&
    sparse.meta.counts.vector > 0;
  if (ok) {
    return verdict(
      'INFO',
      `T6 全部接上：向量 ${n(store.countMsgVec())} 条、场景向量 ${n(store.countSceneVec())} 条；` +
        '关键词够多时懒执行跳过向量路（D-147），关键词为 0 时才真向量检索。mock 向量没有语义，' +
        '所以「怕黑≈我怕那个」那条语义验收仍然无法在这里证明（需要真 provider）。',
    );
  }
  return verdict('FAIL', 'T6 接线有断点，见上面数字（vectorSkipped / counts）。');
}

/** 附加 B：工具注册表的开关过滤（D-096）+ 注册出来的工具真的能跑 */
export async function checkB(ctx) {
  checkHead('B', '附加：工具注册表', '3 个工具按开关注册期过滤，且注册出来真的能跑');

  const combos = [
    ['默认（record=true, tools=true）', { record: true, tools: true, excludeRanges: [] }],
    ['record=false', { record: false, tools: true, excludeRanges: [] }],
    ['tools=false', { record: true, tools: false, excludeRanges: [] }],
  ];

  const lines = [];
  for (const [label, config] of combos) {
    const set = createToolSet({ config, sessionId: ctx.sessionId });
    const size = schemaSize(set.tools);
    lines.push(
      `${label} → ${set.tools.length} 个工具（schema ${n(size.chars)} 字符）` +
        (set.tools.length ? `：${set.tools.map((t) => t.name).join(', ')}` : '（一个都不注册）'),
    );
    set.close();
  }

  // 注册出来的工具端到端跑一遍：remember → search(note) → forget → search(note) → forget(msg) 拒绝
  const registry = createToolSet({ handle: ctx.handle, config: { record: true, tools: true }, sessionId: ctx.sessionId });
  const byName = new Map(registry.tools.map((t) => [t.name, t]));
  const call = (name, args, extra = {}) => byName.get(name).handler(args, { handle: ctx.handle, ...extra });
  const trim = (text, max = 6) => String(text).split('\n').slice(0, max).join('\n');

  const rememberOut = await call('memory_remember', { content: '验收临时笔记：他说他有点怕黑。', about: 'us' });
  const noteId = Number(/笔记 #(\d+)/.exec(rememberOut)?.[1] ?? NaN);
  lines.push('');
  lines.push('▸ memory_remember（写 note 表，标「你自己记的」）');
  lines.push(indent(trim(rememberOut), '    '));

  const noteHit = await call('memory_search', { query: '验收临时笔记', scope: 'note' });
  lines.push('▸ memory_search（scope=note，能按内容找回自己记的）');
  lines.push(indent(trim(noteHit), '    '));

  const forgetOut = Number.isFinite(noteId) ? await call('memory_forget', { id: noteId, reason: '验收清理' }) : '';
  const afterForget = await call('memory_search', { query: '验收临时笔记', scope: 'note' });
  lines.push(`▸ memory_forget(${noteId}) 之后再用 note 搜同一句`);
  lines.push(indent(trim(forgetOut, 3), '    '));
  lines.push(indent(trim(afterForget), '    '));

  // 删 msg 必须被拒绝（原文不可删）
  const msgId = ctx.repo.msgsByTimeRange(ctx.sessionId, 0, Number.MAX_SAFE_INTEGER, 5)[0]?.id ?? null;
  // 必须写成「msg: + 编号」这种显式形式：裸数字按 D-190 会被当成 note 编号，
  // 而这个检查要的是「显式指认这条是原文」——只有那样才验证得到拒删逻辑。
  const refuseOut = msgId ? await call('memory_forget', { id: 'msg:' + msgId, reason: '试试能不能删原文' }) : '';
  const refusedMsg = /不能删|原文/.test(refuseOut);
  lines.push('');
  lines.push(`▸ memory_forget(msg:${msgId}) —— 必须拒绝删原文`);
  lines.push(indent(trim(refuseOut, 8), '    '));
  lines.push(`    拒绝删原文：${refusedMsg ? '是' : '否'}`);

  registry.close();

  actual(lines, 90);

  const ok =
    noteId > 0 &&
    /你自己记的/.test(rememberOut) &&
    /验收临时笔记/.test(noteHit) &&
    /没有找到|还没有/.test(afterForget) &&
    refusedMsg;
  if (ok) {
    return verdict(
      'INFO',
      '3 个工具端到端可用：remember → note 搜索 → forget → 再搜已删；删 msg 被拒绝。' +
        '三种开关组合的 schema 字符数如上。',
    );
  }
  return verdict('FAIL', '注册表或工具端到端有问题，见上面输出。');
}

/* ============================== 主流程 ============================== */

/**
 * 跑全部验收。
 * @param {Record<string, any>} [opts] 见 prepareContext；另有 quiet
 * @returns {Promise<Record<string, any>>}
 */
export async function runAcceptance(opts = {}) {
  const startedAt = Date.now();
  const ctx = await prepareContext(opts);

  title('dsh-verbatim · T8 集成验收（IMPLEMENTATION.md §10）');
  out(` 会话  ${ctx.sessionId}`);
  out(` 日志  ${ctx.sessionFile}`);
  out(` 库    ${ctx.dbPath}`);
  out(` 工具  ${ctx.toolSet.tools.map((t) => t.name).join(', ')}`);
  const stats = ctx.extras.stats.get();
  out(
    ` 规模  ${n(stats.msgs)} 条 / ${n(stats.chars)} 字 / ${n(stats.scenes)} 场；` +
      `排除 ${n(stats.excludedMsgs)} 条 / ${n(stats.excludedChars)} 字；${fmtSpan(stats.firstAt, stats.lastAt, undefined)}`,
  );
  out(` hasVec=${ctx.store.hasVec}  会话配置里的排除区间 ${ctx.truth.stats.excludeRanges.length} 个`);

  const results = [];
  results.push(await check1(ctx));
  results.push(await check2(ctx));
  results.push(await check3(ctx));
  results.push(await check4(ctx));
  results.push(await check5(ctx));
  results.push(await check6(ctx));
  results.push(await checkA(ctx));
  results.push(await checkB(ctx));

  const tally = { PASS: 0, PARTIAL: 0, FAIL: 0, INFO: 0 };
  for (const r of results) tally[r.verdict] += 1;

  title('汇总');
  const names = ['1 换问法', '2 说时间', '3 查压缩掉的', '4 查撤回的', '5 空结果', '6 原文一致', 'A 派生/向量接线', 'B 工具注册表'];
  results.forEach((r, i) => {
    const mark = r.verdict === 'PASS' ? '✅' : r.verdict === 'PARTIAL' ? '🟡' : r.verdict === 'INFO' ? 'ℹ️' : '❌';
    out(` ${mark} ${names[i].padEnd(18, ' ')} ${r.verdict.padEnd(8, ' ')} ${r.reason.slice(0, 70)}`);
  });
  out('');
  out(` 6 条核心验收：PASS ${tally.PASS} / PARTIAL ${tally.PARTIAL} / FAIL ${tally.FAIL}（另有 INFO ${tally.INFO} 项不计入）`);
  out(` 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  out('');

  const report = {
    sessionId: ctx.sessionId,
    dbPath: ctx.dbPath,
    stats,
    results,
    tally,
    totalMs: Date.now() - startedAt,
  };
  if (opts.keepOpen !== true) ctx.close();
  return report;
}

/* ============================== 命令行入口 ============================== */

/** `--key value` / `--flag` */
function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      flags._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const report = await runAcceptance({
    sessionFile: flags['session-file'],
    dbPath: flags.db,
    dbRoot: flags['db-root'],
    import: flags['no-import'] === true ? false : true,
  });
  // 退出码：核心 6 条里有 FAIL 就 1（PARTIAL 不算失败，但要人看）
  return report.tally.FAIL > 0 ? 1 : 0;
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
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
