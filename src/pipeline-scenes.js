/**
 * pipeline-scenes.js —— 场景切分、增量重切、锁定保护与自适应对话窗构建。
 */

import { deleteVecRows, withTx } from './store/repo.js';
import { buildSceneWindows } from './search/window.js';
import { coalesceTurns, buildExchanges } from './search/thread.js';
import { COMPANION_AVG_CHARS } from './search/session-shape.js';
import { GAP_CUT_MS, GAP_JOIN_MS, HARD_MAX_SCENE_MSGS, splitScenesWithStats } from './scene/split.js';
import { linkScenes } from './scene/link.js';
import { buildExtractiveGist } from './derive/gist.js';

const ALL_MSGS_LIMIT = 5_000_000;
const TIME_MAX = Number.MAX_SAFE_INTEGER;

function decodeVecBlob(raw) {
  if (!raw) return null;
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (buf.byteLength < 4 || buf.byteLength % 4 !== 0) return null;
  return buf.byteOffset % 4 === 0
    ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    : new Float32Array(buf.slice().buffer);
}
function loadSessionVectors(db, sessionId) {
  if (!db || !sessionId) return null;
  const map = new Map();
  for (const table of ['vec_msg', 'vec_fallback_msg']) {
    try {
      const rows = db.prepare(
        `SELECT v.msg_id AS id, v.emb AS emb
         FROM ${table} v JOIN msg m ON m.id = v.msg_id
         WHERE m.session_id = ?`,
      ).all(sessionId);
      for (const r of rows) {
        if (!r.emb) continue;
        const buf = r.emb instanceof Uint8Array ? r.emb : new Uint8Array(r.emb);
        if (buf.byteLength < 4 || buf.byteLength % 4 !== 0) continue;
        const vec = buf.byteOffset % 4 === 0
          ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
          : new Float32Array(buf.slice().buffer);
        map.set(Number(r.id), vec);
      }
      if (map.size > 0) return map;
    } catch {
      // 表不存在或 sqlite-vec 未加载：静默跳过
    }
  }
  return map.size > 0 ? map : null;
}

function loadSceneVecMap(db, sceneIds) {
  const vecMap = new Map();
  if (!db || !Array.isArray(sceneIds) || sceneIds.length === 0) return vecMap;
  const ph = sceneIds.map(() => '?').join(',');
  for (const [table, col] of [['vec_fallback_scene', 'vec'], ['vec_scene', 'emb']]) {
    try {
      const rows = db.prepare(`SELECT scene_id, ${col} AS vec FROM ${table} WHERE scene_id IN (${ph})`).all(...sceneIds);
      for (const r of rows) {
        const sid = Number(r.scene_id);
        if (vecMap.has(sid)) continue;
        const vec = decodeVecBlob(r.vec);
        if (vec) vecMap.set(sid, vec);
      }
    } catch {
      // 表不存在或 sqlite-vec 未加载：静默跳过
    }
  }
  return vecMap;
}

function loadSceneSnapshot(db, repo, sessionId) {
  const snap = new Map();
  if (typeof repo?.scenesByTimeRange !== 'function') return snap;
  let oldScenes = [];
  try {
    oldScenes = repo.scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_MSGS_LIMIT);
  } catch {
    return snap;
  }
  if (!Array.isArray(oldScenes) || oldScenes.length === 0) return snap;
  const vecMap = loadSceneVecMap(db, oldScenes.map((s) => Number(s.id)).filter(Number.isFinite));
  for (const s of oldScenes) {
    const key = `${s.startAt}:${s.endAt}:${s.msgCount}`;
    const gist = typeof s.gist === 'string' && s.gist.trim() ? s.gist : null;
    if (!gist) continue;
    snap.set(key, {
      gist,
      gistSource: s.gistSource ?? null,
      vec: vecMap.get(Number(s.id)) ?? null,
    });
  }
  return snap;
}

