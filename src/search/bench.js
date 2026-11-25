/**
 * T6 性能实测 —— 1024 维 × 7,572 条
 *
 * 跑法：
 *   node src/search/bench.js
 *   node src/search/bench.js --n=20000          # 换条数
 *   node src/search/bench.js --queries=500      # 换查询次数
 *   node src/search/bench.js --file             # 用文件库（看库体积）
 *   node src/search/bench.js --file --cache=64  # 文件库 + cache_size=64MB（实测能快 10 倍以上）
 *
 * 要回答的问题只有一个：**这条路能不能扛住真实量级**（IMPLEMENTATION.md §1 的实测口径）。
 * 所以这里报的是端到端耗时：embedding（mock）+ 写 vec0 + KNN + 外层 JOIN 过滤，
 * 而不是只报一次裸 KNN。
 *
 * 注意：mock embedding 没有网络延迟，所以"索引构建"里的 embedding 部分只反映
 * 本地 CPU 成本；真实硅基流动调用会是 100~500 ms × 237 批，那才是索引慢的主因（D-146）。
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { openDb } from '../store/db.js';
import { createRepo, createExtras } from '../store/repo.js';
import { mockEmbedding } from '../model/mock.js';

import { createVectorStore, DEFAULT_DIM } from './vector-store.js';
import { createIndexer } from './indexer.js';

/* --------------------------------- 参数 --------------------------------- */

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const N = argOf('n', 7572);
const QUERIES = argOf('queries', 200);
const K = argOf('k', 10);
const USE_FILE = argv.includes('--file');
const CACHE_MB = argOf('cache', 0); // 0 = 用 SQLite 默认（2MB）
const DIM = DEFAULT_DIM;
const BATCH = 32; // 和 T5 的 embedding provider 保持一致
const WRITE_PAGE = 500; // 和 indexer 的 pending 分页一致

const silent = { warn() {}, info() {} };

/* --------------------------------- 工具 --------------------------------- */

const fmt = (ms) =>
  ms < 10 ? `${ms.toFixed(2)} ms` : ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    name,
    count: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function printRow(r) {
  console.log(
    `  ${r.name.padEnd(26)} 次数 ${String(r.count).padStart(4)}  ` +
      `min ${fmt(r.min).padStart(9)}  p50 ${fmt(r.median).padStart(9)}  ` +
      `p95 ${fmt(r.p95).padStart(9)}  max ${fmt(r.max).padStart(9)}  mean ${fmt(r.mean).padStart(9)}`,
  );
}

/** 造 7572 条像真消息的文本（含重复词，FTS 才有的玩） */
function makeText(i) {
  const heads = ['用户问', 'TA说', '我提了一句', '刚才聊到'];
  const topics = ['月见草', '怕黑', '那天下雨', '猫', '睡不着', '面试', '搬家'];
  const tails = ['，然后就没说了', '，你还记得吧', '，我有点在意', '，算了', '，后来呢'];
  return `${heads[i % heads.length]}${topics[i % topics.length]}第${i}条${tails[i % tails.length]}`;
}

/* -------------------------------- 主流程 -------------------------------- */

const tempDir = USE_FILE ? mkdtempSync(join(tmpdir(), 'verbatim-bench-')) : null;
const dbPath = USE_FILE ? join(tempDir, 'memory.db') : ':memory:';

const handle = openDb({ dbPath, loadVec: true, logger: silent });
// cache_size 对 vec0 特别关键：默认 2MB 装不下 34MB 的向量页，每次写/查都要重读
if (CACHE_MB > 0) handle.db.exec(`PRAGMA cache_size = -${CACHE_MB * 1024};`);
const repo = createRepo(handle);
const extras = createExtras(handle);

