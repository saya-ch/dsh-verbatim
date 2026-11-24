#!/usr/bin/env node
// @ts-check
/**
 * 命令行入口。日常只做三件事：导入、重建、查库概况。
 *
 *   dsh-verbatim import <session.v4.jsonl.zstd>   导入一个会话
 *   dsh-verbatim rebuild                          从原文重建派生层
 *   dsh-verbatim stat                             看一眼库里有什么
 */
import path from 'node:path';
import fs from 'node:fs';
import { importSession, rebuildDerived, openPipelineDb } from '../src/pipeline.js';
import { createRepo, createExtras } from '../src/store/repo.js';
import { defaultDbPath } from '../src/store/db.js';

const [cmd, ...rest] = process.argv.slice(2);
const dbPath = process.env.VERBATIM_DB || defaultDbPath();

function usage() {
  console.log(`dsh-verbatim 0.1.0 —— 一字不改的长期记忆

用法：
  dsh-verbatim import <会话日志>    导入一个会话（幂等，可重复跑）
  dsh-verbatim rebuild              从原文重建场景/索引
  dsh-verbatim stat                 看一眼库里有什么

环境变量：
  DSH_HOME           记忆库根目录（默认 ~/.dsh）
  VERBATIM_DB        直接指定库文件路径
`);
}

if (!cmd || cmd === '-h' || cmd === '--help') {
  usage();
  process.exit(0);
}

if (cmd === 'import') {
  const file = rest[0];
  if (!file || !fs.existsSync(file)) {
    console.error(`找不到会话日志：${file ?? '(未提供)'}`);
    process.exit(1);
  }
  await importSession(path.resolve(file), { dbPath });
} else if (cmd === 'rebuild') {
  await rebuildDerived({ dbPath });
} else if (cmd === 'stat') {
  const handle = openPipelineDb({ dbPath, logger: { warn() {} } });
  const extras = createExtras(handle);
  const s = extras.stats.get();
  console.log(`库：${dbPath}`);
  console.log(`消息 ${s.msgs} 条 / ${s.chars} 字 / 场景 ${s.scenes} 场`);
  if (s.excludedMsgs) console.log(`按日期排除 ${s.excludedMsgs} 条 / ${s.excludedChars} 字（入库但检索不到）`);
  handle.close();
} else {
  console.error(`未知命令：${cmd}`);
  usage();
  process.exit(1);
}