function buildLockedSceneObj(lockedMsgs) {
  let outOfSurfaceCount = 0;
  let compactedCount = 0;
  let excludedCount = 0;
  for (const m of lockedMsgs) {
    if (m.inSurface === 0 || m.compactedAt !== null) outOfSurfaceCount += 1;
    if (m.compactedAt !== null) compactedCount += 1;
    if (m.excluded === 1) excludedCount += 1;
  }
  const seqs = lockedMsgs.map((m) => m.seq).filter((x) => typeof x === 'number' && Number.isFinite(x));
  return {
    msgs: lockedMsgs,
    start_at: lockedMsgs[0].at,
    end_at: lockedMsgs[lockedMsgs.length - 1].at,
    msg_count: lockedMsgs.length,
    seqFrom: seqs.length ? Math.min(...seqs) : null,
    seqTo: seqs.length ? Math.max(...seqs) : null,
    hasExcluded: excludedCount > 0 ? 1 : 0,
    excludedCount,
    hasOutOfSurface: outOfSurfaceCount > 0 ? 1 : 0,
    outOfSurfaceCount,
    crossesCompaction: compactedCount > 0 && compactedCount < lockedMsgs.length ? 1 : 0,
    compactedCount,
    locked: 1,
  };
}

function splitRespectingLocked(msgs, lockedSceneIds, vectors) {
  if (!lockedSceneIds || lockedSceneIds.size === 0) {
    return splitScenesWithStats(msgs, vectors ? { vectors } : {});
  }
  const scenes = [];
  let stats = {};
  let freeBuf = [];
  const flushFree = () => {
    if (freeBuf.length === 0) return;
    const r = splitScenesWithStats(freeBuf, vectors ? { vectors } : {});
    scenes.push(...r.scenes);
    stats = r.stats;
    freeBuf = [];
  };
  let i = 0;
  while (i < msgs.length) {
    const sid = msgs[i].sceneId === null || msgs[i].sceneId === undefined ? null : Number(msgs[i].sceneId);
    if (sid !== null && lockedSceneIds.has(sid)) {
      flushFree();
      const lockedBuf = [];
      while (i < msgs.length && Number(msgs[i].sceneId) === sid) {
        lockedBuf.push(msgs[i]);
        i += 1;
      }
      if (lockedBuf.length > 0) scenes.push(buildLockedSceneObj(lockedBuf));
    } else {
      freeBuf.push(msgs[i]);
      i += 1;
    }
  }
  flushFree();
  return { scenes, stats };
}

