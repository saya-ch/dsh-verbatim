/**
 * search-render.js —— memory_search 的场景排版、笔记展示与空结果格式化模块
 */

import {
  MARK_COMPACTED_ONE,
  MARK_EXCLUDED_ONE,
  buildMediaAnnotator,
  clipInline,
  clipText,
  emptyText,
  fmtCount,
  fmtDate,
  fmtPhase,
  fmtRange,
  fmtStamp,
  indentText,
  noteAboutLabel,
  resolveTzOffsetMs,
  speakerLabel,
  CONTEXT_CLIP_MAX,
  HIT_CLIP_MAX,
} from './format.js';
import { splitTerms } from './vector-route.js';

const SEGMENT_MAX = 500;
const AUTO_FULL_SCENE_CHARS = 1500;
const MAX_TOTAL_CONTEXT_CHARS = 8000;
const CONTINUOUS_BRIDGE_GAP_MS = 10 * 60_000;
const NOTE_FALLBACK_SCAN_CAP = 20_000;

export function isListAllQuery(query) {
  return query === '' || query === '*' || query === '全部' || query === '所有';
}

export function filterNotes(notes, query) {
  if (isListAllQuery(query)) return notes;
  const terms = splitTerms(query);
  if (terms.length === 0) return notes;
  const haystacks = terms.map((t) => t.toLowerCase());
  return notes.filter((note) => {
    const body = String(note?.content ?? '').toLowerCase();
    return haystacks.some((t) => body.includes(t));
  });
}

export function renderShown(shown, opts) {
  const { includeExcluded, expand, repo, extras = null, dshHome = null } = opts;

  const groups = new Map();
  for (const row of shown) {
    const sid = row.sceneId === null || row.sceneId === undefined ? null : Number(row.sceneId);
    const key = sid === null ? `msg:${row.id}` : `scene:${sid}`;
    if (!groups.has(key)) groups.set(key, { sceneId: sid, rows: [] });
    groups.get(key).rows.push(row);
  }

  const mediaIds = new Set(shown.map((r) => r.id).filter((id) => id !== undefined && id !== null));
  if (repo && typeof repo.msgsByScene === 'function') {
    for (const g of groups.values()) {
      if (g.sceneId !== null) {
        try {
          for (const m of repo.msgsByScene(g.sceneId, includeExcluded)) {
            if (m && m.id !== undefined && m.id !== null) mediaIds.add(m.id);
          }
        } catch { /* ignore */ }
      }
    }
  }
  const annotateMedia = buildMediaAnnotator(extras, [...mediaIds], dshHome);

  const blocks = [];
  let budget = MAX_TOTAL_CONTEXT_CHARS;
  for (const g of groups.values()) {
    if (g.sceneId === null) {
      for (const row of g.rows) {
        const block = renderHit(row, { includeExcluded, annotateMedia });
        budget -= block.length;
        blocks.push(block);
      }
      continue;
    }
    const bestRank = Math.min(...g.rows.map((r) => (typeof r._rank === 'number' ? r._rank : 1)));
    const rowExpand = expand === 'auto' && bestRank >= 4 ? 'snippet' : expand;
    const block = renderSceneBlock(g.rows, {
      includeExcluded,
      expand: rowExpand,
      repo,
      budget,
      compactTime: opts?.compactTime === true,
      annotateMedia,
      tzOffsetMs: opts?.tzOffsetMs,
    });
    budget -= block.length;
    blocks.push(block);
  }
  return blocks.join('\n\n');
}

