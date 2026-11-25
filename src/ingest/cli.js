// cli.js —— 命令行入口：读会话日志、跑导出算法、打印统计
//
// 用法：
//   node src/ingest/cli.js export <session.v4.jsonl.zstd> [选项]
//   node src/ingest/cli.js list   [--sessions <dir>]
//
// export 选项：
//   --json            额外输出完整 JSON（messages 数组，给 T1 入库用）
//   --out <file>      把 messages 以 JSONL 写到文件（一行一条，T1 直接读）
//   --rewound         打印被 rewind 掉的条目（审计用，确认真的没留下）
//   --exclude-ranges <json|file>  按日期软排除区间（D-169/170）
//   --config <file>   读配置文件（形如 sessions/<id>.json）
//   --sessions <dir>  指定 sessions 根目录（list 用）
//   --no-color        纯文本输出
//
// 软排除的默认配置位置（不传 --exclude-ranges / --config 时自动找）：
//   <cwd>/sessions/<sessionId>.json
//
// 输出里最关键的是 **in_surface=0 的字数占比**：这个数字决定记忆插件的价值定位。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSessionFile,
  listSessionFiles,
} from './reader.js';
import {
  exportMessages,
  estimateSceneCount,
  toJsonLines,
  normalizeExcludeRanges,
  isBridgeTimeHead,
} from './export.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

/** 千分位 */
const n = (x) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x));

/** 百分比 */
const pct = (x) => `${(x * 100).toFixed(2)}%`;

/** epoch ms → 本地时间字符串 */
function fmtTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '(无)';
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * epoch ms → Asia/Shanghai 的日期字符串（YYYY-MM-DD）。
 * 纯算术，不依赖运行环境时区。
 */