export function rebuildScenesForSession(opts) {
  const { repo, extras, sessionId, vectorStore } = opts;
  if (!sessionId) throw new TypeError('rebuildScenesForSession: 缺少 sessionId');

  // ① 从库里取全部消息。includeExcluded=true：被软排除的消息照样参与切分 ——
  //    它们在时间轴上是真实存在的一段，跳过切会让场景边界错位。
  const msgs = repo.msgsByTimeRange(sessionId, 0, TIME_MAX, ALL_MSGS_LIMIT, true);
  if (msgs.length === 0) {
    const cleared = extras.sceneAssign.clear(sessionId, { withIds: true });
    let sceneVectorsCleared = 0;
    if (vectorStore && cleared.sceneIds?.length) {
      sceneVectorsCleared = vectorStore.deleteSceneVecs(cleared.sceneIds);
    }
    return {
      scenes: 0, msgsAssigned: 0, splitStats: {},
      scenesWithOutOfSurface: 0, scenesWithExcluded: 0, sceneIds: [], sceneVectorsCleared,
      reusedSceneIds: [], changedSceneIds: [], reusedVectorSceneIds: [], reusedVectors: 0,
    };
  }

  const db = opts.db ?? opts.handle?.db ?? null;
  // ② 切分前先快照旧场景（按起止时刻+条数复用未变化场景的摘要与向量，同时记录人工锁定的钉子场）
  const oldSnapshot = loadSceneSnapshot(db, repo, sessionId);
  const lockedSceneIds = new Set();
  try {
    for (const s of repo.scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_MSGS_LIMIT)) {
      if (s.locked === 1) lockedSceneIds.add(Number(s.id));
    }
  } catch { /* ignore */ }

  // ③ 清旧场景（msg.scene_id 置空 + scene 行删掉 + 这些场的向量；msg 原文一个字不动）
  //    withIds 只在有 store 时才要 —— 默认返回形状保持 `{scenes, msgs}` 不变
  const cleared = extras.sceneAssign.clear(sessionId, { withIds: Boolean(vectorStore) });
  const sceneVectorsCleared = vectorStore
    ? vectorStore.deleteSceneVecs(cleared.sceneIds ?? [])
    : 0;

  // ④ 切分（纯函数，有已有向量时自动叠加阶段 B 语义精修；人工锁定的场景作为钉子保持原边界）
  const vectors = opts.vectors ?? loadSessionVectors(db, sessionId);
  const { scenes, stats } = splitRespectingLocked(msgs, lockedSceneIds, vectors);

  // ⑤ 插库拿真实 id —— 邻接字段要真实 id，所以必须切完先插、再回填
  //    未变化场景继承旧 gist（含 LLM / manual 产物）与旧向量；仅对新增/边界变化的场景生成 Tier-1 gist
  let gistsGenerated = 0;
  const reusedSceneIds = [];
  const changedSceneIds = [];
  const reusedVecPairs = [];
  const sceneIds = scenes.map((scene) => {
    const key = `${scene.start_at}:${scene.end_at}:${scene.msg_count}`;
    const hit = oldSnapshot.get(key);
    const gist = hit ? hit.gist : buildExtractiveGist(scene.msgs, vectors ? { vectors } : {});
    if (gist) gistsGenerated += 1;
    const newId = repo.insertScene({
      sessionId,
      startAt: scene.start_at,
      endAt: scene.end_at,
      msgCount: scene.msg_count,
      hasExcluded: scene.hasExcluded,
      excludedCount: scene.excludedCount,
      hasOutOfSurface: scene.hasOutOfSurface,
      outOfSurfaceCount: scene.outOfSurfaceCount,
      crossesCompaction: scene.crossesCompaction,
      compactedCount: scene.compactedCount,
      gist,
      gistSource: hit ? hit.gistSource : (gist ? 'extractive' : null),
      locked: scene.locked === 1 ? 1 : 0,
      createdAt: Date.now(),
    });
    if (hit) {
      reusedSceneIds.push(newId);
      if (hit.vec) reusedVecPairs.push([newId, hit.vec]);
    } else {
      changedSceneIds.push(newId);
    }
    return newId;
  });

  const reusedVectorSceneIds = [];
  if (vectorStore && typeof vectorStore.upsertSceneVecs === 'function' && reusedVecPairs.length > 0) {
    try {
      vectorStore.upsertSceneVecs(reusedVecPairs);
      for (const [sid] of reusedVecPairs) reusedVectorSceneIds.push(sid);
    } catch {
      // 维度不一致等异常时静默跳过，交给后续 indexScenes 重算
    }
  }

  // ⑤ 邻接回填 + 把消息挂回场景。
  //    挂回用 seq 区间：场景是时间轴上的连续切片，区间取场景内实际存在的
  //    最小/最大 seq，rewind 掉的那些 seq 本来就没有行，BETWEEN 不会误伤。
  const linked = linkScenes(scenes, { ids: sceneIds });
  let msgsAssigned = 0;
  for (let i = 0; i < linked.length; i++) {
    const scene = linked[i];
    repo.updateSceneLinks(sceneIds[i], {
      precededBy: scene.preceded_by,
      followedBy: scene.followed_by,
      gapBeforeMs: scene.gap_before_ms,
      gapAfterMs: scene.gap_after_ms,
      leadIn: scene.lead_in_msgs,
    });
    if (typeof extras.sceneAssign.assignSeqs === 'function' && Array.isArray(scene.msgs) && scene.msgs.length > 0) {
      msgsAssigned += extras.sceneAssign.assignSeqs(
        sessionId,
        scene.msgs.map((m) => m.seq),
        sceneIds[i],
      );
    } else if (scene.seqFrom !== null && scene.seqTo !== null) {
      msgsAssigned += extras.sceneAssign.assignSeqRange(
        sessionId,
        scene.seqFrom,
        scene.seqTo,
        sceneIds[i],
      );
    }
  }

  let windowsBuilt = 0;
  if (extras?.window?.replaceForScene) {
    let totalLen = 0;
    let totalCnt = 0;
    for (const sc of linked.slice(0, 20)) {
      for (const m of (sc.msgs ?? [])) {
        totalLen += String(m.text ?? '').length;
        totalCnt += 1;
      }
    }
    const companion = totalCnt > 0 ? (totalLen / totalCnt) <= COMPANION_AVG_CHARS : null;
    for (let i = 0; i < linked.length; i++) {
      const wins = buildAdaptiveWindowsForScene(linked[i].msgs ?? scenes[i]?.msgs ?? [], {
        sceneId: sceneIds[i],
        sessionId,
        isCompanion: companion,
      });
      windowsBuilt += extras.window.replaceForScene(sceneIds[i], wins).length;
    }
  }

  return {
    scenes: scenes.length,
    msgsAssigned,
    windowsBuilt,
    splitStats: stats,
    scenesWithOutOfSurface: scenes.filter((s) => s.hasOutOfSurface).length,
    scenesWithExcluded: scenes.filter((s) => s.hasExcluded).length,
    sceneIds,
    sceneVectorsCleared,
    reusedSceneIds,
    changedSceneIds,
    reusedVectorSceneIds,
    reusedVectors: reusedVectorSceneIds.length,
  };
}

