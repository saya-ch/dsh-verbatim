#!/usr/bin/env node
/**
 * MCP server —— 三个记忆工具的唯一对外出口。
 *
 * 为什么需要这个文件：工具实现得再好，没有 MCP 入口，宿主就调不到。
 *
 * 用法（stdio JSON-RPC，MCP 标准）：
 *   node bin/mcp-memory.mjs
 *
 * 环境变量：
 *   DSH_HOME              会话日志与记忆库的根（默认 ~/.dsh）
 *   VERBATIM_DB           直接指定库文件（默认 $DSH_HOME/verbatim/memory.db）
 *   VERBATIM_SESSION      指定要同步哪个会话的日志文件
 *                         （不指定则自动找最近修改的那个 —— 通常就是"当前会话"）
 *   VERBATIM_AUTOSYNC     设为 0 关掉"调用前自动增量同步"
 *
 * 设计要点：MCP server 是被动进程，不知道 DSH 当前在哪个会话。
 * 所以每次工具调用前，检查会话日志的 mtime，变了就增量同步一次
 * （`importSession` 是幂等 upsert，重复跑不会出问题）。
 * 这样才能"边聊边查得到"。
 *
 * 注意：stdout 是 JSON-RPC 流，**任何调试输出都必须走 stderr**。
 */

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openDb, defaultDbPath } from '../src/store/db.js';
import { createRepo, createExtras } from '../src/store/repo.js';
import { createToolSet } from '../src/tools/index.js';
import { loadGlobalConfig } from '../src/config/global-config.js';
import { loadSessionConfig } from '../src/config/session-config.js';
import { importSession } from '../src/pipeline.js';

const VERSION = '0.1.0';
const log = (...args) => console.error('[verbatim-mcp]', ...args);

/* ───────────────────────── 找会话日志 ───────────────────────── */

/** 在 $DSH_HOME/sessions 下收集全部 session.v4.jsonl.zstd 并按 mtime 倒序排列 */
function discoverSessions() {
  const root = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions');
  if (!fs.existsSync(root)) return [];

  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'session.v4.jsonl.zstd') {
        try {
          const mtimeMs = fs.statSync(p).mtimeMs;
          found.push({ file: p, sessionId: path.basename(path.dirname(p)), mtimeMs });
        } catch { /* 读不到就跳过 */ }
      }
    }
  };
  try { walk(root, 0); } catch { /* 权限问题当没找到 */ }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

function resolvePinnedSession() {
  if (process.env.VERBATIM_SESSION) return process.env.VERBATIM_SESSION;
  const targetId = process.env.VERBATIM_SESSION_ID?.trim();
  if (!targetId) return null;
  const match = discoverSessions().find((s) => s.sessionId === targetId);
  if (!match) log(`未找到 VERBATIM_SESSION_ID=${targetId} 对应的会话日志`);
  return match?.file ?? null;
}

const pinnedSessionFile = resolvePinnedSession();
const isPinned = Boolean(process.env.VERBATIM_SESSION || process.env.VERBATIM_SESSION_ID);

function pickActiveSession({ warnMultiple = false } = {}) {
  if (pinnedSessionFile) return pinnedSessionFile;
  if (isPinned) return null;
  const all = discoverSessions();
  if (all.length === 0) return null;
  if (warnMultiple && all.length > 1) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const active = all.filter((s) => s.mtimeMs >= dayAgo);
    if (active.length > 1) {
      log(
        `注意：检测到 ${active.length} 个近 24 小时活跃会话（当前暂绑 ${all[0].sessionId}）；`
        + `如需锁定请设置 VERBATIM_SESSION_ID。`,
      );
    }
  }
  return all[0].file;
}

const sessionFile = pickActiveSession({ warnMultiple: true });
const autoSync = process.env.VERBATIM_AUTOSYNC !== '0';
const dbPath = process.env.VERBATIM_DB || defaultDbPath();

let configuredVecDim;
try {
  const gCfg = loadGlobalConfig({ dshHome: process.env.DSH_HOME ?? undefined }).config;
  const rawDim = Number(gCfg?.embedding?.dim);
  if (Number.isInteger(rawDim) && rawDim > 0) configuredVecDim = rawDim;
} catch { /* ignore */ }

/* ───────────────────────── 启动 ───────────────────────── */