function renderSceneMsg(msg, opts) {
  const { hit, hitRow, includeExcluded, compactTime = false, inHitWindow = false, inFocusExchange = false } = opts;
  let mark = '';
  if (hit && hitRow) {
    const sources = Array.isArray(hitRow.sources) ? hitRow.sources : null;
    if (sources && sources.length > 0) {
      const vecOnly = sources.length === 1 && sources[0] === 'vector';
      const both = sources.includes('keyword') && sources.includes('vector');
      const cos = typeof hitRow.score === 'number' ? hitRow.score.toFixed(2) : null;
      if (vecOnly) mark = ` vec${cos ? ` ${cos}` : ''}`;
      else if (both) mark = ` kw+vec${cos ? ` ${cos}` : ''}`;
    }
  }
  const focusMark = hit ? '  ←' : (inFocusExchange ? '  ◆' : '');
  const chunkInfo = hit && hitRow ? hitRow.chunk : null;
  const clipMax = (hit || inFocusExchange || (compactTime && inHitWindow))
    ? HIT_CLIP_MAX
    : (inHitWindow ? 480 : CONTEXT_CLIP_MAX);
  const clippedBase = clipText(msg.text, clipMax);
  const msgText = opts.annotateMedia ? opts.annotateMedia(msg.id, clippedBase) : clippedBase;

  const lines = [];
  if (compactTime && !(chunkInfo && Number.isFinite(chunkInfo.startChar) && Number.isFinite(chunkInfo.endChar))) {
    const textLines = msgText.split('\n');
    const suffix = `${mark}${focusMark}`;
    lines.push(`    ${speakerLabel(msg.speaker)}：${textLines[0]}${textLines.length === 1 ? suffix : ''}`);
    for (let i = 1; i < textLines.length; i++) {
      lines.push(`      ${textLines[i]}${i === textLines.length - 1 ? suffix : ''}`);
    }
  } else {
    const stamp = compactTime ? `${fmtDate(msg.at)} ${fmtPhase(msg.at)}` : fmtStamp(msg.at);
    lines.push(`    ${stamp}  ${speakerLabel(msg.speaker)}${mark}${focusMark}`);
    if (chunkInfo && Number.isFinite(chunkInfo.startChar) && Number.isFinite(chunkInfo.endChar)) {
      const seg = String(msg.text ?? '').slice(chunkInfo.startChar, chunkInfo.endChar);
      const segMax = hit ? Math.max(SEGMENT_MAX, seg.length) : CONTEXT_CLIP_MAX;
      const segClipped = clipText(seg, segMax);
      const segText = opts.annotateMedia ? opts.annotateMedia(msg.id, segClipped) : segClipped;
      lines.push(indentText(segText, '      '));
      const total = chunkInfo.total ?? null;
      const where = total ? `第 ${chunkInfo.idx + 1}/${total} 段` : `第 ${chunkInfo.idx + 1} 段`;
      lines.push(`      ✂ ${where}（全文 ${fmtCount(String(msg.text ?? '').length)} 字）`);
    } else {
      lines.push(indentText(msgText, '      '));
    }
  }
  if (hit && msg.inSurface === 0) lines.push(`      ${MARK_COMPACTED_ONE}`);
  if (hit && includeExcluded && msg.excluded === 1) lines.push(`      ${MARK_EXCLUDED_ONE}`);
  if (hit && Array.isArray(hitRow?.relatedTimeline) && hitRow.relatedTimeline.length > 0) {
    const dates = hitRow.relatedTimeline.map((rt) => fmtDate(rt.at)).filter(Boolean);
    if (dates.length > 0) lines.push(`      ↳ 跨日同主题：${[...new Set(dates)].join('、')}`);
  }
  return lines.join('\n');
}