/**
 * 增量同步场景（带稳定时间窗 + Rewind 局部修复 + Compaction 派生状态更新）：
 *   1. 先对比已有 scene 与当前 msg 的聚合统计：
 *      - 边界完好但 compaction / excluded 计数变了 → 原地 UPDATE 派生列，不删场、不重算摘要；
 *      - 发生 rewind（消息被删导致条数或起止时刻对不上）→ 只从受影响的那一场起重切，更早的历史场完全不动；
 *   2. 仅对未归场消息（及受影响尾部）切分；
 *   3. 距 now 不足 settleMs（默认 30m）且未达硬上限的末尾活跃场暂不封场（保持 scene_id = NULL），
 *      等静默沉淀后再稳定成场。
 */
export function syncScenesForSession(opts) {
  const { repo, extras, sessionId, vectorStore } = opts;
  if (!sessionId) throw new TypeError('syncScenesForSession: 缺少 sessionId');

  const db = opts.db ?? opts.handle?.db ?? null;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const settleMs = Number.isFinite(Number(opts.settleMs)) ? Math.max(0, Number(opts.settleMs)) : GAP_CUT_MS;

  const msgs = repo.msgsByTimeRange(sessionId, 0, TIME_MAX, ALL_MSGS_LIMIT, true);
  const existingScenes = repo.scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_MSGS_LIMIT);

  if (msgs.length === 0) {
    let scenesRemoved = 0;
    let sceneVectorsCleared = 0;
    if (existingScenes.length > 0) {
      const cleared = extras.sceneAssign.clear(sessionId, { withIds: Boolean(vectorStore) });
      scenesRemoved = cleared.scenes ?? existingScenes.length;
      if (vectorStore) sceneVectorsCleared = vectorStore.deleteSceneVecs(cleared.sceneIds ?? []);
    }
    return {
      scenes: 0,
      scenesAdded: 0,
      scenesRemoved,
      derivedUpdated: 0,
      msgsAssigned: 0,
      pendingMsgs: 0,
      sceneVectorsCleared,
      reusedSceneIds: [],
      changedSceneIds: [],
      reusedVectorSceneIds: [],
      reusedVectors: 0,
    };
  }

  // ① 按当前 msg 聚合每个已有 scene 的实际状态
  const aggByScene = new Map();
  const unassigned = [];
  for (const m of msgs) {
    const sid = m.sceneId === null || m.sceneId === undefined ? null : Number(m.sceneId);
    if (!sid) {
      unassigned.push(m);
      continue;
    }
    let agg = aggByScene.get(sid);
    if (!agg) {
      agg = { count: 0, minAt: m.at, maxAt: m.at, outOfSurface: 0, compacted: 0, excluded: 0 };
      aggByScene.set(sid, agg);
    }
    agg.count += 1;
    if (m.at < agg.minAt) agg.minAt = m.at;
    if (m.at > agg.maxAt) agg.maxAt = m.at;
    if (m.inSurface === 0 || m.compactedAt !== null) agg.outOfSurface += 1;
    if (m.compactedAt !== null) agg.compacted += 1;
    if (m.excluded === 1) agg.excluded += 1;
  }

  // ② 检查已有场景：找最早被 rewind 破坏的脏场景，同时原地刷新未破坏场景的 compaction/excluded 派生列
  let firstDirtyIdx = -1;
  let derivedUpdated = 0;
  const updDerived = db
    ? db.prepare(
      `UPDATE scene
       SET has_out_of_surface = ?, out_of_surface_count = ?,
           crosses_compaction = ?, compacted_count = ?,
           has_excluded = ?, excluded_count = ?
       WHERE id = ?`,
    )
    : null;

  for (let i = 0; i < existingScenes.length; i++) {
    const sc = existingScenes[i];
    const agg = aggByScene.get(Number(sc.id));
    if (!agg || agg.count !== sc.msgCount || agg.minAt !== sc.startAt || agg.maxAt !== sc.endAt) {
      if (firstDirtyIdx === -1) firstDirtyIdx = i;
      continue;
    }
    const hasOut = agg.outOfSurface > 0 ? 1 : 0;
    const crosses = agg.compacted > 0 && agg.compacted < agg.count ? 1 : 0;
    const hasExcl = agg.excluded > 0 ? 1 : 0;
    if (
      updDerived &&
      (sc.hasOutOfSurface !== hasOut ||
        sc.outOfSurfaceCount !== agg.outOfSurface ||
        sc.crossesCompaction !== crosses ||
        sc.compactedCount !== agg.compacted ||
        sc.hasExcluded !== hasExcl ||
        sc.excludedCount !== agg.excluded)
    ) {
      updDerived.run(hasOut, agg.outOfSurface, crosses, agg.compacted, hasExcl, agg.excluded, sc.id);
      derivedUpdated += 1;
    }
  }

  // ③ 计算需要重切的起点索引（不破坏人工锁定的场景，除非其自身消息已被变更）
  let cutFromIdx = existingScenes.length;
  if (firstDirtyIdx >= 0) {
    const stepBack = firstDirtyIdx > 0 && existingScenes[firstDirtyIdx - 1]?.locked === 1
      ? firstDirtyIdx
      : Math.max(0, firstDirtyIdx - 1);
    cutFromIdx = stepBack;
  } else if (unassigned.length > 0 && existingScenes.length > 0) {
    const lastSc = existingScenes[existingScenes.length - 1];
    if (lastSc.locked !== 1 && unassigned[0].at - lastSc.endAt <= GAP_JOIN_MS) {
      cutFromIdx = existingScenes.length - 1;
    }
  }

  if (cutFromIdx >= existingScenes.length && unassigned.length === 0) {
    return {
      scenes: existingScenes.length,
      scenesAdded: 0,
      scenesRemoved: 0,
      derivedUpdated,
      msgsAssigned: 0,
      pendingMsgs: 0,
      sceneVectorsCleared: 0,
      reusedSceneIds: [],
      changedSceneIds: [],
      reusedVectorSceneIds: [],
      reusedVectors: 0,
    };
  }

  // ④ 只清理受影响的尾部场景（更早的历史场景完全保留），清理前先快照 gist+向量以供复用
  const prevStable = cutFromIdx > 0 ? existingScenes[cutFromIdx - 1] : null;
  const affected = existingScenes.slice(cutFromIdx);
  const affectedIds = affected.map((s) => Number(s.id));
  const snapshot = new Map();
  let sceneVectorsCleared = 0;
  if (affectedIds.length > 0) {
    const vecMap = loadSceneVecMap(db, affectedIds);
    for (const s of affected) {
      const gist = typeof s.gist === 'string' && s.gist.trim() ? s.gist : null;
      if (gist) {
        snapshot.set(`${s.startAt}:${s.endAt}:${s.msgCount}`, {
          gist,
          gistSource: s.gistSource ?? null,
          vec: vecMap.get(Number(s.id)) ?? null,
        });
      }
    }
    if (vectorStore) {
      sceneVectorsCleared = vectorStore.deleteSceneVecs(affectedIds);
    }
    if (extras?.window?.clearForScenes) {
      extras.window.clearForScenes(affectedIds);
    }
    if (db) {
      const ph = affectedIds.map(() => '?').join(',');
      withTx(db, () => {
        if (prevStable) {
          db.prepare('UPDATE scene SET followed_by = NULL, gap_after_ms = NULL WHERE id = ?').run(prevStable.id);
        }
        db.prepare(`UPDATE scene SET preceded_by = NULL, followed_by = NULL WHERE id IN (${ph})`).run(...affectedIds);
        db.prepare(`UPDATE msg SET scene_id = NULL WHERE scene_id IN (${ph})`).run(...affectedIds);
        db.prepare(`DELETE FROM scene WHERE id IN (${ph})`).run(...affectedIds);
        if (!vectorStore) {
          deleteVecRows(db, 'scene', affectedIds);
        }
      });
    } else {
      extras.sceneAssign.clear(sessionId);
    }
  }

  // ⑤ 收集受影响尾部消息并切分（已保留在稳定场景里的消息不重切）
  const affectedSet = new Set(affectedIds);
  const tailMsgs = msgs.filter((m) => !m.sceneId || affectedSet.has(Number(m.sceneId)));
  const vectors = opts.vectors ?? loadSessionVectors(db, sessionId);
  const { scenes: splitList } = splitScenesWithStats(tailMsgs, vectors ? { vectors } : {});

  // ⑥ 稳定时间窗：末尾仍在活跃聊的未沉淀场景暂不封场（保留 scene_id = NULL）
  let pendingMsgs = 0;
  const settled = splitList.slice();
  if (settleMs > 0 && settled.length > 0) {
    const tail = settled[settled.length - 1];
    if (now - tail.end_at < settleMs && tail.msg_count < HARD_MAX_SCENE_MSGS) {
      pendingMsgs = tail.msg_count;
      settled.pop();
    }
  }

  if (settled.length === 0) {
    if (prevStable && db) {
      db.prepare('UPDATE scene SET followed_by = NULL, gap_after_ms = NULL WHERE id = ?').run(prevStable.id);
    }
    return {
      scenes: cutFromIdx,
      scenesAdded: 0,
      scenesRemoved: affectedIds.length,
      derivedUpdated,
      msgsAssigned: 0,
      pendingMsgs,
      sceneVectorsCleared,
      reusedSceneIds: [],
      changedSceneIds: [],
      reusedVectorSceneIds: [],
      reusedVectors: 0,
    };
  }

  // ⑦ 插入新稳定场景并链接邻接关系（整段放进同一个事务，防止中途失败留下半成品）
  const reusedSceneIds = [];
  const changedSceneIds = [];
  const reusedVecPairs = [];
  const insertAndAssign = () => {
    const newIds = settled.map((scene) => {
      const key = `${scene.start_at}:${scene.end_at}:${scene.msg_count}`;
      const hit = snapshot.get(key);
      const gist = hit ? hit.gist : buildExtractiveGist(scene.msgs, vectors ? { vectors } : {});
      const newId = repo.insertScene({
        sessionId,
        startAt: scene.start_at,
        endAt: scene.end_at,
        msgCount: scene.msg_count,
        hasExcluded: scene.hasExcluded,
        excludedCount: scene.excludedCount,
        hasOutOfSurface: scene.hasOutOfSurface,
        outOfSurfaceCount: scene.outOfSurfaceCount,
        crossesCompaction: scene.crossesCompaction,
        compactedCount: scene.compactedCount,
        gist,
        gistSource: hit ? hit.gistSource : (gist ? 'extractive' : null),
        createdAt: now,
      });
      if (hit) {
        reusedSceneIds.push(newId);
        if (hit.vec) reusedVecPairs.push([newId, hit.vec]);
      } else {
        changedSceneIds.push(newId);
      }
      return newId;
    });

    const linkedList = linkScenes(settled, { ids: newIds });
    if (prevStable) {
      const prevMsgs = repo.msgsByScene(prevStable.id, true);
      const gap = linkedList[0].start_at - prevStable.endAt;
      linkedList[0].preceded_by = prevStable.id;
      linkedList[0].gap_before_ms = gap;
      linkedList[0].lead_in_msgs = JSON.stringify(
        prevMsgs.slice(-2).map((m) => ({ seq: m.seq, at: m.at, speaker: m.speaker, text: m.text })),
      );
      if (db) {
        db.prepare('UPDATE scene SET followed_by = ?, gap_after_ms = ? WHERE id = ?').run(
          newIds[0],
          gap,
          prevStable.id,
        );
      }
    }

    let assigned = 0;
    for (let i = 0; i < linkedList.length; i++) {
      const sc = linkedList[i];
      repo.updateSceneLinks(newIds[i], {
        precededBy: sc.preceded_by,
        followedBy: sc.followed_by,
        gapBeforeMs: sc.gap_before_ms,
        gapAfterMs: sc.gap_after_ms,
        leadIn: sc.lead_in_msgs,
      });
      if (typeof extras.sceneAssign.assignSeqs === 'function' && Array.isArray(sc.msgs) && sc.msgs.length > 0) {
        assigned += extras.sceneAssign.assignSeqs(
          sessionId,
          sc.msgs.map((m) => m.seq),
          newIds[i],
        );
      } else if (sc.seqFrom !== null && sc.seqTo !== null) {
        assigned += extras.sceneAssign.assignSeqRange(sessionId, sc.seqFrom, sc.seqTo, newIds[i]);
      }
    }
    return { newSceneIds: newIds, linked: linkedList, msgsAssigned: assigned };
  };

  const { newSceneIds, linked, msgsAssigned } = db ? withTx(db, insertAndAssign) : insertAndAssign();

  const reusedVectorSceneIds = [];
  if (vectorStore && typeof vectorStore.upsertSceneVecs === 'function' && reusedVecPairs.length > 0) {
    try {
      vectorStore.upsertSceneVecs(reusedVecPairs);
      for (const [sid] of reusedVecPairs) reusedVectorSceneIds.push(sid);
    } catch {
      // 维度不一致等异常时交由后续索引重算
    }
  }

  let windowsBuilt = 0;
  if (extras?.window?.replaceForScene) {
    const companion = detectCompanionForSession(repo, sessionId, linked.slice(0, 20).map((s) => s.msgs ?? []));
    for (let i = 0; i < linked.length; i++) {
      const wins = buildAdaptiveWindowsForScene(linked[i].msgs ?? settled[i]?.msgs ?? [], {
        sceneId: newSceneIds[i],
        sessionId,
        isCompanion: companion,
      });
      windowsBuilt += extras.window.replaceForScene(newSceneIds[i], wins).length;
    }
  }

  return {
    scenes: cutFromIdx + settled.length,
    scenesAdded: settled.length,
    scenesRemoved: affectedIds.length,
    derivedUpdated,
    msgsAssigned,
    windowsBuilt,
    pendingMsgs,
    sceneVectorsCleared,
    reusedSceneIds,
    changedSceneIds,
    reusedVectorSceneIds,
    reusedVectors: reusedVectorSceneIds.length,
  };
}

