// reader.js —— 读 DSH 会话日志（zstd 帧串联的 JSONL）
//
// 格式（实测确认，2026-11-17 对真实会话验证）：
//   session.v4.jsonl.zstd 是 **zstd 帧串联**，不是单个压缩流。
//   每个帧解压出 1~N 行 UTF-8 JSON，一行一个事件。
//   用 `zstdDecompressSync` 一次性解整个文件会只得到第一帧，所以必须按
//   magic `28 B5 2F FD` 扫描出每个帧起点，逐帧解压后拼接。
//
// 实测数据（qqb-p-0000000000 会话）：18,438 个帧，33,260 个带 seq 的事件，
// 逐帧解压 0 失败。
//
// 零依赖：只用 node:fs / node:zlib / node:path。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** zstd 帧起始 magic：28 B5 2F FD */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 扫描缓冲区里所有 zstd 帧的起点。
 * 注意：magic 有可能碰巧出现在压缩数据内部，所以这里只负责给出候选起点，
 * 真正的确认在 decompressFrames 里靠「能不能解压成功」来做。
 *
 * @param {Buffer} buf
 * @returns {number[]} 帧起点偏移，升序
 */
export function findFrameStarts(buf) {
  const starts = [];
  let i = 0;
  while (i <= buf.length - ZSTD_MAGIC.length) {
    const j = buf.indexOf(ZSTD_MAGIC, i);
    if (j === -1) break;
    starts.push(j);
    i = j + ZSTD_MAGIC.length;
  }
  return starts;
}

/**
 * 逐帧解压并拼接成完整的 UTF-8 文本。
 *
 * 容错策略：如果按「本帧起点 ~ 下一帧起点」切出来解压失败，就把终点往后推到
 * 再下一个 magic，重试一次。这样即使有假的 magic 命中（压缩数据里碰巧出现
 * 28 B5 2F FD），也能自愈，而不是直接丢一段日志。
 *
 * @param {Buffer} buf
 * @returns {{ text: string, stats: { frames: number, ok: number, failed: number, merged: number } }}
 */
/** 遇到坏帧时最多向后合并探测多少个候选 magic（防止坏文件触发 O(N²) 解压退化） */
const MAX_FRAME_MERGE = 16;

export function decompressFrames(buf) {
  const starts = findFrameStarts(buf);
  const chunks = [];
  let ok = 0;
  let failed = 0;
  let merged = 0;

  let i = 0;
  while (i < starts.length) {
    let j = i + 1;
    let done = false;
    const maxEndIdx = Math.min(starts.length, i + MAX_FRAME_MERGE);
    while (j <= maxEndIdx) {
      const end = j < starts.length ? starts[j] : buf.length;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(starts[i], end));
        chunks.push(out);
        ok++;
        if (j > i + 1) merged++;
        done = true;
        break;
      } catch {
        j++;
      }
    }
    if (!done) failed++;
    // 成功时跳到这一组的终点；失败时只前进 1 个 magic，避免漏掉后面的合法帧
    i = done ? Math.max(j, i + 1) : i + 1;
  }

  return {
    text: Buffer.concat(chunks).toString('utf8'),
    stats: { frames: starts.length, ok, failed, merged },
  };
}

/**
 * 把 JSONL 文本切成事件数组。
 * 坏行不抛错，计数后跳过——日志是追加写的，末尾可能被截断。
 *
 * @param {string} text
 * @returns {{ events: object[], badLines: number }}
 */
export function parseJsonLines(text) {
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      badLines++;
    }
  }
  return { events, badLines };
}

/**
 * 按 seq 升序排序；同一 seq 只保留第一次出现的（重复视为追加写重放）。
 *
 * @param {object[]} events
 * @returns {{ events: object[], duplicates: number, noSeq: object[] }}
 */
export function sortAndDedupeBySeq(events) {
  const noSeq = [];
  const bySeq = new Map();
  let duplicates = 0;

  for (const ev of events) {
    if (typeof ev?.seq !== 'number' || !Number.isFinite(ev.seq)) {
      noSeq.push(ev);
      continue;
    }
    if (bySeq.has(ev.seq)) {
      duplicates++;
      continue;
    }
    bySeq.set(ev.seq, ev);
  }

  const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { events: sorted, duplicates, noSeq };
}

