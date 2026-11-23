/**
 * 模型服务探测与连通性测试（本地服务发现 + 远程/本地 /models 拉取 + Embedding/LLM/Rerank 探活）。
 */

import { parseRerankResponse } from '../model/rerank.js';
import { createHostLlmAdapter, listHostLlmModels } from './dsh-llm.js';

export const LOCAL_CANDIDATES = Object.freeze([
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', hint: 'ollama serve' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', hint: '开发者模式里开启本地服务器' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', hint: 'vllm serve --task embed' },
  { id: 'llamacpp', name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', hint: 'llama-server --embedding' },
  { id: 'localai', name: 'LocalAI', baseUrl: 'http://127.0.0.1:8080/v1', hint: 'local-ai run' },
]);

async function probeOne(cand, timeoutMs = 1500) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const url = `${cand.baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) {
      return { ...cand, alive: false, error: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const models = list
      .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? m?.model))
      .filter((s) => typeof s === 'string' && s);
    const isRerankRe = /rerank|bge-reranker/i;
    const isEmbedRe = /embed|bge-m3|bge-large|bge-small|e5|gte|nomic|jina|mxbai/i;
    return {
      ...cand,
      alive: true,
      models,
      embeddingModels: models.filter((m) => isEmbedRe.test(m) && !isRerankRe.test(m)),
      rerankModels: models.filter((m) => isRerankRe.test(m)),
      chatModels: models.filter((m) => !isEmbedRe.test(m) && !isRerankRe.test(m)),
    };
  } catch (e) {
    const name = e?.name ?? '';
    return {
      ...cand,
      alive: false,
      error: name === 'AbortError' ? '超时' : (e?.message ?? '连不上'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createModelProber({ embCfg, llmCfg, rerankCfg, getHostLlm }) {
  function resolveSpec(spec) {
    const kind = spec.kind === 'rerank' ? 'rerank' : 'embedding';
    const baseCfg = kind === 'rerank' ? rerankCfg() : embCfg();
    const mode = spec.mode === 'local' ? 'local' : (spec.mode === 'remote' ? 'remote' : baseCfg.mode);
    const baseUrl = String(spec.baseUrl ?? baseCfg.baseUrl ?? '').trim().replace(/\/+$/, '');
    const model = String(spec.model ?? baseCfg.model ?? '').trim();
    const inputKey = typeof spec.apiKey === 'string' ? spec.apiKey.trim() : '';
    const savedKey = typeof baseCfg.apiKey === 'string' ? baseCfg.apiKey.trim() : '';
    const envKey = baseCfg.apiKeyEnv && process.env[baseCfg.apiKeyEnv] ? String(process.env[baseCfg.apiKeyEnv]).trim() : '';
    const apiKey = inputKey || savedKey || envKey;
    return { kind, baseCfg, mode, baseUrl, model, apiKey };
  }

  async function listModels(spec) {
    if (spec.kind === 'llm') {
      return listHostLlmModels(getHostLlm?.());
    }
    const { kind, baseCfg, mode, baseUrl, apiKey } = resolveSpec(spec);
    if (!baseUrl) return { ok: false, models: [], error: '请先填写接口地址（baseUrl）' };
    if (mode === 'remote' && !apiKey) {
      return { ok: false, models: [], error: '远程服务需要 API Key（请先填写或保存 Key）' };
    }

    const headers = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } }, 8_000);
    try {
      const fetchFn = baseCfg.fetchImpl ?? globalThis.fetch;
      const res = await fetchFn(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, models: [], error: `HTTP ${res.status}${text ? `：${text.slice(0, 140)}` : ''}` };
      }
      const body = await res.json().catch(() => null);
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      const all = list
        .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? m?.model))
        .filter((s) => typeof s === 'string' && s);
      const isEmbedRe = /embed|bge-m3|bge-large|bge-small|e5|gte|nomic|mxbai/i;
      const isRerankRe = /rerank|bge-reranker/i;
      const preferred = kind === 'embedding'
        ? all.filter((m) => isEmbedRe.test(m) && !isRerankRe.test(m))
        : kind === 'rerank'
          ? all.filter((m) => isRerankRe.test(m))
          : all.filter((m) => !isEmbedRe.test(m) && !isRerankRe.test(m));
      return { ok: true, models: preferred.length > 0 ? preferred : all, allModels: all };
    } catch (e) {
      return {
        ok: false,
        models: [],
        error: e?.name === 'AbortError' ? '拉取模型超时（>8s）' : (e?.message ?? '连不上服务'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function testModel(spec) {
    if (spec.kind === 'llm') {
      const hostLlm = getHostLlm?.();
      const base = llmCfg();
      const provider = String(spec.provider ?? base.provider ?? '').trim();
      const model = String(spec.model ?? base.model ?? '').trim();
      if (!hostLlm) return { ok: false, latencyMs: 0, error: '当前未连接到 DSH 模型服务（ctx.llm）' };
      if (!model) return { ok: false, latencyMs: 0, error: '请先从 DSH 模型列表中选择一个模型' };
      const started = Date.now();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } }, 10_000);
      try {
        const adapter = createHostLlmAdapter(hostLlm, { provider, model });
        await adapter.complete([{ role: 'user', content: 'ping' }], {
          maxTokens: 4,
          signal: controller ? controller.signal : undefined,
        });
        return { ok: true, latencyMs: Date.now() - started, provider, model };
      } catch (e) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: e?.name === 'AbortError' ? '连接超时（>10s）' : (e?.message ?? 'DSH 模型调用失败'),
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const { kind, baseCfg, mode, baseUrl, model, apiKey } = resolveSpec(spec);
    if (!baseUrl) return { ok: false, error: '请先填写接口地址（baseUrl）', latencyMs: 0 };
    if (!model) return { ok: false, error: '请先填写或选择模型名称', latencyMs: 0 };
    if (mode === 'remote' && !apiKey) {
      return { ok: false, error: '远程服务需要 API Key（请先填写或保存 Key）', latencyMs: 0 };
    }

    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const started = Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } }, 10_000);
    try {
      const fetchFn = baseCfg.fetchImpl ?? globalThis.fetch;
      if (kind === 'embedding') {
        const res = await fetchFn(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, input: 'ping' }),
          signal: controller ? controller.signal : undefined,
        });
        const latencyMs = Date.now() - started;
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, latencyMs, error: `HTTP ${res.status}${text ? `：${text.slice(0, 140)}` : ''}` };
        }
        const json = await res.json().catch(() => null);
        const vec = json?.data?.[0]?.embedding;
        if (!Array.isArray(vec) || vec.length === 0) {
          return { ok: false, latencyMs, error: '接口返回成功但缺少 data[0].embedding 向量数组' };
        }
        return { ok: true, latencyMs, model, nativeDim: vec.length };
      }

      if (kind === 'rerank') {
        const res = await fetchFn(`${baseUrl}/rerank`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            query: 'ping',
            documents: ['ping'],
            top_n: 1,
            return_documents: false,
          }),
          signal: controller ? controller.signal : undefined,
        });
        const latencyMs = Date.now() - started;
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, latencyMs, error: `HTTP ${res.status}${text ? `：${text.slice(0, 140)}` : ''}` };
        }
        const json = await res.json().catch(() => null);
        try {
          parseRerankResponse(json, 1);
        } catch (err) {
          return { ok: false, latencyMs, error: err?.message ?? 'rerank 响应格式异常' };
        }
        return { ok: true, latencyMs, model };
      }

      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
          stream: false,
        }),
        signal: controller ? controller.signal : undefined,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, latencyMs, error: `HTTP ${res.status}${text ? `：${text.slice(0, 140)}` : ''}` };
      }
      const json = await res.json().catch(() => null);
      const reply = json?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string') {
        return { ok: false, latencyMs, error: '接口返回成功但缺少 choices[0].message.content' };
      }
      return { ok: true, latencyMs, model };
    } catch (e) {
      const latencyMs = Date.now() - started;
      return {
        ok: false,
        latencyMs,
        error: e?.name === 'AbortError' ? '连接超时（>10s）' : (e?.message ?? '连不上服务'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function probeLocal(params = {}) {
    if (params && typeof params.listModels === 'object' && params.listModels !== null) {
      return listModels(params.listModels);
    }
    if (params && typeof params.test === 'object' && params.test !== null) {
      return testModel(params.test);
    }
    const results = await Promise.all(LOCAL_CANDIDATES.map((c) => probeOne(c)));
    const alive = results.filter((r) => r.alive);
    return {
      alive,
      all: results,
      summary: alive.length === 0
        ? `试了 ${results.length} 个常见本地服务，一个都没响应。`
          + '确认服务已经启动（Ollama 默认 11434、LM Studio 1234、vLLM 8000）。'
        : `找到 ${alive.length} 个本机服务：${alive.map((a) => `${a.name}（${a.models.length} 个模型）`).join('、')}`,
    };
  };
}