/**
 * 为已存在但尚未生成滑动对话窗的场景补齐 `window` 记录（v12→v13 平滑升级用）。
 * 已有窗口的场景跳过不动，不破坏已有 vec_window。
 */
/**
 * 按会话形态生成场景内检索单元（陪伴型 → Turn+Exchange；技术型 → 滑动对话窗）。
 * 陪伴型先合并连发并配对 Q&A，随后在 indexer.indexPendingWindows 嵌入完向量后
 * 直接复用内存向量按局部谷值切出 Thread 微话题对话线，零 LLM、零多余调用。
 */
export function buildAdaptiveWindowsForScene(msgs, { sceneId, sessionId, isCompanion = null }) {
  const valid = (msgs ?? []).filter((m) => m && Number(m.excluded) !== 1 && String(m.text ?? '').trim());
  if (valid.length < 2) return [];

  // 收敛到陪伴优先：默认统一生成 exchange（随后由 indexer 聚合成 thread），仅显式传 isCompanion=false 时退回滑动 window
  const companion = isCompanion !== false;

  if (companion) {
    const turns = coalesceTurns(valid);
    const exs = buildExchanges(turns);
    return exs.map((e, idx) => ({
      sceneId,
      sessionId,
      idx,
      kind: 'exchange',
      startMsgId: e.startMsgId,
      endMsgId: e.endMsgId,
      startAt: e.startAt,
      endAt: e.endAt,
      msgCount: e.msgs.length,
      charCount: e.text.length,
      text: e.text,
    }));
  }
  return buildSceneWindows(msgs, { sceneId, sessionId });
}

