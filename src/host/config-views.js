/**
 * 全局配置解析、脱敏与状态视图构造（供 Host 面板与设置页共用）。
 */

import {
  loadGlobalConfig,
  embeddingReady,
  llmReady,
  rerankReady,
  DEFAULT_GLOBAL_CONFIG,
} from '../config/global-config.js';

export function maskKey(key) {
  const s = typeof key === 'string' ? key.trim() : '';
  if (!s) return null;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 3)}••••${s.slice(-4)}`;
}

export function sanitizeGlobalConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  return {
    ...cfg,
    embedding: cfg.embedding ? { ...cfg.embedding, apiKey: '' } : cfg.embedding,
    rerank: cfg.rerank ? { ...cfg.rerank, apiKey: '' } : cfg.rerank,
  };
}

export function buildEmbeddingView(cfg) {
  const emb = embeddingReady(cfg);
  const raw = cfg?.embedding ?? {};
  const hasKey = Boolean(typeof raw.apiKey === 'string' && raw.apiKey.trim());
  const envName = raw.apiKeyEnv || null;
  return {
    ready: emb.ready,
    reason: emb.ready ? undefined : emb.reason,
    mode: emb.mode ?? (raw.mode === 'local' ? 'local' : 'remote'),
    baseUrl: emb.baseUrl ?? raw.baseUrl ?? null,
    model: emb.model ?? raw.model ?? null,
    dim: emb.dim ?? raw.dim ?? null,
    apiKeyEnv: envName,
    hasApiKey: hasKey,
    apiKeyMasked: maskKey(raw.apiKey),
    keySource: hasKey ? 'config' : (envName && process.env[envName] ? 'env' : 'none'),
    envName,
  };
}

function buildOptionalModelView(st, raw) {
  const hasKey = Boolean(typeof raw?.apiKey === 'string' && raw.apiKey.trim());
  const envName = raw?.apiKeyEnv || null;
  return {
    ready: st.ready,
    enabled: st.enabled,
    reason: st.ready ? undefined : st.reason,
    mode: st.mode,
    baseUrl: st.baseUrl || null,
    model: st.model || null,
    apiKeyEnv: envName,
    hasApiKey: hasKey,
    apiKeyMasked: maskKey(raw?.apiKey),
    keySource: hasKey ? 'config' : (envName && process.env[envName] ? 'env' : 'none'),
    envName,
  };
}

export function buildLlmView(cfg, hasHostLlm = true) {
  const st = llmReady(cfg, hasHostLlm);
  return {
    ready: st.ready,
    enabled: st.enabled,
    hasHostLlm: Boolean(hasHostLlm),
    reason: st.ready ? undefined : st.reason,
    provider: st.provider || null,
    model: st.model || null,
  };
}

export function buildRerankView(cfg) {
  return buildOptionalModelView(rerankReady(cfg), cfg?.rerank);
}

export function buildVecExtView(handle) {
  return {
    loaded: Boolean(handle?.hasVec),
    path: handle?.vecDllPath ?? null,
    platform: process.platform,
    arch: process.arch,
  };
}

export function createConfigResolver({ config = {}, dshHome, logger, getHostLlm }) {
  let globalCfgCache = null;

  function getGlobal() {
    if (!globalCfgCache) {
      const loaded = loadGlobalConfig({ dshHome });
      for (const w of loaded.warnings) logger?.warn?.(`[verbatim] ${w}`);
      globalCfgCache = loaded.config;
    }
    return globalCfgCache;
  }

  function invalidateGlobal() {
    globalCfgCache = null;
  }

  function embCfg() {
    const g = getGlobal().embedding ?? {};
    const p = config.embedding ?? {};
    const pick = (k) => (p[k] !== undefined && p[k] !== null && p[k] !== '' ? p[k] : g[k]);
    return {
      mode: (pick('mode') === 'local') ? 'local' : 'remote',
      model: pick('model') || DEFAULT_GLOBAL_CONFIG.embedding.model,
      dim: Number(pick('dim')) || DEFAULT_GLOBAL_CONFIG.embedding.dim,
      baseUrl: pick('baseUrl') || pick('baseURL') || DEFAULT_GLOBAL_CONFIG.embedding.baseUrl,
      apiKey: typeof pick('apiKey') === 'string' ? pick('apiKey') : '',
      apiKeyEnv: pick('apiKeyEnv') || config.embeddingKeyEnv || '',
      maxBatch: Number(pick('maxBatch')) || 32,
      fetchImpl: p.fetchImpl,
    };
  }

  function hasEmbeddingKey() {
    const emb = embCfg();
    if (emb.mode === 'local') return true;
    if (emb.apiKey.trim()) return true;
    if (emb.apiKeyEnv && process.env[emb.apiKeyEnv]) return true;
    return false;
  }

  function llmCfg() {
    const g = getGlobal().llm ?? {};
    const p = config.llm ?? {};
    const pick = (k) => (p[k] !== undefined && p[k] !== null && p[k] !== '' ? p[k] : g[k]);
    const enabled = p.enabled !== undefined ? p.enabled === true : g.enabled === true;
    const autoRefine = p.autoRefine !== undefined ? p.autoRefine === true : g.autoRefine === true;
    const rawDaily = Number(p.dailyLimit ?? g.dailyLimit);
    const dailyLimit = Number.isFinite(rawDaily) && rawDaily >= 0 ? Math.trunc(rawDaily) : 50;
    return {
      enabled,
      provider: typeof pick('provider') === 'string' ? pick('provider').trim() : '',
      model: typeof pick('model') === 'string' ? pick('model').trim() : '',
      autoRefine,
      dailyLimit,
    };
  }

  function hasLlmReady() {
    const c = llmCfg();
    if (!c.enabled || !c.model) return false;
    return Boolean(getHostLlm?.());
  }

  function rerankCfg() {
    const g = getGlobal().rerank ?? {};
    const p = config.rerank ?? {};
    const pick = (k) => (p[k] !== undefined && p[k] !== null && p[k] !== '' ? p[k] : g[k]);
    const enabled = p.enabled !== undefined ? p.enabled === true : g.enabled === true;
    return {
      enabled,
      mode: (pick('mode') === 'local') ? 'local' : 'remote',
      model: pick('model') || '',
      baseUrl: pick('baseUrl') || pick('baseURL') || 'https://api.siliconflow.cn/v1',
      apiKey: typeof pick('apiKey') === 'string' ? pick('apiKey') : '',
      apiKeyEnv: pick('apiKeyEnv') || config.rerankKeyEnv || '',
      topN: Number(pick('topN')) || 50,
      timeoutMs: Number(pick('timeoutMs')) || 8000,
      fetchImpl: p.fetchImpl,
    };
  }

  return {
    getGlobal,
    invalidateGlobal,
    embCfg,
    hasEmbeddingKey,
    llmCfg,
    hasLlmReady,
    rerankCfg,
  };
}
