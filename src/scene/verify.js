// verify.js —— 拿真实会话跑一遍切分，打印验收要的分布
//
// 跑法：
//   node src/scene/verify.js
//   node src/scene/verify.js <session.v4.jsonl.zstd> [--exclude 2026-11-08]
//
// 默认就读 T2 用的那个真实会话。本脚本只读文件、只调纯函数，不碰数据库。
//
// 打印的东西（对应任务验收清单）：
//   ① 总场数（与 T2 的 30 分钟粗估对照）
//   ② 每场时长分布 min / median / max
//   ③ 每场条数分布 min / median / max
//   ④ 有多少场跨了压缩点
//   ⑤ 有多少场含 excluded 消息
//   ⑥ 每条切分规则实际生效了多少次（回答「有没有规则没起作用」）

import path from 'node:path';

import { readSessionFile } from '../ingest/reader.js';
import { exportMessages } from '../ingest/export.js';
import {
  splitScenesWithStats,
  sceneStats,
  GAP_CUT_MS,
  MAX_SCENE_MSGS,
} from './split.js';
import { linkScenes, assignPlan } from './link.js';

// 会话路径从参数或环境变量来，不写死在仓库里（脱敏）。
// 用法：VERBATIM_TEST_SESSION=<path> node src/scene/verify.js [<path>]
const DEFAULT_SESSION = process.argv[2] ?? process.env.VERBATIM_TEST_SESSION ?? '';

/** 11-08 是 T2 定的软排除日（D-169/170），默认带上，好让 hasExcluded 有东西可测 */
const DEFAULT_EXCLUDE_FROM = '2026-11-08';

/** `2026-11-08` → 次日 00:00（+08:00），即半开区间 [11-08 00:00, 11-09 00:00) */
function dayEndExclusive(day) {
  const start = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(start)) throw new Error(`无法解析排除日：${day}`);
  return new Date(start + 86_400_000).toISOString();
}

const MIN = 60_000;

/** 分钟数，保留一位小数 */
const min = (ms) => (ms === null || ms === undefined ? '—' : (ms / MIN).toFixed(1));

/** 把时刻按 +08:00 打成 `11-12 23:36` */
function stamp(at) {
  const off = 8 * 60 * MIN;
  const d = new Date(at + off);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 解析命令行 */
function parseArgs(argv) {
  const out = {
    file: DEFAULT_SESSION,
    excludeFrom: DEFAULT_EXCLUDE_FROM,
    excludeTo: dayEndExclusive(DEFAULT_EXCLUDE_FROM),
  };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exclude') {
      // --exclude 2026-11-08  → 排除当天 [00:00, 次日 00:00)
      const from = argv[++i];
      out.excludeFrom = from;
      out.excludeTo = dayEndExclusive(from);
    } else if (a === '--no-exclude') {
      out.excludeFrom = null;
      out.excludeTo = null;
    } else if (!a.startsWith('-')) {
      rest.push(a);
    }
  }
  if (rest.length) out.file = rest[0];
  return out;
}

