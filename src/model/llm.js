// @ts-check
/**
 * 对话模型提供方 —— DeepSeek
 *
 * 接口契约见 BUILD-PLAN.md §3.3：
 *   { complete(messages, opts) => Promise<string> }
 *
 * 设计要点：
 * ① 只返回字符串。fact / gist / beat 三层都自己解析，不让 provider 猜结构。
 *    要结构化输出时，用 opts.responseFormat = 'json' 走 JSON mode，
 *    但解析失败的责任在调用方（prompt 设计 + 校验兜底）。
 * ② 与 embedding 完全独立：这三层派生逻辑在 embedding 定下来之前就能开发。
 * ③ Key 只从环境变量读，绝不落盘、不进日志、不进错误信息。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;
/** 重试退避基准（毫秒）。第 n 次重试等 base * 2^(n-1)。测试里传 0 */
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * 不可重试的错误：配置问题（缺 Key）。重试只会把 1 秒的失败拖成 3 秒。
 */
class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.permanent = true;
  }
}

/**
 * 构造 LlmProvider。
 *
 * @param {object} [opts]
 * @param {string} [opts.model]      默认 deepseek-chat
 * @param {string} [opts.apiKey]     直接传入的 Key（优先于环境变量）
 * @param {string} [opts.apiKeyEnv]  Key 所在的环境变量名，默认 DEEPSEEK_API_KEY
 * @param {string} [opts.baseURL]
 * @param {string} [opts.baseUrl]    baseURL 别名
 * @param {boolean} [opts.local]     true = 本机服务（Ollama / LM Studio / vLLM 等，无 Key 时允许省略 Authorization）
 * @param {'local'|'remote'} [opts.mode]
 * @param {number} [opts.temperature] 默认 0 —— 派生层要的是稳定复现，不是文采
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @param {number} [opts.retryDelayMs] 重试退避基准（毫秒），测试里传 0
 * @param {typeof fetch} [opts.fetchImpl] 注入用
 * @returns {{id: string, complete: Function}}
 */
export function createDeepSeekLlm(opts = {}) {
  const model = opts.model ?? DEFAULT_MODEL;
  const local = opts.local === true || opts.mode === 'local';
  const directApiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
  // 本地模式绝不默认读远程 DEEPSEEK_API_KEY 环境变量，避免把远程 Key 发给本地服务
  const apiKeyEnv = opts.apiKeyEnv === undefined
    ? (local ? '' : 'DEEPSEEK_API_KEY')
    : opts.apiKeyEnv;
  const baseURL = (opts.baseURL ?? opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const id = local ? `local:${model}` : `deepseek:${model}`;

  function readApiKey() {
    if (directApiKey) return directApiKey;
    const key = apiKeyEnv ? process.env[apiKeyEnv] : '';
    if (key) return key;
    if (local) return '';
    throw new PermanentError(
      `缺少对话模型的 API Key：环境变量 ${apiKeyEnv || 'DEEPSEEK_API_KEY'} 未设置。` +
        `fact / gist / beat 三层将不可用（已入库的原文不受影响）。`,
    );
  }

  /**
   * 发一次请求，返回纯文本。
   *
   * @param {{role: string, content: string}[]} messages
   * @param {object} [o]
   * @param {number} [o.temperature]
   * @param {number} [o.maxTokens]
   * @param {'text'|'json'} [o.responseFormat]
   * @param {AbortSignal} [o.signal]
   * @param {boolean} [o.noRetry] 内部用：JSON 解析失败后的重试不再走网络重试
   * @returns {Promise<string>}
   */
  async function complete(messages, o = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError('complete 需要非空的 messages 数组');
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1), o.signal);
      try {
        return await completeOnce(messages, o);
      } catch (err) {
        lastErr = err;
        if (err?.name === 'AbortError' || o.signal?.aborted) throw err;
        // 配置类错误不重试
        if (err?.permanent) throw err;
        // 4xx（除 429）是请求本身有问题，重试没意义
        if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
          throw err;
        }
      }
    }
    throw lastErr;
  }

  async function completeOnce(messages, o) {
    const apiKey = readApiKey();

    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error('对话模型请求超时')),
      o.timeoutMs ?? timeoutMs,
    );
    const onAbort = () => ctrl.abort(o.signal?.reason);
    if (o.signal) {
      if (o.signal.aborted) {
        clearTimeout(timer);
        throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      }
      o.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      /** @type {Record<string, unknown>} */
      const body = {
        model,
        messages,
        temperature: o.temperature ?? temperature,
        stream: false,
      };
      if (o.maxTokens ?? maxTokens) body.max_tokens = o.maxTokens ?? maxTokens;
      if (o.responseFormat === 'json') body.response_format = { type: 'json_object' };

      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const res = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await safeText(res);
        const err = /** @type {Error & { statusCode?: number }} */ (new Error(`对话模型请求失败 HTTP ${res.status}：${text.slice(0, 200)}`));
        err.statusCode = res.status;
        throw err;
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        // 响应对不上约定格式，重试大概率还是同样的形状（模型/服务端版本问题），
        // 归为不可重试，避免把 1 秒的失败拖成 3 秒
        throw new PermanentError('对话模型响应缺少 choices[0].message.content');
      }
      return content;
    } finally {
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
    }
  }

  return { id, complete };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<无法读取响应体>';
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 从模型输出里抠出 JSON。
 * 模型常带 ```json 围栏或前后冗余文本，这里做一次宽容提取。
 *
 * @param {string} text
 * @returns {any}
 * @throws {Error} 抠不出来时抛，调用方应把这一条当作「提取失败」丢弃
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') throw new Error('parseJsonLoose 需要字符串');
  const trimmed = text.trim();

  // 先试直接解析
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试 */
  }

  // 去掉 markdown 围栏
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续尝试 */
    }
  }

  // 退而求其次：截取第一个 { ... } 或 [ ... ]（括号配对，跳过字符串内的括号）
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const candidate = sliceBalanced(trimmed, start);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* 放弃 */
      }
    }
  }

  throw new Error(`模型输出不是合法 JSON：${trimmed.slice(0, 120)}`);
}

/** 从 start 处的括号起，配平到对应的收括号（跳过字符串字面量里的括号） */
function sliceBalanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