function detectCompanionForSession(repo, sessionId, fallbackMsgLists = []) {
  let totalLen = 0;
  let totalCnt = 0;
  const scenes = repo && sessionId ? repo.scenesByTimeRange(sessionId, 0, TIME_MAX, 20) : [];
  for (const sc of scenes) {
    for (const m of repo.msgsByScene(sc.id, false)) {
      totalLen += String(m.text ?? '').length;
      totalCnt += 1;
    }
  }
  if (totalCnt === 0) {
    for (const list of fallbackMsgLists) {
      for (const m of list) {
        totalLen += String(m.text ?? '').length;
        totalCnt += 1;
      }
    }
  }
  return totalCnt > 0 ? (totalLen / totalCnt) <= COMPANION_AVG_CHARS : null;
}

export function ensureWindowsForSession({ repo, extras, sessionId, force = false, isCompanion = null } = {}) {
  if (!repo || !extras?.window?.replaceForScene || !sessionId) return { scenesScanned: 0, windowsBuilt: 0 };
  const scenes = repo.scenesByTimeRange(sessionId, 0, TIME_MAX, ALL_MSGS_LIMIT);
  // 收敛到陪伴优先：默认统一使用 exchange → thread，仅显式传 isCompanion=false 时才用滑动 window
  const companion = isCompanion !== false;
  let windowsBuilt = 0;
  let scenesScanned = 0;
  for (const sc of scenes) {
    const existing = !force ? extras.window.byScene(sc.id) : [];
    const needsLegacyUpgrade = companion === true && existing.length > 0 && existing.every((w) => w.kind === 'window');
    if (!force && existing.length > 0 && !needsLegacyUpgrade) continue;
    const msgs = repo.msgsByScene(sc.id, false);
    if (msgs.length < 2) continue;
    scenesScanned += 1;
    const wins = buildAdaptiveWindowsForScene(msgs, { sceneId: sc.id, sessionId, isCompanion: companion });
    if (wins.length > 0) {
      windowsBuilt += extras.window.replaceForScene(sc.id, wins).length;
    }
  }
  return { scenesScanned, windowsBuilt };
}
