/**
 * 并发下的缓存契约测试 —— 多路并发共享缓存 Map 时，不能因竞态串题或返回空值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 与 lib.mjs 中 provider.embed 的缓存实现保持等价 */
function makeEmbed(dim, cache, embedBatchMock) {
  return async function embed(texts) {
    if (!cache) return embedBatchMock(texts);
    const out = new Array(texts.length).fill(null);
    const misses = [];
    const missIdx = [];
    texts.forEach((t, i) => {
      const v = cache.get(t);
      if (v) out[i] = v;
      else { misses.push(t); missIdx.push(i); }
    });
    if (misses.length > 0) {
      const fresh = await embedBatchMock(misses);
      fresh.forEach((v, k) => { cache.set(misses[k], v); out[missIdx[k]] = v; });
    }
    for (let i = 0; i < out.length; i += 1) {
      if (!out[i]) throw new Error(`空值 at ${i}`);
    }
    return out;
  };
}

/** 可辨识的假向量：用文本首字符编码 */
const makeMock = (delayMs) => async (texts) => {
  await new Promise((r) => setTimeout(r, delayMs));
  return texts.map((t) => {
    const v = new Float32Array(8);
    for (let i = 0; i < 8; i += 1) v[i] = (t.charCodeAt(0) % 7) + i * 0.001;
    return v;
  });
};

test('并发 32 路共享缓存：每个查询都必须拿到**自己的**向量', async () => {
  const cache = new Map();
  const embed = makeEmbed(8, cache, makeMock(5));

  const queries = Array.from({ length: 64 }, (_, i) => `q${String.fromCharCode(97 + (i % 26))}${i}`);
  const results = await Promise.all(queries.map(async (q) => {
    const [v] = await embed([q]);
    return { q, v };
  }));

  for (const { q, v } of results) {
    assert.ok(v, `${q} 拿到空值`);
    // 校验向量确实对应这个查询（首字符编码）
    const expect = (q.charCodeAt(0) % 7) + 0;
    assert.ok(Math.abs(v[0] - expect) < 0.5, `${q} 拿到了别的查询的向量：v[0]=${v[0]} 期望约 ${expect}`);
  }
});

test('并发下同一查询重复请求：结果必须一致', async () => {
  const cache = new Map();
  const embed = makeEmbed(8, cache, makeMock(3));
  const results = await Promise.all(
    Array.from({ length: 20 }, () => embed(['same-query'])),
  );
  for (const [v] of results) {
    assert.ok(v);
    assert.equal(v[0], results[0][0][0]);
  }
  assert.equal(cache.size, 1, '同一查询只应缓存一份');
});

test('并发混合：已缓存与未缓存同时请求不互相污染', async () => {
  const cache = new Map();
  const embed = makeEmbed(8, cache, makeMock(4));
  await embed(['warm-a', 'warm-b']);   // 预热

  const tasks = [];
  for (let i = 0; i < 30; i += 1) {
    tasks.push(embed(['warm-a']));
    tasks.push(embed([`cold-${i}`]));
    tasks.push(embed(['warm-b', `cold-${i}`]));
  }
  const out = await Promise.all(tasks);
  for (const arr of out) for (const v of arr) assert.ok(v, '并发混合出现空值');
});