function fmtDay(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '(无)';
  const d = new Date(ms + 8 * 3600_000);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 横线 */
const hr = (ch = '─', len = 64) => ch.repeat(len);

/**
 * 打印导出统计。
 *
 * @param {any} result  exportMessages() 的返回值
 * @param {any} readerStats  readSessionFile() 的 stats
 * @param {any} [opts]
 */
export function printExportStats(result, readerStats, opts = {}) {
  const s = result.stats;
  const color = opts.color !== false;
  const c = color ? C : Object.fromEntries(
    ['dim', 'bold', 'red', 'green', 'yellow', 'blue', 'cyan', 'magenta'].map((k) => [k, (x) => x]),
  );

  const lines = [];
  const push = (x = '') => lines.push(x);

  push(c.bold('═══ 会话导出统计 ═══'));
  push(c.dim(hr('═')));
  push(`文件      ${c.dim(readerStats.filePath)}`);
  push(`大小      ${n(readerStats.bytes)} 字节   解压自 ${n(readerStats.frames)} 个 zstd 帧（成功 ${n(readerStats.framesOk)}，失败 ${n(readerStats.framesFailed)}）`);
  push(`事件      ${n(readerStats.eventCount)} 条（seq ${n(readerStats.seqMin)} – ${n(readerStats.seqMax)}）` +
    (readerStats.badLines ? c.yellow(`  坏行 ${readerStats.badLines}`) : '') +
    (readerStats.duplicates ? c.yellow(`  重复 seq ${readerStats.duplicates}`) : ''));
  push(`时间范围  ${fmtTime(s.timeMin)} → ${fmtTime(s.timeMax)}`);
  push();

  // ── ① 总消息数与总字数 ──────────────────────────
  push(c.bold('① 入库消息'));
  push(`   总计      ${c.green(n(s.totalMessages))} 条   ${c.green(n(s.totalChars))} 字`);
  push(`   你(user)  ${n(s.userMessages)} 条`);
  push(`   TA(助手)  ${n(s.assistantMessages)} 条`);
  push();

  // ── ② in_surface=0（最关键）────────────────────
  push(c.bold('② 被压缩掉、但话还在（in_surface=0）'));
  push(`   条数      ${c.magenta(n(s.inSurface0Count))} 条   占消息 ${c.magenta(pct(s.inSurface0MsgRatio))}`);
  push(`   字数      ${c.magenta(n(s.inSurface0Chars))} 字   占字数 ${c.magenta(pct(s.inSurface0CharRatio))}   ${c.bold('← 项目价值定位')}`);
  push(c.dim(`   对照：仍在上下文里的 ${n(s.inSurface1Count)} 条 / ${n(s.inSurface1Chars)} 字`));
  push(c.dim(`   压缩次数 ${s.compactionSummaries} 次成功${s.compactionFailed ? `，${s.compactionFailed} 次失败（无 summary）` : ''}；` +
    `shadowedSeqs 累计 ${n(s.shadowedSeqTotal)} 个，去重 ${n(s.shadowedSeqUnique)} 个`));
  push();

  // ── ③ 被 rewind 排除的 ─────────────────────────
  push(c.bold('③ 被撤回、一条都没留下（rewind）'));
  push(`   rewind 事件 ${c.yellow(n(s.rewindEvents))} 次`);
  push(`   排除掉      ${c.yellow(n(s.rewoundCount))} 条   ${c.yellow(n(s.rewoundChars))} 字`);
  push();

  // ── ④ 过滤掉的系统注入 ─────────────────────────
  push(c.bold('④ 过滤掉的系统注入（占真实会话大部分字符量）'));
  push(`   按 source.kind ≠ user 过滤   ${n(s.skippedSystemByKind)} 条`);
  push(`   按文本前缀兜底过滤           ${n(s.skippedSystemByPrefix)} 条`);
  push(`   rewind 标记本身              ${n(s.skippedRewindMarker)} 条`);
  push(`   assistant 无 text 块（纯 reasoning/tool-call） ${n(s.skippedNoTextBlock)} 条`);
  push(`   空文本                       ${n(s.skippedEmptyText)} 条`);
  push(`   inbox 孤儿（投递了但 turn 被 blocked，从没发生） ${n(s.inboxOrphans)} 条 / ${n(s.inboxOrphanChars)} 字`);
  push(c.dim(`   各类 source.kind 分布：`));
  const kinds = Object.entries(s.userSourceKinds).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of kinds) {
    const mark = k === 'user' ? c.green('✓') : c.dim('✗');
    push(c.dim(`     ${mark} ${String(k).padEnd(24)} ${n(v)}`));
  }
  push();

  // 段落编号从 ⑤ 起动态分配，插新段不用改后面的数字
  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  let sec = 5;
  const nextMark = () => CIRCLED[sec - 1] ?? `${sec}`;
  const bump = () => { sec++; };

  // ── ⑤ 桥接元数据清洗 ───────────────────────────
  if (s.metadataCleaned) {
    push(c.bold(`${nextMark()} 桥接元数据清洗`));
    push(`   剥离时间戳前缀  ${c.cyan(n(s.bridgeTimePrefixCount))} 条 / ${c.cyan(n(s.bridgeTimePrefixChars))} 字`);
    push(`   剥离发送者标记  ${c.cyan(n(s.bridgeAdminMarks))} 处`);
    if (s.bridgeImageDescCount > 0) {
      push(`   图片占位保留    ${c.cyan(n(s.bridgeImagePlaceholders))} 条（描述部分去掉 ${n(s.bridgeImageDescCount)} 条 / ${n(s.bridgeImageDescChars)} 字）`);
    }
    const before = s.totalCharsBeforeClean;
    const after = s.totalChars;
    push(`   清洗后总字数    ${c.cyan(n(after))} 字（原 ${n(before)}，降 ${c.cyan(pct(s.cleanedCharRatio))}）`);
    push(c.dim('   时间已进 at、发送者已进 speaker，正文只留「你们说过的话」'));
    push();
    bump();
  }

  // ── ⑥ 按日期软排除（D-169/170）──────────────────
  // 注意：软排除与 in_surface 是**正交**的。一条消息可以既被压缩掉、
  // 又被日期排除；也可能只占其中一头。两个数不要相加。
  if (s.excludeRanges.length) {
    push(c.bold(`${nextMark()} 按日期软排除`));
    // 清洗改变了字数基数，所以两个口径都给：入库实际 / 清洗前（历史对照）
    const beforeNote = s.metadataCleaned && s.excludedCharsBeforeClean > s.excludedChars
      ? c.dim(`（清洗前 ${n(s.excludedCharsBeforeClean)} 字）`)
      : '';
    push(`   排除 ${c.yellow(n(s.excludedCount))} 条 / ${c.yellow(n(s.excludedChars))} 字${beforeNote}（占 ${c.yellow(pct(s.excludedCharRatio))}）`);
    // 逐区间明细（多区间时更有用）
    for (const h of s.excludedHits) {
      const range = `${fmtDay(h.from)} → ${fmtDay(h.to)}（不含）`;
      push(c.dim(`     · ${range}  ${n(h.count)} 条 / ${n(h.chars)} 字${h.reason ? `  原因：${h.reason}` : ''}`));
    }
    const reasons = [...new Set(s.excludedHits.map((h) => h.reason).filter(Boolean))];
    if (reasons.length) push(`   原因：${c.yellow(reasons.join('、'))}`);
    push(c.dim('   这些消息仍会入库，但检索不到'));
    push(c.dim(`   可检索：${n(s.searchableCount)} 条 / ${n(s.searchableChars)} 字`));
    push();
    bump();
  }

  // ── ⑦ 场景预估 ─────────────────────────────────
  const est = estimateSceneCount(result.messages);
  push(c.bold(`${nextMark()} 场景预估（30 分钟断点，权威切分见 T3）`));
  push(`   约 ${c.blue(n(est.scenes))} 场`);
  push();
  bump();

  // ── ⑧ rewind 明细（可选）──────────────────────
  if (opts.showRewound && result.rewound.length) {
    push(c.bold(`${nextMark()} 被撤回的条目（审计）`));
    for (const r of result.rewound.slice(0, 50)) {
      const head = r.text.replace(/\s+/g, ' ').slice(0, 60);
      push(c.dim(`   seq=${r.seq} ${r.speaker} 被 seq=${r.rewound_by_seq} 撤回  「${head}」`));
    }
    if (result.rewound.length > 50) push(c.dim(`   …还有 ${n(result.rewound.length - 50)} 条`));
    push();
  }

  // ── 断言式自检 ─────────────────────────────────
  push(c.dim(hr()));
  const checks = [
    ['被 rewind 的内容一条不剩', result.rewound.every((r) => !result.messages.some((m) => m.seq === r.seq))],
    ['in_surface=0 的消息确实在库里', s.inSurface0Count > 0 || s.compactionSummaries === 0],
    ['每条都有 text 且非空', result.messages.every((m) => typeof m.text === 'string' && m.text.trim().length > 0)],
    ['speaker 只有 user/assistant', result.messages.every((m) => m.speaker === 'user' || m.speaker === 'assistant')],
    ['seq 严格升序且唯一', result.messages.every((m, i) => i === 0 || m.seq > result.messages[i - 1].seq)],
    ['excluded 只有 0/1', result.messages.every((m) => m.excluded === 0 || m.excluded === 1)],
    // 软排除的核心：只标记，不丢弃
    ['软排除没有丢弃消息（条数不变）',
      s.excludeRanges.length === 0 || result.messages.length === s.totalMessages],
    // 清洗的核心：正文里不该再残留桥接头
    ['清洗后无残留桥接头', s.metadataCleaned
      ? result.messages.every((m) => !isBridgeTimeHead(m.text) && !m.text.startsWith('【管理员】'))
      : true],
  ];
  for (const [label, ok] of checks) {
    push(`  ${ok ? c.green('✓') : c.red('✗')} ${label}`);
  }
  push();

  const text = lines.join('\n');
  console.log(text);
  return { lines, allChecksPassed: checks.every(([, ok]) => ok) };
}