function renderSceneBlock(rows, opts) {
  const {
    includeExcluded,
    expand,
    repo,
    budget = MAX_TOTAL_CONTEXT_CHARS,
    compactTime = false,
    annotateMedia = null,
    tzOffsetMs,
  } = opts;
  const anchor = rows[0];
  const sceneId = Number(anchor.sceneId);
  const hitIds = new Set();
  for (const r of rows) {
    hitIds.add(Number(r.id));
    if (Array.isArray(r.matchedMsgIds)) {
      for (const mid of r.matchedMsgIds) hitIds.add(Number(mid));
    }
  }
  const rowById = new Map(rows.map((r) => [Number(r.id), r]));

  let msgs = [];
  try {
    msgs = repo.msgsByScene(sceneId, includeExcluded).map((m) => ({ ...m }));
  } catch {
    msgs = [];
  }

  if (msgs.length === 0) {
    return rows.map((r) => renderHit(r, { includeExcluded })).join('\n\n');
  }

  const totalChars = msgs.reduce((s, m) => s + String(m.text ?? '').length, 0);
  const range = fmtRange(anchor.sceneStartAt, anchor.sceneEndAt);
  const n = msgs.length;
  const hitIndices = [];
  msgs.forEach((m, i) => { if (hitIds.has(Number(m.id))) hitIndices.push(i); });
  const hitCount = hitIndices.length;

  let bridgeBefore = [];
  let bridgeAfter = [];
  if (expand !== 'snippet' && hitIndices.length > 0 && typeof repo?.sceneById === 'function') {
    const firstHit = hitIndices[0];
    const lastHit = hitIndices[hitIndices.length - 1];
    if (firstHit <= 1 || lastHit >= n - 2) {
      try {
        const sc = repo.sceneById(sceneId);
        if (firstHit <= 1 && sc?.precededBy && typeof sc.gapBeforeMs === 'number' && sc.gapBeforeMs <= CONTINUOUS_BRIDGE_GAP_MS) {
          bridgeBefore = repo.msgsByScene(sc.precededBy, includeExcluded).slice(-2);
        }
        if (lastHit >= n - 2 && sc?.followedBy && typeof sc.gapAfterMs === 'number' && sc.gapAfterMs <= CONTINUOUS_BRIDGE_GAP_MS) {
          bridgeAfter = repo.msgsByScene(sc.followedBy, includeExcluded).slice(0, 2);
        }
      } catch {
        bridgeBefore = [];
        bridgeAfter = [];
      }
    }
  }

  const pushBridge = (lines, label, list) => {
    if (!list.length) return;
    lines.push(`    ${label}`);
    for (const m of list) {
      lines.push(renderSceneMsg(m, { hit: false, hitRow: null, includeExcluded, compactTime }));
    }
  };

  if (expand === 'snippet') {
    const keep = new Set();
    msgs.forEach((m, i) => {
      if (!hitIds.has(Number(m.id))) return;
      keep.add(i);
      if (i > 0) keep.add(i - 1);
      if (i < n - 1) keep.add(i + 1);
    });
    const picked = [...keep].sort((a, b) => a - b);
    const lines = [`  ${range} · ${fmtCount(n)}轮 · 命中 ${fmtCount(hitCount)} 处（片段）`];
    let prev = -2;
    for (const i of picked) {
      if (i !== prev + 1) lines.push('    ⋯');
      lines.push(renderSceneMsg(msgs[i], { hit: hitIds.has(Number(msgs[i].id)), hitRow: rowById.get(Number(msgs[i].id)), includeExcluded, compactTime, annotateMedia }));
      prev = i;
    }
    return lines.join('\n');
  }

  const fitsBudget = budget > totalChars * 4;
  const wantFull = expand === 'scene' || (totalChars <= AUTO_FULL_SCENE_CHARS && fitsBudget);
  if (wantFull) {
    const why = expand === 'scene' ? '' : ` · ${fmtCount(totalChars)}字`;
    const lines = [`  ${range} · ${fmtCount(n)}轮${why} · 命中 ${fmtCount(hitCount)} 处`];
    pushBridge(lines, '↖ 紧接前文（跨场连贯）', bridgeBefore);
    for (const m of msgs) {
      lines.push(renderSceneMsg(m, { hit: hitIds.has(Number(m.id)), hitRow: rowById.get(Number(m.id)), includeExcluded, compactTime, annotateMedia }));
    }
    pushBridge(lines, '↘ 紧接下文（跨场连贯）', bridgeAfter);
    return lines.join('\n');
  }

  const EDGE = 2;
  const AROUND = 2;
  const keep = new Set();
  const hitWindowMsgIds = new Set();
  const focusExchangeMsgIds = new Set();
  for (let i = 0; i < Math.min(EDGE, n); i++) keep.add(i);
  for (let i = Math.max(0, n - EDGE); i < n; i++) keep.add(i);
  msgs.forEach((m, i) => {
    if (!hitIds.has(Number(m.id))) return;
    const hitItem = rowById.get(Number(m.id));
    const win = hitItem?.window;
    const isTopNoWin = !win && typeof hitItem?._rank === 'number' && hitItem._rank <= 2;
    const afterSpan = isTopNoWin ? 5 : AROUND;
    for (let k = Math.max(0, i - AROUND); k <= Math.min(n - 1, i + afterSpan); k++) {
      keep.add(k);
      if (isTopNoWin && k > i) hitWindowMsgIds.add(Number(msgs[k].id));
    }
    if (win && Number.isFinite(win.startMsgId) && Number.isFinite(win.endMsgId)) {
      for (let k = 0; k < n; k++) {
        const mid = Number(msgs[k].id);
        if (mid >= win.startMsgId && mid <= win.endMsgId) {
          keep.add(k);
          hitWindowMsgIds.add(mid);
        }
      }
    }
    const fex = hitItem?.focusExchange;
    if (fex && Number.isFinite(fex.startMsgId) && Number.isFinite(fex.endMsgId)) {
      for (let k = 0; k < n; k++) {
        const mid = Number(msgs[k].id);
        if (mid >= fex.startMsgId && mid <= fex.endMsgId) focusExchangeMsgIds.add(mid);
      }
    }
  });
  const picked = [...keep].sort((a, b) => a - b);
  const omitted = n - picked.length;

  let omittedSpan = '';
  if (omitted > 0) {
    const gaps = [];
    let runStart = null;
    for (let i = 0; i < n; i += 1) {
      const kept = picked.includes(i);
      if (!kept && runStart === null) runStart = i;
      if (kept && runStart !== null) {
        gaps.push([runStart, i - 1]);
        runStart = null;
      }
    }
    if (runStart !== null) gaps.push([runStart, n - 1]);
    const widest = gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    if (widest) {
      const a = msgs[widest[0]];
      const b = msgs[widest[1]];
      const offsetMs = resolveTzOffsetMs(tzOffsetMs);
      const fmtWhenPoint = (ms) => {
        const d = new Date(Number(ms) + offsetMs);
        const p2 = (v) => String(v).padStart(2, '0');
        return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
      };
      omittedSpan = `最大一段 ${fmtWhenPoint(a.at)}..${fmtWhenPoint(b.at)} 可传 when 补查`;
    }
  }

  const lines = [
    `  ${range} · ${fmtCount(n)}轮 · ${fmtCount(totalChars)}字 · 命中 ${fmtCount(hitCount)} 处`
    + `（省略 ${fmtCount(omitted)} 轮${omittedSpan ? `；${omittedSpan}` : "；要看全用 expand: 'scene'"}）`,
  ];
  pushBridge(lines, '↖ 紧接前文（跨场连贯）', bridgeBefore);
  let prev = -2;
  for (const i of picked) {
    if (i !== prev + 1) lines.push('    ⋯');
    const mid = Number(msgs[i].id);
    lines.push(renderSceneMsg(msgs[i], {
      hit: hitIds.has(mid),
      hitRow: rowById.get(mid),
      includeExcluded,
      compactTime,
      inHitWindow: hitWindowMsgIds.has(mid),
      inFocusExchange: focusExchangeMsgIds.has(mid),
      annotateMedia,
    }));
    prev = i;
  }
  pushBridge(lines, '↘ 紧接下文（跨场连贯）', bridgeAfter);
  return lines.join('\n');
}

