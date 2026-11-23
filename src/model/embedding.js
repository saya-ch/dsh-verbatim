/**
 * 向量提供方 —— 硅基流动（SiliconFlow）
 *
 * 接口契约见 BUILD-PLAN.md §3.3：
 *   { id, dim, maxBatch, embed(texts, signal) }
 *
 * 三条硬规则：
 * ① 索引与查询必须用同一个模型（D-152）。id 里带上模型名与截断后的维度，
 *    上层把 id 存进 msg.vec_model，查询前比对；不一致就拒绝查询。
 * ② Key 只从环境变量读，绝不落盘、不进日志、不进错误信息（D-003）。
 * ③ 无状态、可并发调用。批内顺序必须与输入严格对齐，否则向量会张冠李戴。
 */

/** 硅基流动 OpenAI 兼容接口地址 */
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';

/** 单次最多几条（MODEL-PLAN.md §9 默认值） */
const DEFAULT_MAX_BATCH = 16;

/** 失败重试次数（退避：1s、2s） */
const DEFAULT_RETRIES = 2;

/** 重试退避基准（毫秒）。第 n 次重试等 base * 2^(n-1) */
const DEFAULT_RETRY_DELAY_MS = 1000;

/** 单次请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 单条文本最多嵌这么多字（超长截断：真实库最长 7301 字，全文嵌入只会超时） */
const MAX_TEXT_CHARS = 2000;

/**
 * 不可重试的错误：配置问题（缺 Key / 维度不匹配 / 返回脏向量）。
 * 重试一万次也一样错，只会把 1 秒的失败拖成 3 秒，还会在日志里刷屏。
 */
class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    /** 供重试循环判断 */
    this.permanent = true;
  }
}

/** 构造 EmbeddingProvider。
 *
 * @param {object} [opts]
 * @param {string} [opts.model]     模型名，默认 Qwen/Qwen3-Embedding-4B
 * @param {number} [opts.dim]       截断后的维度，默认 1024（D-144）
 * @param {string} [opts.apiKey]    直接给 Key（作者 2026-11-18：不再绕环境变量）
 * @param {string} [opts.apiKeyEnv] 兼容旧配置：Key 所在的环境变量名
 * @param {string} [opts.baseURL]   接口地址（本地服务填 http://127.0.0.1:11434/v1 之类）
 * @param {string} [opts.baseUrl]   baseURL 的小写别名（与 config.json 字段名一致）
 * @param {'local'|'remote'} [opts.mode] 服务模式，'local' 等价于 local: true
 * @param {boolean} [opts.local]    本地服务通常不校验 Key，可以留空
 * @param {number} [opts.maxBatch]  单次最多几条
 * @param {number} [opts.retries]   失败重试次数
 * @param {number} [opts.retryDelayMs] 重试退避基准（毫秒），测试里传 0
 * @param {number} [opts.timeoutMs] 单次请求超时
 * @param {typeof fetch} [opts.fetchImpl] 注入用（测试可替换，生产用全局 fetch）
 * @returns {{id: string, dim: number, maxBatch: number, embed: Function}}
 */