/**
 * 解析 `export` 子命令的参数。
 *
 * @param {string[]} argv
 */
function parseExportArgs(argv) {
  const opts = {
    input: null,
    out: null,
    json: false,
    showRewound: false,
    color: true,
    excludeRangesArg: null,
    configPath: null,
    cleanMetadata: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--rewound') opts.showRewound = true;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--no-clean') opts.cleanMetadata = false;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--exclude-ranges') opts.excludeRangesArg = argv[++i];
    else if (a === '--config') opts.configPath = argv[++i];
    else if (!a.startsWith('-') && !opts.input) opts.input = a;
  }
  return opts;
}

/**
 * 从一段字符串里取配置：既可以是文件路径，也可以是内联 JSON。
 *
 * @param {string} arg
 * @param {string} label 报错时的标签
 * @returns {object|null}
 */
function readConfigArg(arg, label) {
  // 先当文件路径试
  try {
    if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
      const text = fs.readFileSync(arg, 'utf8');
      return JSON.parse(text);
    }
  } catch (err) {
    console.error(`${label}: 读文件失败 ${arg}: ${err.message}`);
    return null;
  }
  // 再当内联 JSON 试
  try {
    return JSON.parse(arg);
  } catch {
    console.error(`${label}: 既不是存在的文件，也不是合法 JSON: ${arg}`);
    return null;
  }
}

