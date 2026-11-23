/**
 * 笔记检索与相关性打分（关键词 + vec_note 语义融合 + 分数门槛）。
 *
 * 供 Agent 工具 `memory_search` 与面板 `panel.search` 共用，避免重复实现两套打分逻辑。
 */

export const NOTE_MIN_SCORE_DEFAULT = 0.58;
export const PINNED_NOTE_MAX_DEFAULT = 3;

const NOTE_PROBE_LIMIT = 500;

/** 与 FTS/keyword 共用的基础切词（按标点与空白拆词） */
function splitTerms(raw) {
  return String(raw ?? '')
    .trim()
    .split(/[\s,，。！？、；："''""（）()【】\[\]]+/)
    .filter(Boolean);
}

/**
 * 计算单条笔记与 query 的字面相关性。
 * @param {string} content
 * @param {string} query
 * @returns {{ matched: boolean, score: number }}
 */
export function scoreNoteKeyword(content, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return { matched: false, score: 0 };
  const text = String(content ?? '').toLowerCase();
  if (!text) return { matched: false, score: 0 };

  if (text.includes(q)) {
    return { matched: true, score: Array.from(q).length >= 2 ? 1.0 : 0.85 };
  }

  const terms = splitTerms(q);
  if (terms.length <= 1) return { matched: false, score: 0 };

  let hitCount = 0;
  for (const term of terms) {
    if (text.includes(term)) hitCount += 1;
  }
  const ratio = hitCount / terms.length;
  if (ratio < 0.6) return { matched: false, score: 0 };

  return { matched: true, score: Number((0.65 + 0.3 * ratio).toFixed(4)) };
}

/**
 * 若有 provider + store，为尚未入 vec_note 的本会话活跃笔记懒补向量（数量极少，单次最多补 64 条）。
 */
async function ensureNoteVectors({ store, provider, pool }) {
  if (!store || !provider || typeof store.upsertNoteVecs !== 'function' || pool.length === 0) return;
  try {
    const candidates = pool.filter((n) => typeof n.content === 'string' && n.content.trim());
    if (candidates.length === 0) return;
    let missing = candidates;
    if (typeof store.missingNoteIds === 'function') {
      const missingSet = new Set(store.missingNoteIds(candidates.map((n) => n.id)));
      if (missingSet.size === 0) return;
      missing = candidates.filter((n) => missingSet.has(Number(n.id)));
    } else if (typeof store.countNoteVec === 'function' && store.countNoteVec() > 0) {
      return;
    }
    const batch = missing.slice(0, 64);
    if (batch.length === 0) return;
    const vecs = await provider.embed(batch.map((n) => n.content));
    const pairs = [];
    for (let i = 0; i < batch.length; i++) {
      if (vecs[i]) pairs.push([batch[i].id, vecs[i]]);
    }
    if (pairs.length > 0) store.upsertNoteVecs(pairs);
  } catch {
    // 懒补失败不影响主检索
  }
}

/**
 * 对当前会话的笔记做「关键词 + 语义」融合检索，并按分数门槛过滤。
 *
 * @param {{
 *   extras: object,
 *   sessionId: string|null,
 *   query: string,
 *   from?: number|null,
 *   to?: number|null,
 *   provider?: object|null,
 *   store?: object|null,
 *   queryVec?: Float32Array|number[]|null,
 *   minScore?: number,
 *   limit?: number,
 * }} opts
 * @returns {Promise<{ hits: object[], totalMatched: number, semanticUsed: boolean, queryVec: Float32Array|number[]|null }>}
 */
export async function searchRankedNotes(opts) {
  const {
    extras,
    sessionId,
    query,
    from = null,
    to = null,
    provider = null,
    store = null,
    minScore = NOTE_MIN_SCORE_DEFAULT,
    limit = 50,
  } = opts;
  let queryVec = opts.queryVec ?? null;

  const q = String(query ?? '').trim();
  const all = extras?.note?.list
    ? extras.note.list({ limit: Math.max(NOTE_PROBE_LIMIT, limit), sessionId })
    : [];

  let pool = all;
  if (Number.isFinite(from) && Number.isFinite(to)) {
    pool = pool.filter((n) => Number(n.at) >= from && Number(n.at) < to);
  }

  if (!q) {
    return { hits: pool.slice(0, limit), totalMatched: pool.length, semanticUsed: false, queryVec };
  }

  const byId = new Map();

  // 1. 关键词打分
  for (const n of pool) {
    const kw = scoreNoteKeyword(n.content, q);
    if (!kw.matched) continue;
    byId.set(Number(n.id), {
      ...n,
      score: kw.score,
      sources: ['keyword'],
    });
  }

  // 2. 语义路（vec_note）
  let semanticUsed = false;
  if (store && typeof store.knnNote === 'function' && (queryVec || (provider && typeof provider.embed === 'function'))) {
    try {
      await ensureNoteVectors({ store, provider, pool });
      if (store.countNoteVec() > 0) {
        if (!queryVec && provider) {
          const [v] = await provider.embed([q]);
          queryVec = v ?? null;
        }
        if (queryVec) {
          semanticUsed = true;
          const vecFilter = {
            sessionId: sessionId ?? undefined,
            limit: Math.max(limit, 12),
            minScore,
          };
          if (Number.isFinite(from)) vecFilter.from = from;
          if (Number.isFinite(to)) vecFilter.to = to;

          const vecHits = store.knnNote(queryVec, Math.max(limit, 12), vecFilter);
          for (const vh of vecHits) {
            const id = Number(vh.id);
            const prev = byId.get(id);
            if (prev) {
              if (!prev.sources.includes('vector')) prev.sources.push('vector');
              prev.score = Number(Math.min(1.0, Math.max(prev.score, vh.score) + 0.08).toFixed(4));
            } else {
              byId.set(id, {
                id,
                content: vh.content,
                about: vh.about,
                at: vh.at,
                sessionId: vh.sessionId,
                score: Number(vh.score.toFixed(4)),
                sources: ['vector'],
              });
            }
          }
        }
      }
    } catch {
      // 语义路失败时优雅保留关键词命中
    }
  }

  const ranked = [...byId.values()]
    .filter((n) => (n.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Number(b.at) - Number(a.at) || Number(b.id) - Number(a.id));

  return {
    hits: ranked.slice(0, limit),
    totalMatched: ranked.length,
    semanticUsed,
    queryVec,
  };
}