/**
 * 读一个会话日志文件。
 *
 * 自动识别：文件以 zstd magic 开头 → 按帧串联解压；否则当成明文 JSONL。
 *
 * @param {string} filePath  session.v4.jsonl.zstd 的路径
 * @returns {{
 *   header: object|null,           // type === 'session' 的头事件（没有 seq）
 *   events: object[],              // 按 seq 升序的全部事件
 *   stats: {
 *     filePath: string, bytes: number, compressed: boolean,
 *     frames: number, framesOk: number, framesFailed: number, framesMerged: number,
 *     rawEvents: number, badLines: number, duplicates: number,
 *     eventCount: number, seqMin: number|null, seqMax: number|null
 *   }
 * }}
 */
export function readSessionFile(filePath) {
  const abs = path.resolve(filePath);
  const buf = fs.readFileSync(abs);

  let text;
  let compressed = false;
  let frameStats = { frames: 0, ok: 0, failed: 0, merged: 0 };

  if (buf.length >= ZSTD_MAGIC.length && buf.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
    compressed = true;
    const r = decompressFrames(buf);
    text = r.text;
    frameStats = r.stats;
  } else {
    text = buf.toString('utf8');
  }

  const { events: raw, badLines } = parseJsonLines(text);

  // 头事件（type === 'session'）没有 seq，单独拿出来
  let header = null;
  const body = [];
  for (const ev of raw) {
    if (ev?.type === 'session' && typeof ev.seq !== 'number') {
      if (!header) header = ev;
      continue;
    }
    body.push(ev);
  }

  const { events, duplicates, noSeq } = sortAndDedupeBySeq(body);

  // 没有 seq 但又不是 session 头的（理论上不该有），拼到末尾不参与排序
  const all = noSeq.length ? events.concat(noSeq) : events;

  const seqMin = events.length ? events[0].seq : null;
  const seqMax = events.length ? events[events.length - 1].seq : null;

  return {
    header,
    events: all,
    stats: {
      filePath: abs,
      bytes: buf.length,
      compressed,
      frames: frameStats.frames,
      framesOk: frameStats.ok,
      framesFailed: frameStats.failed,
      framesMerged: frameStats.merged,
      rawEvents: raw.length,
      badLines,
      duplicates,
      eventCount: events.length,
      seqMin,
      seqMax,
    },
  };
}

/**
 * 增量读取会话日志：文件未缩水且追加了完整帧/行时，只读并解压 `[prevState.size, stat.size)` 尾部字节。
 * 遇到文件缩小、截断、坏帧或非 zstd 帧边界时自动回退到全量 `readSessionFile`，保证结果与全量一致。
 *
 * @param {string} filePath
 * @param {object|null} [prevState]
 * @returns {{
 *   header: object|null,
 *   events: object[],
 *   tailEvents: object[],
 *   incremental: 'full' | 'hit' | 'tail',
 *   prevSeqMax: number|null,
 *   state: object,
 *   stats: object,
 * }}
 */