/**
 * 从各种可能的配置形状里取出 excludeRanges 数组。
 * 支持：数组本身 / { excludeRanges: [...] } / { range: [...] }
 *
 * @param {any} cfg
 * @returns {Array<{from: unknown, to: unknown, reason?: string}>}
 */
function pickExcludeRanges(cfg) {
  if (!cfg) return [];
  if (Array.isArray(cfg)) return cfg;
  if (Array.isArray(cfg.excludeRanges)) return cfg.excludeRanges;
  if (Array.isArray(cfg.range)) return cfg.range;
  return [];
}

/**
 * 决定软排除区间从哪里来，优先级：
 *   1. --exclude-ranges（JSON 或文件）
 *   2. --config <file>
 *   3. 自动找 <cwd>/sessions/<sessionId>.json
 *
 * @param {any} opts parseExportArgs 的结果
 * @param {string} sessionId
 * @returns {{ ranges: any[], source: string|null }}
 */
function resolveExcludeRanges(opts, sessionId) {
  if (opts.excludeRangesArg !== undefined && opts.excludeRangesArg !== null) {
    const cfg = readConfigArg(opts.excludeRangesArg, '--exclude-ranges');
    if (cfg === null) return { ranges: [], source: null };
    return { ranges: pickExcludeRanges(cfg), source: '--exclude-ranges' };
  }

  if (opts.configPath) {
    const cfg = readConfigArg(opts.configPath, '--config');
    if (cfg === null) return { ranges: [], source: null };
    return { ranges: pickExcludeRanges(cfg), source: opts.configPath };
  }

  // 自动找 sessions/<id>.json
  const auto = path.join(process.cwd(), 'sessions', `${sessionId}.json`);
  if (fs.existsSync(auto)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(auto, 'utf8'));
      // 显示成相对路径，避免长路径把整行折断
      const shown = path.relative(process.cwd(), auto) || auto;
      return { ranges: pickExcludeRanges(cfg), source: shown };
    } catch (err) {
      console.error(`自动读取 ${auto} 失败: ${err.message}`);
      return { ranges: [], source: null };
    }
  }

  return { ranges: [], source: null };
}

/**
 * `export` 子命令。
 *
 * @param {string[]} argv
 * @returns {number} 进程退出码
 */
export function runExport(argv) {
  const opts = parseExportArgs(argv);

  if (!opts.input) {
    console.error('用法: node cli.js export <session.v4.jsonl.zstd> [--json] [--out file] [--rewound]');
    return 2;
  }
  if (!fs.existsSync(opts.input)) {
    console.error(`文件不存在: ${opts.input}`);
    return 2;
  }

  const t0 = Date.now();
  const { header, events, stats: readerStats } = readSessionFile(opts.input);
  const sessionId = header?.id ?? path.basename(path.dirname(path.resolve(opts.input)));

  // 软排除区间（D-169/170）
  const { ranges: rawRanges, source: rangesSource } = resolveExcludeRanges(opts, sessionId);
  const excludeRanges = normalizeExcludeRanges(rawRanges, {
    onWarn: (m) => console.error(`[warn] ${m}`),
  });

  const result = exportMessages(events, {
    sessionId,
    includeRewound: true,
    excludeRanges,
    cleanMetadata: opts.cleanMetadata,
  });
  const elapsed = Date.now() - t0;

  if (header) {
    console.log(`会话 ID   ${header.id}`);
    if (header.cwd) console.log(`工作目录  ${header.cwd}`);
    if (header.agentPreset) console.log(`预设      ${header.agentPreset}`);
    if (rangesSource && excludeRanges.length) {
      console.log(`软排除    ${excludeRanges.length} 个区间（来自 ${rangesSource}）`);
    }
    if (!opts.cleanMetadata) console.log('元数据清洗  已关闭（--no-clean）');
    console.log();
  }

  const { allChecksPassed } = printExportStats(result, readerStats, {
    showRewound: opts.showRewound,
    color: opts.color && process.stdout.isTTY !== false,
  });

  console.log(C.dim(`导出耗时 ${elapsed} ms（目标 < 5 s）`));

  if (opts.out) {
    fs.writeFileSync(opts.out, toJsonLines(result.messages), 'utf8');
    console.log(C.green(`已写出 ${n(result.messages.length)} 条到 ${opts.out}`));
  }
  if (opts.json) {
    console.log(JSON.stringify({
      sessionId,
      messages: result.messages,
      stats: result.stats,
      reader: readerStats,
    }));
  }

  return allChecksPassed ? 0 : 1;
}