let ctx = null;
try {
  const handle = openDb({ dbPath, vecDim: configuredVecDim, logger: { warn: (m) => log(m) } });
  ctx = {
    handle,
    repo: createRepo(handle),
    extras: createExtras(handle),
    dbPath,
    sessionFile,
  };
  log(`库已打开：${dbPath}${handle.hasVec ? '（向量索引可用）' : '（降级为暴力余弦，功能等价）'}`);
  if (sessionFile) log(`同步会话：${sessionFile}`);
  else log('没找到任何会话日志。设置 VERBATIM_SESSION 或 VERBATIM_SESSION_ID 指向目标会话。');
} catch (e) {
  log(`打开记忆库失败：${e.message}`);
  ctx = null;
}

/* ───────────────────────── 增量同步 ───────────────────────── */

const syncedMtimes = new Map();
let syncing = null;

function buildToolsForSession(filePath) {
  if (!ctx) return { tools: [], close: () => {} };
  const sid = filePath ? path.basename(path.dirname(filePath)) : '';
  try {
    const cfg = loadSessionConfig(sid, { dshHome: process.env.DSH_HOME ?? undefined });
    return createToolSet({ ...ctx, config: cfg, sessionId: sid });
  } catch (e) {
    log(`读取会话配置失败，按默认开关注册工具：${e.message}`);
    return createToolSet({ ...ctx, sessionId: sid });
  }
}

let TOOL_SET = buildToolsForSession(sessionFile);
let TOOLS = TOOL_SET.tools ?? [];

function refreshActiveSessionIfNeeded() {
  if (!ctx || isPinned) return;
  const latest = pickActiveSession();
  if (latest && latest !== ctx.sessionFile) {
    log(`检测到当前活跃会话切换：${ctx.sessionFile ?? '(none)'} → ${latest}`);
    ctx.sessionFile = latest;
    TOOL_SET = buildToolsForSession(latest);
    TOOLS = TOOL_SET.tools ?? [];
  }
}

/**
 * 保证库和会话日志一致。
 * 按 mtime 判断，避免每次调用都重读整个日志（大文件要一两秒）。
 * 并发调用共用同一个 promise，不会重复导入。
 */
async function ensureFresh() {
  refreshActiveSessionIfNeeded();
  if (!autoSync || !ctx?.sessionFile) return;
  const targetFile = ctx.sessionFile;
  let stat;
  try {
    stat = fs.statSync(targetFile);
  } catch {
    return; // 日志没了就跑现状，不要因为同步失败让工具挂掉
  }
  if (syncedMtimes.get(targetFile) === stat.mtimeMs) return;
  if (syncing) return syncing;

  syncing = (async () => {
    const t0 = Date.now();
    try {
      const r = await importSession(targetFile, {
        handle: ctx.handle,
        dshHome: process.env.DSH_HOME ?? undefined,
        quiet: true,
      });
      syncedMtimes.set(targetFile, stat.mtimeMs);
      log(`同步完成 ${Date.now() - t0}ms：入库 ${r?.ingest?.inserted ?? '?'} 条`);
    } catch (e) {
      // 同步失败不阻塞查询：查到的可能是稍旧的数据，但比报错好
      log(`同步失败（继续用现有数据）：${e.message}`);
      syncedMtimes.set(targetFile, stat.mtimeMs); // 别在同一个坏状态上反复重试
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/* ───────────────────────── 工具集 ───────────────────────── */

/* ───────────────────────── JSON-RPC ───────────────────────── */

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-verbatim', version: VERSION },
      });

    case 'notifications/initialized':
      return undefined;

    case 'tools/list':
      refreshActiveSessionIfNeeded();
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      });

    case 'tools/call': {
      // 每次调用前同步并刷新活跃会话，保证"边聊边查得到"
      await ensureFresh();
      const name = params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return replyError(id, -32602, `未知工具：${name}`);

      try {
        const text = await tool.handler(params?.arguments ?? {}, ctx ?? {});
        return reply(id, { content: [{ type: 'text', text: String(text) }] });
      } catch (e) {
        // 工具内部错误当"内容"返回：让TA知道发生了什么，
        // 而不是让整个 JSON-RPC 调用失败（那会中断宿主的会话）。
        return reply(id, {
          content: [{ type: 'text', text: `工具执行出错：${e.message}` }],
          isError: true,
        });
      }
    }

    default:
      return replyError(id, -32601, `不支持的方法：${method}`);
  }
}

/* ───────────────────────── 主循环 ───────────────────────── */

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`收到无法解析的行（已忽略，前 80 字符）：${trimmed.slice(0, 80)}`);
    return;
  }
  handleRequest(msg).catch((e) => {
    log(`处理请求异常：${e.message}`);
    if (msg?.id !== undefined) replyError(msg.id, -32603, e.message);
  });
});

rl.on('close', () => {
  try { ctx?.handle?.close?.(); } catch { /* 关不上也没关系，进程要退了 */ }
  process.exit(0);
});
