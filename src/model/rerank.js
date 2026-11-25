// @ts-check
/**
 * Rerank 精排模型接入 —— OpenAI / SiliconFlow / Jina / vLLM 兼容 `/rerank` 接口。
 *
 * 用于对多路混合召回（关键词 + 向量 + RRF）的候选结果做二次语义精排。
 * 失败或超时时由上层捕获并降级回 RRF 原序，绝不阻塞检索。
 */

const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_TIMEOUT_MS = 8000;

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 解析兼容 `/rerank` 返回格式：
 * - SiliconFlow / Jina / Cohere: `{ results: [{ index, relevance_score }] }`
 * - 部分代理: `{ data: [{ index, score }] }`
 */
export function parseRerankResponse(body, docCount) {
  const list = Array.isArray(body?.results)
    ? body.results
    : Array.isArray(body?.data)
      ? body.data
      : null;
  if (!list) {
    throw new Error('rerank 响应缺少 results 数组');
  }
  const seen = new Set();
  const ranked = [];
  for (const item of list) {
    const idx = Number(item?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= docCount || seen.has(idx)) continue;
    seen.add(idx);
    const rawScore = item?.relevance_score ?? item?.score ?? 0;
    const score = Number.isFinite(Number(rawScore)) ? Number(rawScore) : 0;
    ranked.push({ index: idx, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * @param {{
 *   model?: string,
 *   baseURL?: string,
 *   baseUrl?: string,
 *   mode?: string,
 *   apiKey?: string,
 *   apiKeyEnv?: string,
 *   local?: boolean,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} [opts]
 */
export function createReranker(opts = {}) {
  const model = String(opts.model ?? '').trim();
  if (!model) throw new Error('rerank.model 不能为空');

  const local = opts.local === true || opts.mode === 'local';
  const baseURL = trimSlash(opts.baseURL || opts.baseUrl || DEFAULT_BASE_URL);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前环境缺少 fetch');

  const resolvedKey = typeof opts.apiKey === 'string' && opts.apiKey.trim()
    ? opts.apiKey.trim()
    : (opts.apiKeyEnv && process.env[opts.apiKeyEnv] ? String(process.env[opts.apiKeyEnv]).trim() : '');

  if (!local && !resolvedKey) {
    throw new Error('远程 rerank 缺少 API Key');
  }

  const endpoint = baseURL.endsWith('/rerank') ? baseURL : `${baseURL}/rerank`;

  async function rerankOnce(q, docs, topN, outerSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`rerank 超时（>${timeoutMs} ms）`)), timeoutMs);
    const onAbort = () => controller.abort(outerSignal?.reason);
    if (outerSignal) {
      if (outerSignal.aborted) {
        clearTimeout(timer);
        throw outerSignal.reason instanceof Error ? outerSignal.reason : new Error('rerank 已取消');
      }
      outerSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (resolvedKey) headers.Authorization = `Bearer ${resolvedKey}`;

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          query: q,
          documents: docs,
          top_n: topN,
          return_documents: false,
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 200);
        try {
          const parsed = JSON.parse(text);
          detail = parsed?.error?.message || parsed?.message || detail;
        } catch { /* ignore */ }
        const err = /** @type {Error & { status?: number }} */ (new Error(`HTTP ${res.status}: ${detail}`));
        err.status = res.status;
        throw err;
      }

      const json = JSON.parse(text);
      return parseRerankResponse(json, docs.length);
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
    }
  }

  async function rerank(query, documents, callOpts = {}) {
    const q = String(query ?? '').trim();
    const docs = Array.isArray(documents) ? documents.map((d) => String(d ?? '')) : [];
    if (!q || docs.length === 0) return [];

    const topN = Number.isInteger(callOpts.topN) && callOpts.topN > 0
      ? Math.min(callOpts.topN, docs.length)
      : docs.length;

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        if (callOpts.signal?.aborted) break;
        await new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
          const sig = callOpts.signal;
          const t = setTimeout(() => {
            if (sig) sig.removeEventListener('abort', onAbortSleep);
            resolve();
          }, 1200 * attempt);
          const onAbortSleep = () => {
            clearTimeout(t);
            reject(sig?.reason instanceof Error ? sig.reason : new Error('rerank 已取消'));
          };
          if (sig) sig.addEventListener('abort', onAbortSleep, { once: true });
        });
      }
      try {
        return await rerankOnce(q, docs, topN, callOpts.signal);
      } catch (e) {
        lastErr = e;
        const retryable = e?.status === 429 || (e?.status >= 500 && e?.status < 600) || /超时|rate limiting|TPM/i.test(String(e?.message));
        if (!retryable || callOpts.signal?.aborted) throw e;
      }
    }
    throw lastErr;
  }

  return { model, baseURL, local, rerank };
}