export function createSiliconFlowEmbedding(opts = {}) {
  const model = (typeof opts.model === 'string' && opts.model.trim())
    ? opts.model.trim()
    : 'Qwen/Qwen3-Embedding-4B';
  const dim = Number(opts.dim ?? 1024);
  // 没显式给 apiKeyEnv 时保持老行为（读 SILICONFLOW_API_KEY）；给空字符串表示明确不读环境变量
  const apiKeyEnv = opts.apiKeyEnv === undefined ? 'SILICONFLOW_API_KEY' : opts.apiKeyEnv;
  const rawBase = opts.baseURL ?? opts.baseUrl;
  const baseURL = (typeof rawBase === 'string' && rawBase.trim() ? rawBase.trim() : DEFAULT_BASE_URL)
    .replace(/\/+$/, '');
  const maxBatch = Number(opts.maxBatch ?? DEFAULT_MAX_BATCH);
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const local = opts.local === true || opts.mode === 'local';

  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError(`dim 必须是正整数，收到 ${dim}`);
  }
  if (!Number.isInteger(maxBatch) || maxBatch <= 0) {
    throw new TypeError(`maxBatch 必须是正整数，收到 ${maxBatch}`);
  }

  /**
   * 模型名归一化（2026-11-18，A1 审计发现的阻塞 bug）。
   *
   * Ollama 里 `qwen3-embedding-0.6b` 和 `qwen3-embedding-0.6b:latest` **是同一个模型**，
   * 但之前 id 直接拼原始字符串 → 库里存 `sf:qwen3-embedding-0.6b@1024`、
   * 配置写 `:latest` 之后算出 `sf:qwen3-embedding-0.6b:latest@1024` → `assert` 抛
   * 「向量模型不一致」→ **语义检索整个不可用，而面板还显示「状态 正常」**。
   *
   * 实测：两者算出的向量 score = 1.000000，本来就是同一个东西。
   * 所以同一模型的别名必须归一，不能靠用户手打一致。
   */
  function normalizeModelName(name) {
    return String(name ?? '')
      .trim()
      .replace(/:latest$/i, '')     // Ollama 默认 tag
      .replace(/\/+$/, '');         // 尾部斜杠
  }

  /** id 形如 sf:Qwen/Qwen3-Embedding-4B@1024 —— **归一化后**的模型名 + 实际维度 */
  const id = `sf:${normalizeModelName(model)}@${dim}`;

  /**
   * 取 Key。**三个来源按优先级**（作者 2026-11-18：直接填就行，不要逼人设环境变量）：
   *   ① opts.apiKey       —— 设置页直接填的（存在 config.json）
   *   ② process.env[apiKeyEnv] —— 兼容老配置
   *   ③ 都没有：本地服务放行（空 Bearer），远程服务抛错
   */
  function readApiKey() {
    if (typeof opts.apiKey === 'string' && opts.apiKey.trim()) return opts.apiKey.trim();
    if (apiKeyEnv && process.env[apiKeyEnv]) return process.env[apiKeyEnv];
    if (local) return '';
    throw new PermanentError(
      '缺少 embedding 的 API Key。'
      + '去「设置 → 逐字记忆」填一个，或者在配置里把服务类型改成「本地」。'
      + '（向量路不可用，其余检索路不受影响）',
    );
  }

  /**
   * 把单个批次的文本发出去，返回 Float32Array[]。
   * 失败时按指数退避重试；全部失败才抛。
   */
  async function embedBatch(texts, signal) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // 退避 base * 2^(n-1)；被 abort 就不要白等
        const wait = retryDelayMs * 2 ** (attempt - 1);
        await sleep(wait, signal);
      }
      try {
        return await embedBatchOnce(texts, signal);
      } catch (err) {
        lastErr = err;
        // 主动取消不重试
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        // 配置类错误不重试（缺 Key / 维度不符 / 脏向量）
        if (err?.permanent) throw err;
      }
    }
    throw lastErr;
  }

  /** 发一次请求。任何非 200 或结构异常都抛。 */
  async function embedBatchOnce(texts, signal) {
    const apiKey = readApiKey();

    // 自己控超时：fetch 的 signal 与调用方 signal 合并
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('embedding 请求超时')), timeoutMs);
    const onAbort = () => ctrl.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetchImpl(`${baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
          encoding_format: 'float',
          // 不传 dimensions：硅基流动对 dimensions 参数的支持未实测（MODEL-PLAN 🧪），
          // 传了可能被忽略也可能报错。统一取回原生维度，在本地做 MRL 截断 + 重归一化，
          // 行为可控、可测，且与"索引与查询同模型"的契约一致（D-144 / D-152）。
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        // 注意：错误信息里只放状态码和截断后的 body，不放 headers
        const body = await safeText(res);
        throw new Error(`embedding 请求失败 HTTP ${res.status}：${body.slice(0, 200)}`);
      }

      const json = await res.json();
      const data = json?.data;
      if (!Array.isArray(data)) {
        throw new Error('embedding 响应缺少 data 数组');
      }
      if (data.length !== texts.length) {
        throw new Error(
          `embedding 返回条数不匹配：请求 ${texts.length} 条，返回 ${data.length} 条`,
        );
      }

      // 按 index 排序再取，避免服务端乱序（OpenAI 兼容接口通常按 index 给出）
      const ordered = data
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => shrinkToDim(item.embedding, dim));

      return ordered;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 对外入口：自动按 maxBatch 分批，返回顺序与输入严格一致。
   *
   * **超长文本要截断**（2026-11-18 实测踩到）：真实库里最长的一条 7301 字，
   * 平均 337 字。32 条一批时总 token 量能撑爆 30 秒超时，整次重建直接失败。
   * 语义检索不需要全文——截断到前 2000 字足够表达「这说的是什么」。
   *
   * @param {string[]} texts
   * @param {AbortSignal} [signal]
   * @returns {Promise<Float32Array[]>}
   */
  async function embed(texts, signal) {
    if (!Array.isArray(texts)) throw new TypeError('embed 的入参必须是字符串数组');
    if (texts.length === 0) return [];
    for (const t of texts) {
      if (typeof t !== 'string') throw new TypeError('embed 的每个元素必须是字符串');
    }

    const clipped = texts.map((t) => (t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t));

    const out = new Array(clipped.length);
    for (let i = 0; i < clipped.length; i += maxBatch) {
      const slice = clipped.slice(i, i + maxBatch);
      const vecs = await embedBatch(slice, signal);
      for (let j = 0; j < vecs.length; j++) out[i + j] = vecs[j];
    }
    return out;
  }

  return { id, dim, maxBatch, embed };
}

/**
 * 把接口返回的向量截断到目标维度，并**重新做 L2 归一化**。
 *
 * 为什么必须重归一化：MRL（Matryoshka）模型的向量截断后模长会小于 1，
 * 不归一化的话余弦相似度虽然还能算，但点积不再等价于余弦，
 * 会让「同一模型的索引与查询」出现系统性偏移 —— 属于不报错的静默错误。
 *
 * @param {number[]} embedding 接口原样返回的向量（可能是 2560/4096 维）
 * @param {number} dim 目标维度
 * @returns {Float32Array}
 */
function shrinkToDim(embedding, dim) {
  if (!Array.isArray(embedding)) {
    throw new PermanentError('embedding 不是数组（不支持 base64 编码返回）');
  }
  if (embedding.length < dim) {
    throw new PermanentError(
      `embedding 维度不足：模型返回 ${embedding.length} 维，配置要求 ${dim} 维。` +
        `MRL 只能截断不能补齐。`,
    );
  }

  const arr = Float32Array.from(embedding.slice(0, dim));

  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw new PermanentError(`embedding 包含非法数值（第 ${i} 维: ${arr[i]}）`);
    }
    sumSq += arr[i] * arr[i];
  }
  const norm = Math.sqrt(sumSq);

  if (norm > 0) {
    for (let i = 0; i < arr.length; i++) arr[i] /= norm;
  } else {
    // 全零向量无法归一化。服务端不该返回这个；出现了就报错，别让脏向量入库。
    throw new PermanentError('embedding 返回了全零向量');
  }
  return arr;
}

/** 读取响应体文本，失败时返回占位符（不让错误处理本身再抛） */
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<无法读取响应体>';
  }
}

/** 可被 abort 的 sleep */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 校验库里的 vec_model 与当前 provider 是否一致（D-152）。
 * 不一致必须拒绝查询，而不是算出无意义的分数。
 *
 * @param {string|null} storedModel 库里存的 msg.vec_model
 * @param {{id: string}} provider
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function assertSameModel(storedModel, provider) {
  if (!storedModel) {
    return { ok: false, reason: '库里没有向量模型标记，需要先建索引' };
  }
  if (storedModel !== provider.id) {
    return {
      ok: false,
      reason:
        `向量模型不一致：库里是 ${storedModel}，当前是 ${provider.id}。` +
        `不同模型的向量空间不可比，必须全量重建索引后才能查询。`,
    };
  }
  return { ok: true };
}
