/**
 * T6 测试脚手架 —— 造数据、开内存库、算参考 top-k
 *
 * 为什么要有这个文件：三个测试文件都要「100 条假向量 + 一张真库」，
 * 复制三遍容易漂移。这里只放测试辅助，不放任何生产逻辑。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import { textToVector } from '../model/mock.js';

import { normalizeVector, dot } from './vector-store.js';

/** 静默 logger：降级 warning 不该刷测试输出 */
export const silent = { warn() {}, info() {} };

/** 统一用 1024 维（D-144）。schema.sql 的 vec 表写死了 float[1024]，测试也照这个来。 */
export const DIM = 1024;

/** 临时目录（sqlite-vec 的 dll 落地路径要用），退出时清掉 */
export const TMP = mkdtempSync(join(tmpdir(), 'verbatim-t6-'));
process.on('exit', () => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
});

/**
 * 开一个内存库。
 * @param {{loadVec?: boolean}} [opts] loadVec=false 用来测「sqlite-vec 加载失败」的降级路径
 */
export function openMemory(opts = {}) {
  // 注意：这里**不能**传 dshHome。vec0 扩展是按 dshHome 找的
  // （$DSH_HOME/verbatim/native/vec0.dll），指到临时目录就找不到了，
  // 于是所有用例都会静默降级成暴力余弦 —— 那就测不到 vec0 路径了。
  const handle = openDb({
    dbPath: ':memory:',
    loadVec: opts.loadVec !== false,
    logger: silent,
  });
  return {
    handle,
    repo: createRepo(handle),
    extras: createExtras(handle),
    close: () => handle.close(),
  };
}

/**
 * 造 N 条消息 + 对应向量。
 *
 * 文本是确定性的（`第 i 句关于 <词>`），向量用 mock 的 textToVector（同文本同向量），
 * 所以期望的 top-k 可以在测试里独立算出来对账。
 *
 * @param {{repo: object, count: number, sessionId?: string, startAt?: number, stepMs?: number,
 *          prefix?: string}} args
 * @returns {{msgs: object[], vectors: Map<number, Float32Array>}}
 */
/** @param {{ repo: any, count: number, sessionId?: string, startAt?: number, stepMs?: number, prefix?: string }} opts */
export function seedMsgs({ repo, count, sessionId = 's-test', startAt = 1_760_000_000_000, stepMs = 60_000, prefix = '第' }) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      sessionId,
      seq: i + 1,
      at: startAt + i * stepMs,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      text: `${prefix}${i}句关于月见草和害怕的事`,
      inSurface: 1,
    });
  }
  const ids = repo.insertMsgs(rows);
  const msgs = rows.map((r, i) => ({ ...r, id: ids[i] }));
  const vectors = new Map();
  for (const m of msgs) vectors.set(m.id, textToVector(m.text, DIM));
  return { msgs, vectors };
}

/**
 * 参考实现：在单位向量集合上算精确余弦 top-k。
 *
 * 这是「正确答案」的唯一来源 —— 测试不拿 vec0 的结果当真值，
 * 而是拿数学算出来的结果当真值，这样 vec0 路径和降级路径都被同一个尺子量。
 *
 * @param {Float32Array|number[]} query
 * @param {Map<number, Float32Array>} vectors
 * @param {number} k
 * @returns {{id: number, score: number}[]}
 */
export function referenceTopK(query, vectors, k) {
  const q = normalizeVector(query, DIM, '测试查询向量');
  const scored = [];
  for (const [id, vec] of vectors) scored.push({ id, score: dot(q, normalizeVector(vec, DIM, '测试向量')) });
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  return scored.slice(0, k);
}

/** 断言两个 top-k 的 id 序列一致 */
export function idsOf(hits) {
  return hits.map((h) => h.id);
}
