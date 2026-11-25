// @ts-check
/**
 * 统一的会话日志发现工具（供 Host 面板与独立 MCP Server 共用）。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 在 `$DSH_HOME/sessions` 下收集全部 `session.v4.jsonl.zstd`，按 `mtimeMs` 倒序返回。
 * @param {string} dshHome
 * @returns {{ file: string, sessionId: string, mtimeMs: number }[]}
 */
export function discoverSessionLogs(dshHome) {
  if (!dshHome) return [];
  const root = path.join(dshHome, 'sessions');
  if (!fs.existsSync(root)) return [];

  /** @type {{ file: string, sessionId: string, mtimeMs: number }[]} */
  const found = [];
  /** @param {string} dir @param {number} depth */
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

/**
 * 按 `sessionId` 快速定位会话日志（O(工作区目录数)，命中后按路径复用）。
 * @param {string} dshHome
 * @param {string} sessionId
 * @returns {string | null}
 */
export function findSessionFile(dshHome, sessionId) {
  if (!dshHome || typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const root = path.join(dshHome, 'sessions');
  if (!fs.existsSync(root)) return null;

  const sid = sessionId.trim();
  const candidates = [sid];
  if (sid.startsWith('session-')) candidates.push(sid.slice('session-'.length));
  else candidates.push(`session-${sid}`);

  for (const id of candidates) {
    const direct = path.join(root, id, 'session.v4.jsonl.zstd');
    if (fs.existsSync(direct)) return direct;
  }

  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    for (const id of candidates) {
      const p = path.join(wsDir, id, 'session.v4.jsonl.zstd');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 在 `$DSH_HOME/sessions` 下找最近修改的 `session.v4.jsonl.zstd`。
 * @param {string} dshHome
 * @returns {string | null}
 */
export function findLatestSession(dshHome) {
  return discoverSessionLogs(dshHome)[0]?.file ?? null;
}