export function readSessionFileIncremental(filePath, prevState = null) {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs);

  if (
    prevState
    && prevState.absPath === abs
    && stat.size === prevState.size
    && stat.mtimeMs === prevState.mtimeMs
  ) {
    return {
      header: prevState.header,
      events: prevState.events,
      tailEvents: [],
      incremental: 'hit',
      prevSeqMax: prevState.seqMax,
      state: prevState,
      stats: prevState.stats,
    };
  }

  const buildFull = () => {
    const full = readSessionFile(abs);
    const state = {
      absPath: abs,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      header: full.header,
      events: full.events,
      seqMax: full.stats.seqMax,
      stats: full.stats,
    };
    return {
      ...full,
      tailEvents: full.events,
      incremental: 'full',
      prevSeqMax: null,
      state,
    };
  };

  if (
    !prevState
    || prevState.absPath !== abs
    || prevState.size <= 0
    || stat.size < prevState.size
    || prevState.stats?.framesFailed > 0
    || prevState.stats?.badLines > 0
  ) {
    return buildFull();
  }

  const delta = stat.size - prevState.size;
  if (delta <= 0) return buildFull();

  const tailBuf = Buffer.allocUnsafe(delta);
  const fd = fs.openSync(abs, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < delta) {
      const n = fs.readSync(fd, tailBuf, bytesRead, delta - bytesRead, prevState.size + bytesRead);
      if (n <= 0) break;
      bytesRead += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead !== delta) return buildFull();

  let tailText;
  let frameStats = { frames: 0, ok: 0, failed: 0, merged: 0 };
  if (prevState.stats?.compressed) {
    if (tailBuf.length < ZSTD_MAGIC.length || !tailBuf.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
      return buildFull();
    }
    const r = decompressFrames(tailBuf);
    if (r.stats.failed > 0 || r.stats.ok === 0) return buildFull();
    tailText = r.text;
    frameStats = r.stats;
  } else {
    tailText = tailBuf.toString('utf8');
  }

  const { events: tailRaw, badLines } = parseJsonLines(tailText);
  if (badLines > 0) return buildFull();

  let header = prevState.header;
  const tailBody = [];
  for (const ev of tailRaw) {
    if (ev?.type === 'session' && typeof ev.seq !== 'number') {
      if (!header) header = ev;
      continue;
    }
    tailBody.push(ev);
  }

  const tailSorted = sortAndDedupeBySeq(tailBody);
  const tailNumeric = tailSorted.events;
  const prevSeqMax = prevState.seqMax;
  const isStrictlyAppend = tailSorted.noSeq.length === 0
    && (prevSeqMax === null || tailNumeric.length === 0 || tailNumeric[0].seq > prevSeqMax);

  let mergedEvents;
  let duplicates = prevState.stats.duplicates ?? 0;
  let seqMin = prevState.stats.seqMin ?? null;
  let seqMax = prevSeqMax;
  let eventCount = prevState.stats.eventCount ?? 0;

  if (isStrictlyAppend) {
    const prevAll = prevState.events;
    const prevLastHasSeq = prevAll.length === 0 || typeof prevAll[prevAll.length - 1]?.seq === 'number';
    if (!prevLastHasSeq) return buildFull();
    mergedEvents = prevAll.concat(tailNumeric);
    duplicates += tailSorted.duplicates;
    if (tailNumeric.length > 0) {
      if (seqMin === null) seqMin = tailNumeric[0].seq;
      seqMax = tailNumeric[tailNumeric.length - 1].seq;
      eventCount += tailNumeric.length;
    }
  } else {
    const combined = sortAndDedupeBySeq(prevState.events.concat(tailBody));
    mergedEvents = combined.noSeq.length ? combined.events.concat(combined.noSeq) : combined.events;
    duplicates = combined.duplicates;
    seqMin = combined.events.length ? combined.events[0].seq : null;
    seqMax = combined.events.length ? combined.events[combined.events.length - 1].seq : null;
    eventCount = combined.events.length;
  }

  const nextStats = {
    ...prevState.stats,
    bytes: stat.size,
    frames: (prevState.stats.frames ?? 0) + frameStats.frames,
    framesOk: (prevState.stats.framesOk ?? 0) + frameStats.ok,
    framesFailed: (prevState.stats.framesFailed ?? 0) + frameStats.failed,
    framesMerged: (prevState.stats.framesMerged ?? 0) + frameStats.merged,
    rawEvents: (prevState.stats.rawEvents ?? 0) + tailRaw.length,
    badLines: (prevState.stats.badLines ?? 0) + badLines,
    duplicates,
    eventCount,
    seqMin,
    seqMax,
  };
  const nextState = {
    absPath: abs,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    header,
    events: mergedEvents,
    seqMax,
    stats: nextStats,
  };
  const tailEvents = tailSorted.noSeq.length ? tailNumeric.concat(tailSorted.noSeq) : tailNumeric;
  return {
    header,
    events: mergedEvents,
    tailEvents,
    incremental: 'tail',
    prevSeqMax,
    state: nextState,
    stats: nextStats,
  };
}

/**
 * 列出 $DSH_HOME/sessions 下所有会话日志，方便批量导出。
 * 目录结构：sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd
 *
 * @param {string} [sessionsRoot] 默认 ~/.dsh/sessions
 * @returns {{ filePath: string, workspaceKey: string, sessionId: string, bytes: number }[]}
 */
export function listSessionFiles(sessionsRoot) {
  const root = sessionsRoot ?? path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? '.',
    '.dsh', 'sessions',
  );
  const out = [];
  if (!fs.existsSync(root)) return out;

  for (const wk of fs.readdirSync(root, { withFileTypes: true })) {
    if (!wk.isDirectory()) continue;
    const wkDir = path.join(root, wk.name);
    for (const sd of fs.readdirSync(wkDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue;
      const file = path.join(wkDir, sd.name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      out.push({
        filePath: file,
        workspaceKey: wk.name,
        sessionId: sd.name,
        bytes: fs.statSync(file).size,
      });
    }
  }
  return out;
}
