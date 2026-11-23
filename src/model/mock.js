/**
 * 确定性 mock 提供方 —— 供他人测试与本地开发使用
 *
 * 为什么需要它：硅基流动账户余额不足，真实 embedding 调不通；
 * DeepSeek 的 Key 虽然有，但派生层的测试不该烧钱。
 * 所以 fact / gist / beat 三条线全部用这里的 mock 开发与验收（BUILD-PLAN.md §3.3）。
 *
 * 两条不变量：
 * ① 同文本 → 同向量（确定性）。跨进程、跨次数都一样，测试才能断言。
 * ② 不同文本 → 不同向量（近似正交）。相同文本的向量必须余弦相似度 1，
 *    不同文本的相似度应当明显更低，这样向量检索的行为在 mock 下也有意义。
 */

/**
 * 确定性 embedding：对文本做 FNV-1a 哈希，再用 LCG 铺开成分量，
 * 最后 L2 归一化（归一化后余弦相似度 = 点积，省得调用方再算模长）。
 *
 * @param {number} [dim=1024]
 * @param {object} [opts]
 * @param {number} [opts.latencyMs] 模拟网络延迟，默认 0
 * @param {number} [opts.maxBatch]  默认 32
 * @returns {{id: string, dim: number, maxBatch: number, embed: Function, calls: object[]}}
 */
export function mockEmbedding(dim = 1024, opts = {}) {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError(`dim 必须是正整数，收到 ${dim}`);
  }
  const latencyMs = opts.latencyMs ?? 0;
  const maxBatch = opts.maxBatch ?? 32;

  /** 记录每次调用，测试可断言分批行为 */
  const calls = [];

  async function embed(texts, signal) {
    if (!Array.isArray(texts)) throw new TypeError('embed 的入参必须是字符串数组');
    if (texts.length === 0) return [];
    for (const t of texts) {
      if (typeof t !== 'string') throw new TypeError('embed 的每个元素必须是字符串');
    }

    calls.push({ texts: texts.slice() });

    if (latencyMs > 0) await sleep(latencyMs, signal);

    return texts.map((t) => textToVector(t, dim));
  }

  return {
    // id 带 mock 前缀，方便上层区分「这是假向量」，也避免误存进生产库
    id: `mock:deterministic@${dim}`,
    dim,
    maxBatch,
    embed,
    calls,
  };
}

/**
 * 文本 → 归一化向量。同文本恒定，异文本近似正交。
 * @param {string} text
 * @param {number} dim
 * @returns {Float32Array}
 */
export function textToVector(text, dim = 1024) {
  const vec = new Float32Array(dim);

  // 用文本的哈希做种子；再掺入两个不同盐，让分量分布更散
  let seed = fnv1a(text);
  let state = seed >>> 0;

  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    // LCG：数值稳定、跨平台一致，不依赖 Math.random
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // 映射到 [-1, 1)
    const v = (state / 0x100000000) * 2 - 1;
    vec[i] = v;
    sumSq += v * v;
  }

  // L2 归一化；极端情况下（全零）退化为固定向量
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  } else {
    vec[0] = 1;
  }
  return vec;
}

/** FNV-1a 32 位哈希，输入按 UTF-16 码元走（中文同样稳定） */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 确定性对话模型。
 *
 * 三种用法：
 *   mockLlm(['第一段输出', '第二段输出'])          // 按顺序返回
 *   mockLlm((messages, opts) => '……')             // 自定义函数
 *   mockLlm({ responses: [...], fallback: '{}' }) // 用完后回落到 fallback
 *
 * @param {string[]|Function|{responses?: string[], fallback?: string, latencyMs?: number, id?: string}} spec
 * @returns {{id: string, complete: Function, calls: object[]}}
 */
export function mockLlm(spec) {
  let responder;
  let latencyMs = 0;
  let id = 'mock:llm';

  if (Array.isArray(spec)) {
    const queue = spec.slice();
    responder = () => {
      if (queue.length === 0) {
        throw new Error(
          `mockLlm 预设输出已用尽（共 ${spec.length} 条），请补充 responses 或改传函数`,
        );
      }
      return queue.shift();
    };
  } else if (typeof spec === 'function') {
    responder = spec;
  } else if (spec && typeof spec === 'object') {
    const queue = Array.isArray(spec.responses) ? spec.responses.slice() : [];
    const fallback = spec.fallback;
    latencyMs = spec.latencyMs ?? 0;
    if (spec.id) id = spec.id;
    responder = () => {
      if (queue.length > 0) return queue.shift();
      if (fallback !== undefined) return fallback;
      throw new Error('mockLlm 预设输出已用尽，且没有提供 fallback');
    };
  } else {
    throw new TypeError('mockLlm 需要字符串数组、函数或 {responses, fallback}');
  }

  /** 记录每次调用，测试可断言 prompt 内容与调用次数 */
  const calls = [];

  async function complete(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError('complete 需要非空的 messages 数组');
    }
    calls.push({ messages: structuredCloneish(messages), opts: { ...opts } });
    if (latencyMs > 0) await sleep(latencyMs, opts.signal);
    const out = await responder(messages, opts);
    if (typeof out !== 'string') {
      throw new TypeError(`mockLlm 的输出必须是字符串，收到 ${typeof out}`);
    }
    return out;
  }

  return { id, complete, calls };
}

/**
 * mock 版的 embedding 拼接：按块返回固定向量。
 * 用于「上层要自己拼文本再 embedding」的场景（比如 gist 的检索锚点）。
 */
export function mockEmbeddingOf(texts, dim = 1024) {
  return texts.map((t) => textToVector(t, dim));
}

/** 简易深拷贝（messages 只有 role/content 字符串，够用） */
function structuredCloneish(messages) {
  return messages.map((m) => ({ ...m }));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
        },
        { once: true },
      );
    }
  });
}