function renderHit(row, opts) {
  const lines = [`  ${fmtStamp(row.at)}  ${speakerLabel(row.speaker)}`];
  if (row.chunk && Number.isFinite(row.chunk.startChar) && Number.isFinite(row.chunk.endChar)) {
    const seg = String(row.text ?? '').slice(row.chunk.startChar, row.chunk.endChar);
    const segText = opts.annotateMedia ? opts.annotateMedia(row.id, seg) : seg;
    lines.push(indentText(segText, '    '));
    const total = row.chunk.total ?? null;
    const where = total ? `第 ${row.chunk.idx + 1}/${total} 段` : `第 ${row.chunk.idx + 1} 段`;
    lines.push(`    ✂ ${where}（全文 ${fmtCount(String(row.text ?? '').length)} 字）`);
  } else {
    const rowText = opts.annotateMedia ? opts.annotateMedia(row.id, row.text) : row.text;
    lines.push(indentText(clipText(rowText, HIT_CLIP_MAX), '    '));
  }

  const hasScene = row.sceneStartAt !== null && row.sceneStartAt !== undefined;
  if (hasScene) {
    lines.push(`    ⤷ ${fmtRange(row.sceneStartAt, row.sceneEndAt)} / ${fmtCount(row.sceneMsgCount ?? 0)}轮`);
  }

  let mark = '';
  const sources = Array.isArray(row.sources) ? row.sources : null;
  if (sources && sources.length > 0) {
    const vecOnly = sources.length === 1 && sources[0] === 'vector';
    const both = sources.includes('keyword') && sources.includes('vector');
    const cos = typeof row.score === 'number' ? row.score.toFixed(2) : null;
    if (vecOnly) mark = ` vec${cos ? ` ${cos}` : ''}`;
    else if (both) mark = ` kw+vec${cos ? ` ${cos}` : ''}`;
  }
  if (mark) lines[0] += mark;

  if (row.inSurface === 0) lines.push(`    ${MARK_COMPACTED_ONE}`);
  if (opts.includeExcluded && row.excluded === 1) lines.push(`    ${MARK_EXCLUDED_ONE}`);
  if (Array.isArray(row.relatedTimeline) && row.relatedTimeline.length > 0) {
    const dates = row.relatedTimeline.map((rt) => fmtDate(rt.at)).filter(Boolean);
    if (dates.length > 0) lines.push(`    ↳ 跨日同主题：${[...new Set(dates)].join('、')}`);
  }
  return lines.join('\n');
}

export function renderNote(note, opts = {}) {
  const lines = [`  ${fmtStamp(note.at)}  笔记 #${note.id}`];
  lines.push(indentText(clipText(note.content), '    '));
  const label = noteAboutLabel(note.about, opts?.aboutLabels ?? null);
  if (label) lines.push(`    （${label}）`);
  return lines.join('\n');
}