console.log('\n=== T6 向量索引性能实测 ===');
console.log(`  节点 ${process.version} / 平台 ${process.platform}-${process.arch}`);
console.log(`  sqlite-vec v${String(handle.db.prepare('SELECT vec_version() AS v').get().v).replace(/^v/, '')} / hasVec=${handle.hasVec}`);
console.log(`  维度 ${DIM} / 条数 ${N} / k=${K} / 查询 ${QUERIES} 次 / 库 ${USE_FILE ? dbPath : ':memory:'}`);
console.log(`  cache_size ${String(handle.db.prepare('PRAGMA cache_size').get().cache_size)}（负数 = KB）`);
if (!handle.hasVec) {
  console.log('  ⚠ 这台机器没加载上 sqlite-vec，下面只有降级路径的数字');
}

try {
  /* ① 入库（真实场景里由 T2/T1 完成；这里只报数，不算进索引耗时） */
  let t0 = performance.now();
  const rows = [];
  for (let i = 0; i < N; i++) {
    rows.push({
      sessionId: 'bench',
      seq: i + 1,
      at: 1_760_000_000_000 + i * 60_000,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      text: makeText(i),
      inSurface: 1,
    });
  }
  const ids = repo.insertMsgs(rows);
  const insertMs = performance.now() - t0;

  /* ② 索引构建：mock embedding + 分批写 vec_msg（和 indexer 同一套路径） */
  const provider = /** @type {any} */ (mockEmbedding(DIM, { maxBatch: BATCH }));
  const store = createVectorStore(handle, { dim: DIM, logger: silent });
  const indexer = createIndexer({ handle, provider, extras, store, logger: silent });

  t0 = performance.now();
  let embedMs = 0;
  let writeMs = 0;
  for (let i = 0; i < N; i += WRITE_PAGE) {
    const page = [];
    for (let j = i; j < Math.min(N, i + WRITE_PAGE); j++) page.push({ id: ids[j], text: rows[j].text });
    const e0 = performance.now();
    // 走 indexMsgs 之外的分批循环，把 embedding 与写库的时间分开报
    const vectors = [];
    for (let b = 0; b < page.length; b += BATCH) {
      const slice = page.slice(b, b + BATCH);
      const out = await provider.embed(slice.map((p) => p.text));
      slice.forEach((p, k2) => vectors.push([p.id, out[k2]]));
    }
    embedMs += performance.now() - e0;
    const w0 = performance.now();
    store.insertMsgVecs(vectors);
    writeMs += performance.now() - w0;
  }
  const buildMs = performance.now() - t0;
  const indexed = store.countMsgVec();

  /* ③ KNN 查询：随机取查询文本，只计"查询向量已就绪之后的检索" */
  const queryIdx = [];
  for (let i = 0; i < QUERIES; i++) queryIdx.push((i * 37 + 11) % N);
  const queryVectors = [];
  for (const idx of queryIdx) queryVectors.push(rows[idx].text);
  const qv = [];
  for (let b = 0; b < queryVectors.length; b += BATCH) {
    const out = await provider.embed(queryVectors.slice(b, b + BATCH));
    qv.push(...out);
  }

  const knnSamples = [];
  let sanityHit = 0;
  for (let i = 0; i < QUERIES; i++) {
    const t = performance.now();
    /** @type {any[]} */
    const hits = store.knnMsg(qv[i], K);
    knnSamples.push(performance.now() - t);
    if (hits[0]?.id === ids[queryIdx[i]]) sanityHit += 1; // 自己查自己应当第一
  }

  /* ④ 裸 KNN（只算 vec0 那一段，不 JOIN）—— 用来和文档里"查询 9.50 ms"对账 */
  const bareSamples = [];
  for (let i = 0; i < QUERIES; i++) {
    const t = performance.now();
    store.candidates('msg', qv[i], K);
    bareSamples.push(performance.now() - t);
  }

  /* ⑤ 外层过滤（时间窗）后的 KNN —— 真实查询几乎都带时间窗 */
  const filteredSamples = [];
  for (let i = 0; i < QUERIES; i++) {
    const anchorAt = rows[queryIdx[i]].at;
    const t = performance.now();
    store.knnMsg(qv[i], K, { from: anchorAt - 86_400_000, to: anchorAt + 86_400_000 });
    filteredSamples.push(performance.now() - t);
  }

  /* ⑥ 降级路径（内存暴力余弦）同样的量级对比 */
  const fallback = createVectorStore(handle, { dim: DIM, hasVec: false, persistFallback: false, logger: silent });
  const allVectors = [];
  for (let i = 0; i < N; i += WRITE_PAGE) {
    const page = [];
    for (let j = i; j < Math.min(N, i + WRITE_PAGE); j++) {
      const out = await provider.embed([rows[j].text]);
      page.push([ids[j], out[0]]);
    }
    allVectors.push(page);
  }
  const t1 = performance.now();
  for (const page of allVectors) fallback.insertMsgVecs(page);
  const fallbackLoadMs = performance.now() - t1;

  const bruteSamples = [];
  const bareBruteSamples = [];
  let sameIds = 0;
  for (let i = 0; i < QUERIES; i++) {
    const t = performance.now();
    const hits = fallback.knnMsg(qv[i], K);
    bruteSamples.push(performance.now() - t);

    const t2 = performance.now();
    fallback.candidates('msg', qv[i], K);
    bareBruteSamples.push(performance.now() - t2);

    /** @type {any[]} */
    const viaVec0 = store.knnMsg(qv[i], K);
    if (JSON.stringify(/** @type {any[]} */ (hits).map((h) => h.id)) === JSON.stringify(viaVec0.map((h) => h.id))) sameIds += 1;
  }

  /* ⑥ 报告 */
  const vec0Bytes = (() => {
    try {
      const pages = Number(handle.db.prepare('PRAGMA page_count').get().page_count);
      const pageSize = Number(handle.db.prepare('PRAGMA page_size').get().page_size);
      return pages * pageSize;
    } catch {
      return 0;
    }
  })();

  console.log('\n--- 入库 & 索引构建 ---');
  console.log(`  ${'msg 入库（T1，不算索引）'.padEnd(26)} ${fmt(insertMs)}`);
  console.log(`  ${'embedding（mock，32/批）'.padEnd(26)} ${fmt(embedMs)}`);
  console.log(`  ${'写 vec_msg（500/事务）'.padEnd(26)} ${fmt(writeMs)}`);
  console.log(`  ${'索引构建合计'.padEnd(26)} ${fmt(buildMs)}   → ${(indexed / (buildMs / 1000)).toFixed(0)} 条/秒`);
  console.log(`  已索引 ${indexed} 条 / vec0 库体积 ${mb(vec0Bytes)}`);

  console.log('\n--- KNN 查询 ---');
  console.log('  （裸 KNN = 只跑 vec0/暴力余弦那一段；带 JOIN = 加上外层 msg 表取行 + 时间过滤）');
  printRow(summarize('裸 vec0 KNN', bareSamples));
  printRow(summarize('裸暴力余弦', bareBruteSamples));
  printRow(summarize('vec0 KNN + 外层 JOIN', knnSamples));
  printRow(summarize('vec0 KNN + 时间窗过滤', filteredSamples));
  printRow(summarize('降级：暴力余弦 + JOIN', bruteSamples));
  console.log(`  降级索引装载（${N} 条进内存） ${fmt(fallbackLoadMs)}`);
  console.log(`  自查询命中第一：${sanityHit}/${QUERIES}`);
  console.log(`  两条路径 top-${K} 完全一致：${sameIds}/${QUERIES}`);
  console.log(`  降级常驻内存 ${mb(N * DIM * 4)}（D-144 说的"一年后压在 JS 堆"就是这笔钱）`);

  if (USE_FILE) {
    const size = statSync(dbPath).size;
    console.log(`\n--- 库体积 ---\n  文件 ${mb(size)}（${dbPath}）`);
  }
  console.log('');
} finally {
  handle.close();
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔删不掉，忽略 */
    }
  }
}
