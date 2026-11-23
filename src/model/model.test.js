/**
 * 模型层测试 —— 全部本地，不发任何真实网络请求
 *
 * 三个重点：
 * ① 确定性 mock 的不变量（同文本同向量、异文本近似正交）
 * ② 硅基流动 provider 的批处理、截断+重归一化、重试、不泄露 Key
 * ③ DeepSeek provider 的重试、JSON 宽容解析、不泄露 Key
 *
 * 这里用注入的 `fetchImpl` 假造响应，而不是真调 API：
 * 硅基流动余额不足会失败，DeepSeek 也不该为测试烧钱。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mockEmbedding, mockLlm, textToVector } from './mock.js';
import { createSiliconFlowEmbedding, assertSameModel } from './embedding.js';
import { createDeepSeekLlm, parseJsonLoose } from './llm.js';

// ─────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────

/** 点积（两向量都已归一化 → 等于余弦相似度） */
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** 近似比较两个向量（Float32 舍入误差容忍 1e-5） */
function assertNear(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length, '维度应一致');
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `第 ${i} 个分量偏差过大：${actual[i]} vs ${expected[i]}`,
    );
  }
}

/** 加速重试退避：测试里把退避压到 0，免得真等 1s/2s */
function fastRetry(p) {
  return p;
}

/** 造一个假的 embedding 响应 */
function fakeEmbedResponse(n, dim) {
  // 用不同文本的确定性向量填充，模拟服务端返回
  const data = Array.from({ length: n }, (_, i) => ({
    index: i,
    embedding: Array.from(textToVector(`resp-${i}`, dim)),
  }));
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => '',
  };
}

// ─────────────────────────────────────────────
// mock 的不变量
// ─────────────────────────────────────────────

describe('确定性 mock embedding', () => {
  test('同一文本 → 完全相同的向量', async () => {
    const p = mockEmbedding(64);
    const [a] = await p.embed(['睡不着']);
    const [b] = await p.embed(['睡不着']);
    assert.deepEqual([...a], [...b]);
  });

  test('不同文本 → 明显不同的向量（相似度远低于 1）', async () => {
    const p = mockEmbedding(256);
    const [a, b] = await p.embed(['睡不着，我怕黑', '今天天气不错，适合出门']);
    assert.ok(dot(a, b) < 0.5, `不相关文本的余弦应远低于 1，实际 ${dot(a, b)}`);
  });

  test('向量已归一化（模长 1）', async () => {
    const p = mockEmbedding(128);
    const vecs = await p.embed(['a', 'b', 'c']);
    for (const v of vecs) {
      assert.ok(Math.abs(dot(v, v) - 1) < 1e-5, '模长应为 1');
    }
  });

  test('mock 的 id 带 mock 前缀，不会被误存成生产向量', () => {
    const p = mockEmbedding(1024);
    assert.match(p.id, /^mock:/);
    assert.equal(p.dim, 1024);
  });

  test('批量顺序与输入严格一致', async () => {
    const p = mockEmbedding(32);
    const inputs = ['甲', '乙', '丙'];
    const out = await p.embed(inputs);
    for (let i = 0; i < inputs.length; i++) {
      assert.deepEqual([...out[i]], [...textToVector(inputs[i], 32)]);
    }
  });

  test('空输入 → 空数组，不报错', async () => {
    assert.deepEqual(await mockEmbedding(8).embed([]), []);
  });

  test('记录调用，能断言分批行为', async () => {
    const p = mockEmbedding(8);
    await p.embed(['x']);
    await p.embed(['y', 'z']);
    assert.equal(p.calls.length, 2);
    assert.deepEqual(p.calls[1].texts, ['y', 'z']);
  });
});

describe('确定性 mock llm', () => {
  test('按顺序返回预设输出', async () => {
    const llm = mockLlm(['第一段', '第二段']);
    assert.equal(await llm.complete([{ role: 'user', content: 'a' }]), '第一段');
    assert.equal(await llm.complete([{ role: 'user', content: 'b' }]), '第二段');
  });

  test('预设用完 → 抛错（提醒测试写漏了）', async () => {
    const llm = mockLlm(['只有一条']);
    await llm.complete([{ role: 'user', content: 'a' }]);
    await assert.rejects(() => llm.complete([{ role: 'user', content: 'b' }]), /已用尽/);
  });

  test('可传函数做动态响应', async () => {
    const llm = mockLlm((messages) => `收到 ${messages.length} 条`);
    assert.equal(await llm.complete([{ role: 'user', content: 'a' }]), '收到 1 条');
  });

  test('fallback 模式：用完后回落到固定输出', async () => {
    const llm = mockLlm({ responses: ['一'], fallback: '{"facts":[]}' });
    await llm.complete([{ role: 'user', content: 'a' }]);
    assert.equal(await llm.complete([{ role: 'user', content: 'b' }]), '{"facts":[]}');
  });

  test('记录每次调用（prompt 可被断言）', async () => {
    const llm = mockLlm(['ok']);
    await llm.complete([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].messages[1].content, 'U');
  });
});