function bar(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function main() {
  const args = parseArgs(process.argv);

  bar('① 读日志 + 导出消息（T2 的接口）');
  const { header, events, stats: rs } = readSessionFile(args.file);
  console.log(`会话文件   ${args.file}`);
  console.log(`事件       ${rs.eventCount} 条（帧 ${rs.frames}，解压失败 ${rs.framesFailed}）`);

  const excludeRanges = args.excludeFrom
    ? [{ from: `${args.excludeFrom}T00:00:00+08:00`, to: args.excludeTo, reason: '软排除（默认带 11-08）' }]
    : [];
  const { messages, stats: es } = exportMessages(events, {
    sessionId: header?.id ?? path.basename(path.dirname(args.file)),
    excludeRanges,
  });
  console.log(`消息       ${es.totalMessages} 条 / ${es.totalChars} 字`);
  console.log(`in_surface=0  ${es.inSurface0Count} 条 / ${es.inSurface0Chars} 字（${(es.inSurface0CharRatio * 100).toFixed(1)}%）`);
  console.log(`excluded      ${es.excludedCount} 条 / ${es.excludedChars} 字${excludeRanges.length ? '' : '（未启用软排除）'}`);
  console.log(`时间范围   ${stamp(es.timeMin)} → ${stamp(es.timeMax)}`);

  bar('② 切分（IMPLEMENTATION.md §6：30 分钟 / 40 条 / 压缩点）');
  const { scenes, stats } = splitScenesWithStats(messages);
  const st = sceneStats(scenes);

  console.log(`总场数     ${stats.outputScenes}`);
  console.log(`对照：T2 只按 30 分钟断点粗估 ${countGaps(messages)} 场（本轨道多切了 ${stats.outputScenes - countGaps(messages)} 场，来自压缩点与条数上限）`);

  bar('③ 时长分布（分钟）');
  const d = st.durationMs;
  console.log(`min ${min(d.min)} ｜ median ${min(d.median)} ｜ max ${min(d.max)} ｜ mean ${min(d.mean)}`);
  const longest = scenes
    .map((s, i) => ({ i, len: s.end_at - s.start_at }))
    .sort((a, b) => b.len - a.len)
    .slice(0, 5);
  for (const { i, len } of longest) {
    const s = scenes[i];
    console.log(`  最长 ${min(len).padStart(6)} 分  ${stamp(s.start_at)}→${stamp(s.end_at)}  ${s.msg_count} 条（第 ${i + 1} 场）`);
  }

  bar('④ 条数分布');
  const c = st.msgCount;
  console.log(`min ${c.min} ｜ median ${c.median} ｜ max ${c.max} ｜ mean ${c.mean.toFixed(1)}`);
  console.log(`条数 > ${MAX_SCENE_MSGS} 的场次：${st.overMaxMsgs} 场（= 「40 条上限」被「2 分钟连续回应」否决的场）`);
  const biggest = scenes
    .map((s, i) => ({ i, n: s.msg_count }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  for (const { i, n } of biggest) {
    const s = scenes[i];
    console.log(`  最大 ${String(n).padStart(4)} 条  ${stamp(s.start_at)}→${stamp(s.end_at)}  ${min(s.end_at - s.start_at)} 分（第 ${i + 1} 场）`);
  }

  bar('⑤ 跨压缩点 / 含 excluded');
  console.log(`横跨压缩点的场次   ${st.crossesCompaction} 场`);
  for (const [i, s] of scenes.entries()) {
    if (!s.crossesCompaction) continue;
    console.log(`  第 ${i + 1} 场 ${stamp(s.start_at)}→${stamp(s.end_at)}  ${s.msg_count} 条，其中已压缩 ${s.compactedCount} 条`);
  }
  console.log(`含 excluded 的场次   ${st.withExcluded} 场`);
  for (const [i, s] of scenes.entries()) {
    if (!s.hasExcluded) continue;
    console.log(`  第 ${i + 1} 场 ${stamp(s.start_at)}→${stamp(s.end_at)}  ${s.msg_count} 条，其中被排除 ${s.excludedCount} 条`);
  }
  console.log(`含 in_surface=0 的场次 ${st.withOutOfSurface} 场（时间路工具要在这些场次末尾加「话还在」标记）`);

  bar('⑥ 切分规则实际生效情况');
  const totalCuts = stats.cutByGap + stats.cutBySize + stats.cutByCompaction + stats.cutBySession;
  console.log(`切点合计 ${totalCuts}（= 场数 ${stats.outputScenes} − 1 = ${stats.outputScenes - 1}）`);
  console.log(`  ① 间隔 > 30 分钟          ${stats.cutByGap}`);
  console.log(`  ② 单场已达 ${MAX_SCENE_MSGS} 条           ${stats.cutBySize}`);
  console.log(`  ③ 跨压缩点                ${stats.cutByCompaction}`);
  console.log(`  ④ 会话 id 变化（保护）    ${stats.cutBySession}`);
  console.log(`防断裂生效（本该切、实际没切）：`);
  console.log(`  ① 间隔 ≤ 2 分钟连续回应   ${stats.forcedJoinQuickReply} 次`);
  console.log(`  ② 沉默后首条 < 10 字      ${stats.forcedJoinShortAfterSilence} 次`);
  console.log(`被防断裂否决掉的硬切原因：间隔 ${stats.overridden.gap} ｜ ${MAX_SCENE_MSGS} 条 ${stats.overridden.size} ｜ 压缩点 ${stats.overridden.compaction}`);
  console.log(`压缩状态翻转共 ${stats.compactionFlips} 次（其中照切 ${stats.cutByCompaction}、被否决 ${stats.overridden.compaction}）`);
  console.log(`话题引入词拦下「短句并入」：引入词 ${stats.topicIntroBlocked.word} ｜ 问号 ${stats.topicIntroBlocked.question} ｜ 专名标记 ${stats.topicIntroBlocked.proper}`);

  bar('⑦ 邻接回填（T1 的 scene 列 + lead_in）');
  const linked = linkScenes(scenes);
  const plan = assignPlan(linked);
  const badGap = linked.filter((s, i) => i > 0 && s.gap_before_ms !== s.start_at - linked[i - 1].end_at).length;
  const badLead = linked.filter((s, i) => i === 0 ? s.lead_in !== '[]' : JSON.parse(s.lead_in).length === 0).length;
  console.log(`场次 ${linked.length} ｜ preceded_by/followed_by 全部回填 ｜ gap 自洽失败 ${badGap} ｜ lead_in 异常 ${badLead}`);
  console.log(`lead_in 示例（第 2 场的前一场尾巴）：`);
  for (const x of JSON.parse(linked[1].lead_in)) {
    console.log(`  ${stamp(x.at)}  ${x.speaker}  ${JSON.stringify(x.text.slice(0, 40))}`);
  }
  console.log(`回填计划（前 3 场，直接喂 extras.sceneAssign.assignSeqRange）：`);
  for (const p of plan.slice(0, 3)) {
    console.log(`  sceneId=${p.sceneId}  seq ${p.fromSeq}..${p.toSeq}  ${p.msgCount} 条  sessionId=${p.sessionId?.slice(0, 12)}…`);
  }
  const planOk = plan.every((p, i) => p.toSeq >= p.fromSeq && p.msgCount === linked[i].msg_count);
  console.log(`回填计划自洽：${planOk ? '是' : '否'}`);

  bar('⑧ 对照实验：把 40 条改成硬上限（forceJoinOverridesMax=false）');
  const strict = splitScenesWithStats(messages, { forceJoinOverridesMax: false });
  const strictSt = sceneStats(strict.scenes);
  console.log(`场数 ${stats.outputScenes} → ${strict.scenes.length}（+${strict.scenes.length - stats.outputScenes}）`);
  console.log(`条数 max ${st.msgCount.max} → ${strictSt.msgCount.max}；> ${MAX_SCENE_MSGS} 条的场次 ${st.overMaxMsgs} → ${strictSt.overMaxMsgs}`);
  console.log(`时长 max ${min(st.durationMs.max)} → ${min(strictSt.durationMs.max)} 分钟`);

  bar('结论要点');
  const rules = [
    ['间隔 > 30 分钟', stats.cutByGap],
    [`单场 ${MAX_SCENE_MSGS} 条`, stats.cutBySize],
    ['跨压缩点', stats.cutByCompaction],
    ['2 分钟内连续回应（防断裂）', stats.forcedJoinQuickReply],
    ['沉默后短句归前场（防断裂）', stats.forcedJoinShortAfterSilence],
    ['话题引入词（用于否决并入）', stats.topicIntroBlocked.word + stats.topicIntroBlocked.question + stats.topicIntroBlocked.proper],
  ];
  for (const [name, n] of rules) {
    if (n === 0) console.log(`  ⚠ 「${name}」在真实数据里一次都没生效`);
  }
  if (rules.every(([, n]) => n > 0)) console.log('  六条规则在真实数据上全部生效过。');
  console.log(`  阈值为 ${GAP_CUT_MS / MIN} 分钟 / ${MAX_SCENE_MSGS} 条；场景时长中位数 ${min(st.durationMs.median)} 分钟、条数中位数 ${st.msgCount.median} 条。`);
}

/** 只按 30 分钟间隔粗估场数（对照用，对应 T2 的 estimateSceneCount） */
function countGaps(messages) {
  if (!messages.length) return 0;
  const sorted = messages.slice().sort((a, b) => a.at - b.at || a.seq - b.seq);
  let n = 1;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].at - sorted[i - 1].at > GAP_CUT_MS) n++;
  return n;
}

main();
