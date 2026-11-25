// @ts-check
/**
 * 场景人工微调（mergeScene / splitScene / refineOneScene）、
 * 图片安全预览（mediaPreview）与笔记去重合并（findDuplicateNotes / mergeNotes）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildExtractiveGist, generateGist } from '../derive/gist.js';
import { buildAdaptiveWindowsForScene } from '../pipeline.js';
import { deleteVecRows, withTx } from '../store/repo.js';
import { createHostLlmAdapter } from './dsh-llm.js';

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
});

function computeSceneStats(msgs) {
  let outOfSurfaceCount = 0;
  let compactedCount = 0;
  let excludedCount = 0;
  for (const m of msgs) {
    if (m.inSurface === 0 || m.compactedAt !== null) outOfSurfaceCount += 1;
    if (m.compactedAt !== null) compactedCount += 1;
    if (m.excluded === 1) excludedCount += 1;
  }
  return {
    startAt: msgs[0].at,
    endAt: msgs[msgs.length - 1].at,
    msgCount: msgs.length,
    hasExcluded: excludedCount > 0 ? 1 : 0,
    excludedCount,
    hasOutOfSurface: outOfSurfaceCount > 0 ? 1 : 0,
    outOfSurfaceCount,
    crossesCompaction: compactedCount > 0 && compactedCount < msgs.length ? 1 : 0,
    compactedCount,
  };
}

function leadInJsonOf(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  return JSON.stringify(
    msgs.slice(-2).map((m) => ({ seq: m.seq, at: m.at, speaker: m.speaker, text: m.text })),
  );
}

function bigramsOf(text) {
  const clean = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  const set = new Set();
  if (clean.length < 2) {
    if (clean) set.add(clean);
    return set;
  }
  for (let i = 0; i < clean.length - 1; i++) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

function jaccardSim(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

function safeRealPath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isInsideRoot(targetPath, rootPath) {
  if (!rootPath) return false;
  const target = safeRealPath(targetPath);
  const root = safeRealPath(rootPath);
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function createSceneOps({
  handle,
  db,
  repo,
  extras,
  stmt,
  requireSession,
  intParam,
  PanelError,
  llmCfg,
  getHostLlm,
  hasEmbeddingKey,
  makeEmbeddingProvider,
  noteHasSessionColumn,
  dshHome = '',
  dbRoot = '',
  logger = console,
}) {
  /** 将指定场景与其上一场（preceded_by）合并为一场，并置 locked=1 */
  function mergeScene(params) {
    const sessionId = requireSession('mergeScene', params);
    const sceneId = intParam(params.sceneId, 'sceneId', { min: 1 });
    const cur = repo.sceneById(sceneId);
    if (!cur || cur.sessionId !== sessionId) {
      throw new PanelError('SCENE_NOT_FOUND', `找不到场景 #${sceneId}`, 404);
    }
    if (!cur.precededBy) {
      throw new PanelError('BAD_ARG', '该场景已是第一场，没有可合并的上一场', 400);
    }
    const prev = repo.sceneById(cur.precededBy);
    if (!prev || prev.sessionId !== sessionId) {
      throw new PanelError('SCENE_NOT_FOUND', '找不到可合并的上一场', 404);
    }

    const prevMsgs = repo.msgsByScene(prev.id, true);
    const curMsgs = repo.msgsByScene(cur.id, true);
    const allMsgs = [...prevMsgs, ...curMsgs].sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (allMsgs.length === 0) {
      throw new PanelError('BAD_ARG', '合并目标场景均无消息', 400);
    }

    const st = computeSceneStats(allMsgs);
    const gist = buildExtractiveGist(allMsgs);
    const nextScene = cur.followedBy ? repo.sceneById(cur.followedBy) : null;

    withTx(db, () => {
      deleteVecRows(db, 'scene', [prev.id, cur.id]);
      stmt('UPDATE msg SET scene_id = ? WHERE scene_id = ?').run(prev.id, cur.id);
      stmt(
        `UPDATE scene
         SET start_at = ?, end_at = ?, msg_count = ?,
             has_excluded = ?, excluded_count = ?,
             has_out_of_surface = ?, out_of_surface_count = ?,
             crosses_compaction = ?, compacted_count = ?,
             followed_by = ?, gap_after_ms = ?,
             gist = ?, gist_source = ?, locked = 1
         WHERE id = ?`,
      ).run(
        st.startAt,
        st.endAt,
        st.msgCount,
        st.hasExcluded,
        st.excludedCount,
        st.hasOutOfSurface,
        st.outOfSurfaceCount,
        st.crossesCompaction,
        st.compactedCount,
        cur.followedBy ?? null,
        cur.gapAfterMs ?? null,
        gist,
        gist ? 'extractive' : null,
        prev.id,
      );
      if (nextScene) {
        stmt('UPDATE scene SET preceded_by = ?, gap_before_ms = ?, lead_in = ? WHERE id = ?').run(
          prev.id,
          nextScene.startAt - st.endAt,
          leadInJsonOf(allMsgs),
          nextScene.id,
        );
      }
      try {
        extras?.window?.clearForScenes?.([cur.id]);
      } catch { /* ignore */ }
      stmt('DELETE FROM scene WHERE id = ?').run(cur.id);
    });
    try {
      if (extras?.window?.replaceForScene) {
        extras.window.replaceForScene(prev.id, buildAdaptiveWindowsForScene(allMsgs, { sceneId: prev.id, sessionId }));
      }
    } catch { /* ignore */ }

    return { ok: true, mergedSceneId: prev.id, removedSceneId: cur.id, msgCount: st.msgCount };
  }

  /** 在 atMsgId 之前将一场一分为二，两场均置 locked=1 */
  function splitScene(params) {
    const sessionId = requireSession('splitScene', params);
    const sceneId = intParam(params.sceneId, 'sceneId', { min: 1 });
    const atMsgId = intParam(params.atMsgId, 'atMsgId', { min: 1 });
    const cur = repo.sceneById(sceneId);
    if (!cur || cur.sessionId !== sessionId) {
      throw new PanelError('SCENE_NOT_FOUND', `找不到场景 #${sceneId}`, 404);
    }
    const msgs = repo.msgsByScene(sceneId, true);
    const idx = msgs.findIndex((m) => Number(m.id) === atMsgId);
    if (idx <= 0 || idx >= msgs.length) {
      throw new PanelError('BAD_ARG', '切分点必须是该场景内的非首条消息', 400);
    }

    const leftMsgs = msgs.slice(0, idx);
    const rightMsgs = msgs.slice(idx);
    const stL = computeSceneStats(leftMsgs);
    const stR = computeSceneStats(rightMsgs);
    const gistL = buildExtractiveGist(leftMsgs);
    const gistR = buildExtractiveGist(rightMsgs);
    const gapLR = stR.startAt - stL.endAt;
    const nextScene = cur.followedBy ? repo.sceneById(cur.followedBy) : null;

    let rightId;
    withTx(db, () => {
      deleteVecRows(db, 'scene', [cur.id]);
      rightId = repo.insertScene({
        sessionId,
        startAt: stR.startAt,
        endAt: stR.endAt,
        msgCount: stR.msgCount,
        hasExcluded: stR.hasExcluded,
        excludedCount: stR.excludedCount,
        hasOutOfSurface: stR.hasOutOfSurface,
        outOfSurfaceCount: stR.outOfSurfaceCount,
        crossesCompaction: stR.crossesCompaction,
        compactedCount: stR.compactedCount,
        gapBeforeMs: gapLR,
        gapAfterMs: cur.gapAfterMs ?? null,
        precededBy: cur.id,
        followedBy: cur.followedBy ?? null,
        leadIn: leadInJsonOf(leftMsgs),
        gist: gistR,
        gistSource: gistR ? 'extractive' : null,
        locked: 1,
        createdAt: Date.now(),
      });
      stmt(
        `UPDATE scene
         SET start_at = ?, end_at = ?, msg_count = ?,
             has_excluded = ?, excluded_count = ?,
             has_out_of_surface = ?, out_of_surface_count = ?,
             crosses_compaction = ?, compacted_count = ?,
             followed_by = ?, gap_after_ms = ?,
             gist = ?, gist_source = ?, locked = 1
         WHERE id = ?`,
      ).run(
        stL.startAt,
        stL.endAt,
        stL.msgCount,
        stL.hasExcluded,
        stL.excludedCount,
        stL.hasOutOfSurface,
        stL.outOfSurfaceCount,
        stL.crossesCompaction,
        stL.compactedCount,
        rightId,
        gapLR,
        gistL,
        gistL ? 'extractive' : null,
        cur.id,
      );
      const rightMsgIds = rightMsgs.map((m) => Number(m.id));
      const ph = rightMsgIds.map(() => '?').join(',');
      db.prepare(`UPDATE msg SET scene_id = ? WHERE id IN (${ph})`).run(rightId, ...rightMsgIds);
      if (nextScene) {
        stmt('UPDATE scene SET preceded_by = ?, gap_before_ms = ?, lead_in = ? WHERE id = ?').run(
          rightId,
          nextScene.startAt - stR.endAt,
          leadInJsonOf(rightMsgs),
          nextScene.id,
        );
      }
    });
    try {
      if (extras?.window?.replaceForScene) {
        extras.window.replaceForScene(cur.id, buildAdaptiveWindowsForScene(leftMsgs, { sceneId: cur.id, sessionId }));
        extras.window.replaceForScene(rightId, buildAdaptiveWindowsForScene(rightMsgs, { sceneId: rightId, sessionId }));
      }
    } catch { /* ignore */ }

    return { ok: true, leftSceneId: cur.id, rightSceneId: rightId, leftCount: stL.msgCount, rightCount: stR.msgCount };
  }

  /** 单独对某一场运行 LLM Tier-2 摘要精炼并刷新该场 vec_scene */
  async function refineOneScene(params) {
    const sessionId = requireSession('refineOneScene', params);
    const sceneId = intParam(params.sceneId, 'sceneId', { min: 1 });
    const sc = repo.sceneById(sceneId);
    if (!sc || sc.sessionId !== sessionId) {
      throw new PanelError('SCENE_NOT_FOUND', `找不到场景 #${sceneId}`, 404);
    }
    const c = llmCfg();
    const hostLlm = getHostLlm?.();
    if (!c.enabled || !c.model || !hostLlm) {
      throw new PanelError('NO_LLM', '请先在设置中启用摘要模型并选择可用的 DSH 模型', 503);
    }
    const msgs = repo.msgsByScene(sceneId, false);
    if (msgs.length === 0) {
      throw new PanelError('BAD_ARG', '该场景内没有可用于摘要的消息', 400);
    }
    const llm = createHostLlmAdapter(hostLlm, { provider: c.provider, model: c.model });
    const gr = await generateGist({ llm, msgs, startAt: sc.startAt, endAt: sc.endAt });
    if (!gr.ok || !gr.gist) {
      throw new PanelError('LLM_FAILED', (gr.issues && gr.issues.length ? gr.issues.join('；') : null) || 'LLM 摘要生成失败', 502);
    }
    repo.setSceneGist(sceneId, gr.gist, { source: 'llm' });

    let vectorized = false;
    if (hasEmbeddingKey?.()) {
      try {
        const provider = await makeEmbeddingProvider();
        const { createVectorStore } = await import('../search/vector-store.js');
        const store = createVectorStore(handle, {
          dim: provider.dim,
          logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
        });
        const [vec] = await provider.embed([gr.gist]);
        if (vec) {
          store.upsertSceneVecs([[sceneId, vec]]);
          vectorized = true;
        }
      } catch (e) {
        logger.warn?.(`[verbatim] 单场精炼后更新 vec_scene 失败：${e?.message ?? e}`);
      }
    }

    return { ok: true, sceneId, gist: gr.gist, gistSource: 'llm', vectorized };
  }

  function assertMediaOwnership(mediaId, params) {
    const sid = typeof params?.sessionId === 'string' && params.sessionId.trim()
      ? params.sessionId.trim()
      : null;
    if (!sid) return;
    try {
      const owner = stmt(
        'SELECT m.session_id AS sessionId FROM media md JOIN msg m ON m.id = md.msg_id WHERE md.id = ?',
      ).get(mediaId);
      if (!owner || String(owner.sessionId) !== sid) {
        throw new PanelError('MEDIA_NOT_FOUND', `找不到媒体记录 #${mediaId}`, 404);
      }
    } catch (e) {
      if (e instanceof PanelError) throw e;
      throw new PanelError('MEDIA_NOT_FOUND', `找不到媒体记录 #${mediaId}`, 404);
    }
  }

  /** 安全读取已登记在 media 表中的本地图片为 data URL（防任意文件读取与跨会话越权） */
  function mediaPreview(params) {
    const id = intParam(params.id, 'id', { min: 1 });
    const row = extras?.media?.byId ? extras.media.byId(id) : null;
    if (!row) throw new PanelError('MEDIA_NOT_FOUND', `找不到媒体记录 #${id}`, 404);
    assertMediaOwnership(id, params);
    const rawPath = String(row.path || '');
    if (/^https?:\/\//i.test(rawPath)) {
      return { ok: true, id, kind: 'url', url: rawPath, width: row.width, height: row.height, caption: row.caption };
    }
    if (rawPath.startsWith('inline:')) {
      return { ok: false, id, kind: 'inline', reason: '内联图片未保留原图字节，仅存元信息' };
    }
    let p = rawPath;
    let isAttachment = false;
    const shaMatch = /^sha256:([a-f0-9]{64})$/i.exec(rawPath);
    if (shaMatch && dshHome) {
      const hex = shaMatch[1].toLowerCase();
      p = path.join(dshHome, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex);
      isAttachment = true;
    }
    const ext = path.extname(p).toLowerCase();
    let mime = IMAGE_MIME_BY_EXT[ext] ?? null;
    if (!mime && !isAttachment) {
      return { ok: false, id, kind: 'unsupported', reason: `不支持预览的文件类型：${ext || '未知'}` };
    }
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return { ok: false, id, kind: 'missing', reason: '本地图片文件已不存在或无法访问' };
    }
    const allowedRoots = [dshHome, dbRoot].filter(Boolean);
    if (allowedRoots.length > 0 && !allowedRoots.some((root) => isInsideRoot(p, root))) {
      return { ok: false, id, kind: 'forbidden', reason: '本地图片路径超出允许目录范围（仅允许 DSH 资源目录内文件）' };
    }
    if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) {
      return { ok: false, id, kind: 'too_large', reason: '文件过大（超过 5MB）或不是普通文件' };
    }
    const rawBuf = fs.readFileSync(p);
    if (!mime) mime = sniffImageMime(rawBuf);
    if (!mime) {
      return { ok: false, id, kind: 'unsupported', reason: '不支持预览的文件类型：非图片内容' };
    }
    const b64 = rawBuf.toString('base64');
    return {
      ok: true,
      id,
      kind: 'data',
      mime,
      dataUrl: `data:${mime};base64,${b64}`,
      width: row.width,
      height: row.height,
      caption: row.caption,
    };
  }

  /** 扫描当前会话高度相似/重复的笔记分组（支持 >500 条笔记，倒排索引候选剪枝避免 O(N²) 退化） */
  function findDuplicateNotes(params) {
    const sessionId = requireSession('findDuplicateNotes', params);
    const rawTh = Number(params.threshold);
    const threshold = Number.isFinite(rawTh) && rawTh >= 0.4 && rawTh <= 0.99 ? rawTh : 0.62;
    const scanLimit = 5000;
    const notes = noteHasSessionColumn()
      ? extras.note.list({ sessionId, limit: scanLimit })
      : extras.note.list({ limit: scanLimit });
    if (notes.length < 2) return { groups: [], scanned: notes.length };

    // 按时间倒序：默认保留最新的一条作为主笔记
    const sorted = [...notes].sort((a, b) => b.at - a.at || b.id - a.id);
    const grams = sorted.map((n) => bigramsOf(n.content));

    // 用 bigram 倒排索引筛选共享至少 1 个 bigram 的候选对，避免全量 O(N²) 集合求交
    const posting = new Map();
    for (let i = 0; i < grams.length; i++) {
      for (const g of grams[i]) {
        let bucket = posting.get(g);
        if (!bucket) {
          bucket = [];
          posting.set(g, bucket);
        }
        bucket.push(i);
      }
    }

    const visited = new Set();
    const groups = [];

    for (let i = 0; i < sorted.length; i++) {
      if (visited.has(sorted[i].id)) continue;
      const candIdx = new Set();
      for (const g of grams[i]) {
        const bucket = posting.get(g);
        if (!bucket || bucket.length > 250) continue;
        for (const j of bucket) {
          if (j > i) candIdx.add(j);
        }
      }
      const candidates = [...candIdx].sort((a, b) => a - b);
      const dups = [];
      for (const j of candidates) {
        if (visited.has(sorted[j].id)) continue;
        const sim = jaccardSim(grams[i], grams[j]);
        if (sim >= threshold) {
          dups.push({ ...sorted[j], similarity: Number(sim.toFixed(2)) });
        }
      }
      if (dups.length > 0) {
        visited.add(sorted[i].id);
        for (const d of dups) visited.add(d.id);
        groups.push({ keep: sorted[i], duplicates: dups });
      }
    }
    return { groups, scanned: sorted.length };
  }

  /** 合并重复笔记：保留 keepId（可选更新内容），将其余 dropIds 软删进回收站 */
  function mergeNotes(params) {
    const sessionId = requireSession('mergeNotes', params);
    const keepId = intParam(params.keepId, 'keepId', { min: 1 });
    const dropIds = Array.isArray(params.dropIds)
      ? [...new Set(params.dropIds.map((x) => Math.trunc(Number(x))).filter((x) => x > 0 && x !== keepId))]
      : [];
    if (dropIds.length === 0) throw new PanelError('BAD_ARG', '缺少要合并归档的重复笔记 dropIds', 400);

    const hasSid = noteHasSessionColumn();
    const keep = extras.note.byId(keepId, hasSid ? { sessionId } : {});
    if (!keep || keep.deletedAt !== null) {
      throw new PanelError('NOTE_NOT_FOUND', `找不到要保留的笔记 #${keepId}`, 404);
    }

    const mergedContent = typeof params.mergedContent === 'string' && params.mergedContent.trim()
      ? params.mergedContent.trim()
      : null;

    let dropped = 0;
    const now = Date.now();
    withTx(db, () => {
      if (mergedContent) {
        stmt('UPDATE note SET content = ? WHERE id = ?').run(mergedContent, keepId);
        deleteVecRows(db, 'note', [keepId]);
      }
      for (const did of dropIds) {
        dropped += extras.note.softDelete(did, now, hasSid ? { sessionId } : {});
      }
    });

    return { ok: true, keepId, dropped };
  }

  /** 人工编辑单场摘要：写 gist_source = 'manual'（永不被批量 LLM 覆盖）并同步刷新 vec_scene */
  async function setSceneGist(params) {
    const sessionId = requireSession('setSceneGist', params);
    const sceneId = intParam(params.sceneId, 'sceneId', { min: 1 });
    const gist = typeof params.gist === 'string' ? params.gist.trim() : '';
    if (!gist) throw new PanelError('BAD_ARG', '场景摘要不能为空', 400);
    if (gist.length > 1000) throw new PanelError('BAD_ARG', '单场摘要最多 1000 字', 400);
    const sc = repo.sceneById(sceneId);
    if (!sc || sc.sessionId !== sessionId) {
      throw new PanelError('SCENE_NOT_FOUND', `找不到场景 #${sceneId}`, 404);
    }
    repo.setSceneGist(sceneId, gist, { source: 'manual' });

    let vectorized = false;
    if (hasEmbeddingKey?.()) {
      try {
        const provider = await makeEmbeddingProvider();
        const { createVectorStore } = await import('../search/vector-store.js');
        const store = createVectorStore(handle, {
          dim: provider.dim,
          logger: { warn: (m) => logger.warn?.(`[verbatim] ${m}`) },
        });
        const [vec] = await provider.embed([gist]);
        if (vec) {
          store.upsertSceneVecs([[sceneId, vec]]);
          vectorized = true;
        }
      } catch (e) {
        logger.warn?.(`[verbatim] 手动更新摘要后刷新 vec_scene 失败：${e?.message ?? e}`);
      }
    }
    return { ok: true, sceneId, gist, gistSource: 'manual', vectorized };
  }

  /** 单条消息一键屏蔽/恢复检索（同步刷新所属 scene 的 excluded 派生计数） */
  function setMsgExcluded(params) {
    const sessionId = requireSession('setMsgExcluded', params);
    const msgId = intParam(params.msgId, 'msgId', { min: 1 });
    const excluded = params.excluded === true || params.excluded === 1 ? 1 : 0;
    const row = stmt('SELECT id, session_id, scene_id FROM msg WHERE id = ?').get(msgId);
    if (!row || String(row.session_id) !== sessionId) {
      throw new PanelError('MSG_NOT_FOUND', `找不到消息 #${msgId}`, 404);
    }
    withTx(db, () => {
      stmt('UPDATE msg SET excluded = ? WHERE id = ?').run(excluded, msgId);
      if (row.scene_id !== null && row.scene_id !== undefined) {
        const c = Number(
          stmt('SELECT COUNT(*) AS c FROM msg WHERE scene_id = ? AND excluded = 1').get(row.scene_id)?.c ?? 0,
        );
        stmt('UPDATE scene SET has_excluded = ?, excluded_count = ? WHERE id = ?').run(c > 0 ? 1 : 0, c, row.scene_id);
      }
    });
    if (row.scene_id !== null && row.scene_id !== undefined && extras?.window?.replaceForScene) {
      try {
        const scMsgs = repo.msgsByScene(Number(row.scene_id), true);
        extras.window.replaceForScene(Number(row.scene_id), buildAdaptiveWindowsForScene(scMsgs, { sceneId: Number(row.scene_id), sessionId }));
      } catch { /* ignore */ }
    }
    return { ok: true, msgId, excluded };
  }

  /** 直接编辑已有笔记（并清理旧 vec_note 以便下次检索懒补新向量） */
  function updateNote(params) {
    const sessionId = requireSession('updateNote', params);
    const id = intParam(params.id, 'id', { min: 1 });
    const content = typeof params.content === 'string' ? params.content.trim() : '';
    if (!content) throw new PanelError('BAD_ARG', '笔记内容不能为空', 400);
    if (content.length > 2000) throw new PanelError('BAD_ARG', '单条笔记最多 2000 字', 400);
    const hasSid = noteHasSessionColumn();
    const existing = extras.note.byId(id, hasSid ? { sessionId } : {});
    if (!existing || existing.deletedAt !== null) {
      throw new PanelError('NOTE_NOT_FOUND', `找不到笔记 #${id}`, 404);
    }
    const about = params.about === undefined
      ? existing.about
      : (['me', 'him', 'us'].includes(params.about) ? params.about : null);
    withTx(db, () => {
      stmt('UPDATE note SET content = ?, about = ? WHERE id = ?').run(content, about, id);
      deleteVecRows(db, 'note', [id]);
    });
    return { ok: true, id, content, about };
  }

  function setMediaCaption(params) {
    const id = intParam(params.id, 'id', { min: 1 });
    const row = extras?.media?.byId ? extras.media.byId(id) : null;
    if (!row) throw new PanelError('MEDIA_NOT_FOUND', `找不到媒体记录 #${id}`, 404);
    assertMediaOwnership(id, params);
    const caption = typeof params.caption === 'string' ? params.caption.trim().slice(0, 500) : '';
    const next = caption || null;
    extras.media.setCaption(id, next);
    return { ok: true, id, caption: next };
  }

  return {
    mergeScene,
    splitScene,
    refineOneScene,
    setSceneGist,
    setMsgExcluded,
    updateNote,
    mediaPreview,
    setMediaCaption,
    findDuplicateNotes,
    mergeNotes,
  };
}