// ─────────────────────────────────────────────
// 硅基流动 embedding provider
// ─────────────────────────────────────────────

describe('硅基流动 embedding provider', () => {
  test('id 格式：sf:模型名@维度', () => {
    const p = createSiliconFlowEmbedding({ model: 'Qwen/Qwen3-Embedding-4B', dim: 1024 });
    assert.equal(p.id, 'sf:Qwen/Qwen3-Embedding-4B@1024');
    assert.equal(p.dim, 1024);
    // 2026-11-18：批量从 32 降到 16（本地模型长文本会撑爆超时）
  assert.equal(p.maxBatch, 16);
  });

  test('缺少 API Key → 明确报错，且错误信息里只有变量名没有值', async () => {
    const saved = process.env.SILICONFLOW_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    const p = createSiliconFlowEmbedding({ fetchImpl: async () => fakeEmbedResponse(1, 1024) });
    try {
      // 2026-11-18 起：不再只说「环境变量没配」，而是给出可操作的两条路
    await assert.rejects(() => p.embed(['x']), /API Key/);
      await assert.rejects(() => p.embed(['x']), (err) => {
        assert.ok(!err.message.includes('sk-'), '错误信息里不能出现 Key 的任何片段');
        return true;
      });
    } finally {
      if (saved !== undefined) process.env.SILICONFLOW_API_KEY = saved;
    }
  });

  test('原生维度 > 目标维度 → 截断并重新归一化', async () => {
    process.env.SILICONFLOW_API_KEY = 'test-key-not-used';
    let receivedBody;
    const p = createSiliconFlowEmbedding({
      dim: 8,
      fetchImpl: async (url, init) => {
        receivedBody = JSON.parse(init.body);
        return fakeEmbedResponse(1, 16); // 服务端给 16 维
      },
    });

    const [v] = await p.embed(['测试']);
    assert.equal(v.length, 8, '必须截断到目标维度');
    assert.equal(v.constructor, Float32Array);

    // 截断后必须重新归一化
    assert.ok(Math.abs(dot(v, v) - 1) < 1e-5, '截断后应重新归一化到模长 1');

    // 不传 dimensions（未实测的参数不猜）
    assert.equal(receivedBody.dimensions, undefined);
    assert.equal(receivedBody.model, 'Qwen/Qwen3-Embedding-4B');
  });

  test('服务端维度不足 → 报错，不静默补齐', async () => {
    process.env.SILICONFLOW_API_KEY = 'test-key-not-used';
    const p = createSiliconFlowEmbedding({
      dim: 32,
      fetchImpl: async () => fakeEmbedResponse(1, 16),
    });
    await assert.rejects(() => p.embed(['x']), /维度不足/);
  });

  test('超过 maxBatch → 自动分批，顺序不乱', async () => {
    process.env.SILICONFLOW_API_KEY = 'test-key-not-used';
    const batches = [];
    const p = createSiliconFlowEmbedding({
      dim: 4,
      maxBatch: 2,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        batches.push(body.input);
        return fakeEmbedResponse(body.input.length, 4);
      },
    });

    const texts = ['a', 'b', 'c', 'd', 'e'];
    const out = await p.embed(texts);
    assert.equal(out.length, 5);
    assert.deepEqual(batches, [['a', 'b'], ['c', 'd'], ['e']]);
    // 顺序对齐：第 i 个输出应对应第 i 个输入
    assert.deepEqual([...out[0]], [...textToVector('resp-0', 4)]);
    assert.deepEqual([...out[2]], [...textToVector('resp-0', 4)]);
  });

  test('返回条数不匹配 → 报错（防止向量张冠李戴）', async () => {
    process.env.SILICONFLOW_API_KEY = 'test-key-not-used';
    const p = createSiliconFlowEmbedding({
      dim: 4,
      retryDelayMs: 0,
      fetchImpl: async () => fakeEmbedResponse(3, 4), // 请求 1 条返回 3 条
    });
    await assert.rejects(() => p.embed(['x']), /条数不匹配/);
  });

  test('服务端乱序返回 → 按 index 重排', async () => {
    process.env.SILICONFLOW_API_KEY = 'test-key-not-used';
    const p = createSiliconFlowEmbedding({
      dim: 4,
      retryDelayMs: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 1, embedding: Array.from(textToVector('B', 4)) },
            { index: 0, embedding: Array.from(textToVector('A', 4)) },
          ],
        }),
        text: async () => '',
      }),
    });
    const out = await p.embed(['a-text', 'b-text']);
    // 注意：服务端返回的向量内容就是它给的，provider 只负责按 index 排序。
    // 截断+重归一化会带来 Float32 级的舍入误差，所以用近似比较。
    assertNear(out[0], textToVector('A', 4));
    assertNear(out[1], textToVector('B', 4));
  });

  test('5xx 失败后重试并成功', async () => {
    process.env.SILICONFLOW_API_KEY = 'test-key-not-used';
    let calls = 0;
    const p = createSiliconFlowEmbedding({
      dim: 4,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          return { ok: false, status: 500, text: async () => 'server error', json: async () => ({}) };
        }
        return fakeEmbedResponse(1, 4);
      },
    });
    const [v] = await p.embed(['x']);
    assert.equal(calls, 2, '应该重试一次');
    assert.equal(v.length, 4);
  });

  test('全部重试失败 → 抛最后一次错误', async () => {
    process.env.SILICONFLOW_API_KEY = 'test-key-not-used';
    let calls = 0;
    const p = createSiliconFlowEmbedding({
      dim: 4,
      retries: 1,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls++;
        return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) };
      },
    });
    await assert.rejects(() => p.embed(['x']), /HTTP 503/);
    assert.equal(calls, 2, '初次 + 1 次重试');
  });

  test('维度不一致必须拒绝查询（D-152）', () => {
    const p = createSiliconFlowEmbedding({});
    assert.deepEqual(assertSameModel(p.id, p), { ok: true });
    const bad = assertSameModel('sf:BAAI/bge-m3@1024', p);
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /不一致/);
    assert.match(bad.reason, /重建/);
    assert.equal(assertSameModel(null, p).ok, false);
  });
});