/**
 * `list` 子命令：列出所有会话日志。
 *
 * @param {string[]} argv
 * @returns {number}
 */
export function runList(argv) {
  let root;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sessions') root = argv[++i];
  }
  const files = listSessionFiles(root);
  if (!files.length) {
    console.log('没有找到会话日志。');
    return 0;
  }
  files.sort((a, b) => b.bytes - a.bytes);
  console.log(`${n(files.length)} 个会话日志：`);
  for (const f of files) {
    console.log(`  ${C.dim(`${(f.bytes / 1024 / 1024).toFixed(1)} MB`.padStart(10))}  ${f.sessionId}`);
    console.log(C.dim(`             ${f.filePath}`));
  }
  return 0;
}

/** 主入口 */
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'export':
      process.exitCode = runExport(rest);
      break;
    case 'list':
      process.exitCode = runList(rest);
      break;
    case undefined:
    case '-h':
    case '--help':
      console.log(`dsh-verbatim 导出工具（T2）

用法:
  node cli.js export <session.v4.jsonl.zstd> [--json] [--out <file>] [--rewound] [--no-color]
                     [--exclude-ranges <json|file>] [--config <file>] [--no-clean]
  node cli.js list [--sessions <dir>]

export 会打印：
  ① 总消息数 / 总字数
  ② in_surface=0 的条数、字数、占总字数比例  ← 项目价值定位
  ③ 被 rewind 排除掉的条数
  ④ 过滤掉的系统注入数量与各 source.kind 分布
  ⑤ 桥接元数据清洗（--no-clean 时这一节不出现）
  ⑥ 按日期软排除（配置了才有）
  ⑦ 场景数粗估

桥接元数据清洗（默认开，--no-clean 关）：
  QQ 桥接层会在每条用户消息前面套一层日志头：
    【当前时间】2026/11/8 15:19:05（Asia/Shanghai）
    【管理员】<他真正说的话>
  时间已进 at、发送者已进 speaker，所以前缀是纯噪声（实测占全部字数 40%）。
  清洗只剥前缀和图片描述，正文一字不动；[图片] 占位保留（描述去掉）。
  规则幂等；只有**合法**的【当前时间】<时间>（<时区>） 才认，正文里的
  「【重要】」「【当前时间】你猜几点」不会被动。

按日期软排除（D-169/170）：
  命中区间的消息**仍然入库**，只打 excluded=1，检索时过滤掉。
  区间是左闭右开 [from, to)，时区固定 Asia/Shanghai（+08:00）。

  三种用法：
    --exclude-ranges '{"excludeRanges":[{"from":"2026-11-08","to":"2026-11-09","reason":"调试期"}]}'
    --exclude-ranges ranges.json
    --config sessions/<会话id>.json
  都不传时，自动读 ./sessions/<会话id>.json（存在才读）。

  from/to 可以写：
    "2026-11-08"                        → 按 +08:00 的当天 00:00（注意不是 UTC）
    "2026-11-08T00:00:00+08:00"          → 按串里自带的时区
    "2026-11-08T00:00:00"                → 不带时区时按 +08:00
    1794067200000                        → epoch 毫秒
`);
      break;
    default:
      console.error(`未知子命令: ${cmd}（试试 --help）`);
      process.exitCode = 2;
  }
}

// 只在被直接执行时跑 main（被测试 import 时不跑）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

export { main };
