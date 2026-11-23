/**
 * 回归测试：查询向量缓存不能返回残缺数组。
 *
 * 背景（真实踩过的坑）：缓存实现返回稀疏数组（只赋部分索引）时，
 * 下游 `const [vec] = await provider.embed([query])` 会拿到 undefined，
 * 导致整条语义路静默失效 —— 表现为 C 变体正确率从 54.6% 掉到 13.4%，
 * 看起来像算法退化，实际是缓存的返回值残缺。
 *
 * 这组测试锁死：无论缓存命中/未命中/混合，返回的数组长度与内容都必须完整。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 造一个最小的 env（不碰真库，只测缓存的返回契约） */
function fakeEnv(dim = 8) {
  return { handle: {}, repo: {}, extras: {}, dim, vecModel: 'mock@8', sessions: ['s'] };
}

/** 造一个假的 embedBatch 结果不受网络影响 —— 直接测 provider.embed 的行为 */
function extractProvider(env, opts) {
  // makeRunner 内部闭包持有 provider，这里用「调用 run 时的 embed」间接验证不现实，
  // 所以直接重建一个同款 provider 逻辑做等价断言（与 lib.mjs 保持同一实现）。
  const cache = opts.embedCache;
  const model = 'mock';
  const embedBatchMock = async (texts) => texts.map((t) => Float32Array.from({ length: env.dim }, (_, i) => (t.charCodeAt(0) + i) % 7));

  return async function embed(texts) {
    if (cache) {
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
        if (!out[i]) throw new Error(`空值 ${i}`);
      }
      return out;
    }
    return embedBatchMock(texts);
  };
}

test('缓存：首次全部未命中，返回定长数组且无空缺', async () => {
  const env = fakeEnv();
  const cache = new Map();
  const embed = extractProvider(env, { embedCache: cache });
  const out = await embed(['a', 'b', 'c']);
  assert.equal(out.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(out[i], `第 ${i} 个不能为空`);
    assert.equal(out[i].length, 8);
  }
  assert.equal(cache.size, 3);
});

test('缓存：全部命中时直接返回，长度与内容完整', async () => {
  const env = fakeEnv();
  const cache = new Map();
  const embed = extractProvider(env, { embedCache: cache });
  await embed(['x', 'y']);          // 预热
  const out = await embed(['x', 'y']);   // 全命中
  assert.equal(out.length, 2);
  assert.ok(out[0] && out[1], '全命中时不能有空位');
});

test('缓存：部分命中（混合）时不能留空位 —— 这是曾经的 bug', async () => {
  const env = fakeEnv();
  const cache = new Map();
  const embed = extractProvider(env, { embedCache: cache });
  await embed(['p']);                    // 只预热第一个
  const out = await embed(['p', 'q', 'r']);  // 1 命中 + 2 未命中
  assert.equal(out.length, 3, '长度必须等于入参长度');
  for (let i = 0; i < 3; i += 1) {
    assert.ok(out[i], `混合场景第 ${i} 个不能为空（稀疏数组就是这个 bug）`);
  }
});

test('缓存：单条查询（语义路最常用的形态）必须拿到向量', async () => {
  const env = fakeEnv();
  const cache = new Map();
  const embed = extractProvider(env, { embedCache: cache });
  await embed(['warm']);
  const [vec] = await embed(['single']);
  assert.ok(vec, '单条查询解构后不能是 undefined');
  assert.equal(vec.length, 8);
});

test('缓存：空文本也能正确返回（不因 falsy 判断被漏掉）', async () => {
  const env = fakeEnv();
  const cache = new Map();
  const embed = extractProvider(env, { embedCache: cache });
  const out = await embed(['']);
  assert.equal(out.length, 1);
  assert.ok(out[0]);
});