// ─────────────────────────────────────────────
// DeepSeek llm provider
// ─────────────────────────────────────────────

describe('DeepSeek llm provider', () => {
  const okBody = (content) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
    text: async () => '',
  });

  test('正常返回 content 字符串', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-used';
    const llm = createDeepSeekLlm({ fetchImpl: async () => okBody('{"facts":[]}') });
    assert.equal(await llm.complete([{ role: 'user', content: 'x' }]), '{"facts":[]}');
    assert.match(llm.id, /^deepseek:/);
  });

  test('缺少 Key → 报错，错误信息不含 Key 片段', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const llm = createDeepSeekLlm({ fetchImpl: async () => okBody('x') });
    try {
      await assert.rejects(() => llm.complete([{ role: 'user', content: 'x' }]), /DEEPSEEK_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    }
  });

  test('responseFormat=json 会带上 response_format', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-used';
    let body;
    const llm = createDeepSeekLlm({
      fetchImpl: async (url, init) => {
        body = JSON.parse(init.body);
        return okBody('{}');
      },
    });
    await llm.complete([{ role: 'user', content: 'x' }], { responseFormat: 'json' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.temperature, 0);
  });

  test('429 会重试；4xx（非 429）不重试', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-used';

    let calls429 = 0;
    const llm429 = createDeepSeekLlm({
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls429++;
        if (calls429 === 1) return { ok: false, status: 429, text: async () => 'rate limit', json: async () => ({}) };
        return okBody('ok');
      },
    });
    assert.equal(await llm429.complete([{ role: 'user', content: 'x' }]), 'ok');
    assert.equal(calls429, 2);

    let calls400 = 0;
    const llm400 = createDeepSeekLlm({
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls400++;
        return { ok: false, status: 400, text: async () => 'bad request', json: async () => ({}) };
      },
    });
    await assert.rejects(() => llm400.complete([{ role: 'user', content: 'x' }]), /HTTP 400/);
    assert.equal(calls400, 1, '400 说明请求本身有问题，重试没意义');
  });

  test('响应缺 content → 报错', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-used';
    const llm = createDeepSeekLlm({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }), text: async () => '' }),
    });
    await assert.rejects(() => llm.complete([{ role: 'user', content: 'x' }]), /content/);
  });
});

describe('parseJsonLoose', () => {
  test('直接 JSON', () => {
    assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  });

  test('```json 围栏', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  });

  test('前后冗余文本（中文）', () => {
    assert.deepEqual(parseJsonLoose('好的，结果是：{"facts":[]} 以上。'), { facts: [] });
  });

  test('数组', () => {
    assert.deepEqual(parseJsonLoose('结果：[{"kind":"vuln"}]'), [{ kind: 'vuln' }]);
  });

  test('字符串里含括号不误判', () => {
    const s = '{"note":"他说「」和{}混在一起","v":1}';
    assert.deepEqual(parseJsonLoose(s), { note: '他说「」和{}混在一起', v: 1 });
  });

  test('真不是 JSON → 抛错', () => {
    assert.throws(() => parseJsonLoose('这是一段话，里面没有 JSON。'), /不是合法 JSON/);
  });
});