export function selectNotes({ extras, sessionId, window, query, limit }) {
  const hasRange = window && window.from !== null && window.to !== null;
  const from = hasRange ? Number(window.from) : null;
  const to = hasRange ? Number(window.to) : null;
  const noteApi = extras?.note;
  if (!noteApi) return [];

  if (query && !isListAllQuery(query) && typeof noteApi.searchKeyword === 'function') {
    const terms = splitTerms(query);
    const pool = noteApi.searchKeyword({
      sessionId,
      from,
      to,
      terms: [query, ...terms],
      limit: Math.max(2000, limit),
    });
    return filterNotes(pool, query);
  }

  const all = typeof noteApi.list === 'function'
    ? noteApi.list({
        limit: query && !isListAllQuery(query) ? Math.max(NOTE_FALLBACK_SCAN_CAP, limit) : Math.max(2000, limit),
        sessionId,
        ...(hasRange ? { from, to } : {}),
      })
    : [];
  let pool = all;
  if (hasRange) {
    pool = pool.filter((n) => Number(n.at) >= from && Number(n.at) < to);
  }
  return filterNotes(pool, query);
}

export function formatTrashHint(extras, sessionId) {
  if (typeof extras?.note?.list !== 'function') return null;
  try {
    const all = extras.note.list({ limit: 20, includeDeleted: true, sessionId });
    const deleted = Array.isArray(all) ? all.filter((n) => n && n.deletedAt !== null) : [];
    if (deleted.length === 0) return null;
    const preview = deleted.slice(0, 3).map((n) => {
      const txt = String(n.content ?? '').replace(/\s+/g, ' ').trim();
      const short = txt.length > 28 ? `${txt.slice(0, 28)}…` : txt;
      return `#${n.id}「${short}」`;
    }).join('、');
    return `回收站里还有 ${fmtCount(deleted.length)} 条已删笔记（可用 memory_forget(id, restore: true) 恢复）：${preview}`;
  } catch {
    return null;
  }
}

export function renderNotesOnly(notes, { stats, window, limit, extras = null, sessionId = null, aboutLabels = null }) {
  const shown = [...notes]
    .sort((a, b) => b.at - a.at || b.id - a.id)
    .slice(0, limit)
    .sort((a, b) => a.at - b.at || a.id - b.id);
  const rangeHint =
    window && window.from !== null && window.to !== null ? `（${window.label}）` : '';
  const trashHint = formatTrashHint(extras, sessionId);
  if (shown.length === 0) {
    return emptyText({
      head: `没有找到${rangeHint ? ` ${window.label} ` : ''}记下的笔记。`,
      stats,
      tips: [
        '你是没记过，还是记在别处了？可以换个说法，或者不加时间再列一次。',
        '想记一条就用 memory_remember。',
        ...(trashHint ? [trashHint] : []),
      ],
    });
  }
  const out = [
    `你自己记的 — ${fmtCount(notes.length)} 条${rangeHint}`,
    '',
    shown.map((n) => renderNote(n, { aboutLabels })).join('\n\n'),
    '',
    `已显示 ${fmtCount(shown.length)} / ${fmtCount(notes.length)} 条笔记。`,
  ];
  if (trashHint) out.push('', trashHint);
  return out.join('\n');
}

export function emptySearchText({
  queryLabel,
  query,
  stats,
  bounds,
  window,
  hasQuery,
  wantNote,
  semanticNoteText,
}) {
  const tips = [];
  if (bounds) {
    tips.push(`刚才只在 ${window.label} 里找，去掉 when 可以找全库。`);
  }
  if (wantNote) {
    const notes = Number(stats?.notes ?? 0);
    tips.push(
      notes > 0
        ? `你自己记的笔记一共 ${fmtCount(notes)} 条，换个说法或者干脆 scope 填 note、query 留空，我把最近的列出来。`
        : '你还没记过笔记（memory_remember 之后就能在这里翻到）。',
    );
  }
  if (hasQuery) {
    if (Array.from(query).length > 0 && Array.from(query).length <= 2) {
      tips.push('两个字不好命中就多给几个字：比如原话里的「怕黑」「不想开灯」一起给。');
    }
    tips.push('也可以只填 when（如 "2026-11-09"、"2026-11" 或 "7d"），不填 query，直接按时间翻那一阵的对话。');
  }
  const head = hasQuery
    ? `没有找到跟「${queryLabel}」有关的记录${bounds ? `（只在 ${window.label} 里找的）` : ''}。`
    : '还没有记下任何东西。';
  if (semanticNoteText) tips.push(semanticNoteText);
  return emptyText({ head, stats, tips });
}
