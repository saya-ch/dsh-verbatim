/**
 * 全局配置 —— 所有会话共享的那一份（D-014：对话级 > 全局级）。
 *
 * 存在 `$DSH_HOME/verbatim/config.json`，人可以直接编辑。
 * 和 `sessions/<id>.json` 的分工：
 *   - 全局：默认开关、embedding 模型与 key（或环境变量名）、检索参数
 *   - 会话：这个对话自己的 record / tools / excludeRanges（覆盖全局默认）
 *
 * API Key 可直接在设置页写入 `config.json`（或选本地服务），也兼容旧的 `apiKeyEnv` 环境变量（D-003 修订）。
 */

import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = 'verbatim';

export const DEFAULT_GLOBAL_CONFIG = Object.freeze({
  /** 新会话的默认开关（D-230：默认关） */
  defaults: Object.freeze({
    record: false,
    tools: false,
    autoRecall: false,
  }),

  /** embedding 模型（语义检索）。没配 key 时自动降级为纯关键词检索。 */
  embedding: Object.freeze({
    /**
     * 服务类型（作者 2026-11-18）：
     *   'remote' 远程 API（需要 key）
     *   'local'  本机服务（Ollama / LM Studio / vLLM 之类，通常不校验 key）
     */
    mode: 'remote',
    /** 模型 id；空字符串 = 不启用语义检索 */
    model: 'Qwen/Qwen3-Embedding-4B',
    /** 截断维度（MRL，D-144） */
    dim: 1024,
    /** 接口地址。本地服务填 http://127.0.0.1:11434/v1 这种 */
    baseUrl: 'https://api.siliconflow.cn/v1',
    /**
     * **直接存 Key**（作者 2026-11-18：不要逼人设环境变量）。
     * 明文存在 config.json 里 —— 这个文件在 ~/.dsh/verbatim/ 下，只有你自己能读。
     * 界面上不回显完整值，只显示掩码。
     */
    apiKey: '',
    /** 兼容老配置：从环境变量读 Key（apiKey 为空时才用） */
    apiKeyEnv: '',
    /** 单批最多几条 */
    maxBatch: 32,
  }),

  /** 可选对话模型（Tier-2 场景摘要 gist 精炼）。直接使用 DSH 本体已配置的模型列表，不单独维护 API。 */
  llm: Object.freeze({
    /** 是否启用 LLM 精炼场景摘要（默认关） */
    enabled: false,
    /** DSH 提供商 id（如 deepseek-official；留空则按 model 自动匹配首个可用提供商） */
    provider: '',
    /** DSH 模型 id（从 DSH 本体模型列表选择） */
    model: '',
    /** 空闲后台自动补齐未精炼场景摘要（默认关） */
    autoRefine: false,
    /** 每日后台自动 LLM 摘要场次上限（预算阀，防烧钱） */
    dailyLimit: 50,
  }),

  /** 可选 Rerank 精排模型（在混合召回 RRF 之后对候选结果做二次重排） */
  rerank: Object.freeze({
    /** 是否启用 Rerank 精排（默认关） */
    enabled: false,
    /** 'remote' 远程兼容 /rerank API（需要 key） | 'local' 本机服务（Ollama / vLLM / Xinference 等） */
    mode: 'remote',
    /** 模型 id（如 BAAI/bge-reranker-v2-m3、Qwen/Qwen3-Reranker-4B） */
    model: '',
    /** OpenAI / SiliconFlow 兼容接口地址（请求时拼接 /rerank） */
    baseUrl: 'https://api.siliconflow.cn/v1',
    /** 直接存 Key（可选；界面只显示掩码，不回显完整值） */
    apiKey: '',
    /** 兼容从环境变量读 Key（apiKey 为空时才用） */
    apiKeyEnv: '',
    /** 参与精排的候选条数上限（默认 50：与粗排池 RERANK_POOL_SIZE 对齐，保证整池都排到） */
    topN: 50,
    /** 超时毫秒（超时自动降级回 RRF 原序） */
    timeoutMs: 8000,
  }),

  /** 检索参数 */
  search: Object.freeze({
    /** 默认返回几条 */
    defaultLimit: 8,
    /** 单次最多返回几条 */
    maxLimit: 50,
  }),

  /** 索引 */
  index: Object.freeze({
    /** 自动在后台建索引（需要 embedding 可用） */
    autoIndex: false,
  }),
});

function dbRoot(opts = {}) {
  const home = opts.dshHome ?? process.env.DSH_HOME ?? path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh',
  );
  return path.join(home, APP_DIR);
}

export function globalConfigPath(opts = {}) {
  return path.join(dbRoot(opts), 'config.json');
}

/** 深合并：文件里的值覆盖默认值，但缺的字段补默认（不要求文件写全） */
function merge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

/** 读全局配置。文件不存在 / 坏了都返回默认值，不抛（配置不该让插件打不开）。 */
export function loadGlobalConfig(opts = {}) {
  const p = globalConfigPath(opts);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return { config: structuredClone(DEFAULT_GLOBAL_CONFIG), exists: false, warnings: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const warnings = [];
    const cfg = merge(DEFAULT_GLOBAL_CONFIG, parsed);
    // 常见的错配置：把 key 本身写进来了（应该只写变量名）
    const key = cfg.embedding?.apiKeyEnv;
    if (typeof key === 'string' && (key.startsWith('sk-') || key.length > 60)) {
      warnings.push('embedding.apiKeyEnv 看起来是 API Key 本身。这里只该填环境变量名（如 SILICONFLOW_API_KEY），不要写 key。');
    }
    const llmKeyEnv = cfg.llm?.apiKeyEnv;
    if (typeof llmKeyEnv === 'string' && (llmKeyEnv.startsWith('sk-') || llmKeyEnv.length > 60)) {
      warnings.push('llm.apiKeyEnv 看起来是 API Key 本身。这里只该填环境变量名（如 DEEPSEEK_API_KEY），不要写 key。');
    }
    const rerankKeyEnv = cfg.rerank?.apiKeyEnv;
    if (typeof rerankKeyEnv === 'string' && (rerankKeyEnv.startsWith('sk-') || rerankKeyEnv.length > 60)) {
      warnings.push('rerank.apiKeyEnv 看起来是 API Key 本身。这里只该填环境变量名（如 SILICONFLOW_API_KEY），不要写 key。');
    }
    return { config: cfg, exists: true, warnings };
  } catch (e) {
    return {
      config: structuredClone(DEFAULT_GLOBAL_CONFIG),
      exists: true,
      warnings: [`config.json 不是合法 JSON（${e.message}），已按默认值运行`],
    };
  }
}

/** 写全局配置（深合并后落盘，原子写） */
export function saveGlobalConfig(patch, opts = {}) {
  const p = globalConfigPath(opts);
  const { config } = loadGlobalConfig(opts);
  const next = merge(config, patch);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
  return next;
}

/** embedding 是否真的可用（有模型 + 有 key，或者本地服务） */
export function embeddingReady(cfg, env = process.env) {
  const model = cfg?.embedding?.model;
  const mode = cfg?.embedding?.mode === 'local' ? 'local' : 'remote';
  const baseUrl = cfg?.embedding?.baseUrl;
  if (!model) return { ready: false, reason: '没配 embedding 模型' };
  if (!baseUrl) return { ready: false, reason: '没填接口地址（base URL）' };

  if (mode === 'local') {
    // 本地服务通常不校验 key，只要能连上就行
    return { ready: true, model, dim: cfg.embedding.dim, mode, baseUrl, local: true };
  }

  const key = typeof cfg.embedding.apiKey === 'string' ? cfg.embedding.apiKey.trim() : '';
  if (key) return { ready: true, model, dim: cfg.embedding.dim, mode, baseUrl };

  // 兼容老配置：从环境变量读
  const envName = cfg.embedding.apiKeyEnv;
  if (envName && env[envName]) {
    return { ready: true, model, dim: cfg.embedding.dim, mode, baseUrl, fromEnv: envName };
  }

  return {
    ready: false,
    reason: '远程服务需要 API Key —— 去设置页填一个，或者把服务类型改成「本地」。',
    mode,
  };
}

function optionalModelReady(block, disabledReason, emptyModelReason, env = process.env) {
  const enabled = block?.enabled === true;
  const model = typeof block?.model === 'string' ? block.model.trim() : '';
  const mode = block?.mode === 'local' ? 'local' : 'remote';
  const baseUrl = typeof block?.baseUrl === 'string' ? block.baseUrl.trim() : '';

  if (!enabled) {
    return { ready: false, enabled: false, mode, baseUrl, model, reason: disabledReason };
  }
  if (!model) return { ready: false, enabled: true, mode, baseUrl, model, reason: emptyModelReason };
  if (!baseUrl) return { ready: false, enabled: true, mode, baseUrl, model, reason: '没填接口地址（base URL）' };

  if (mode === 'local') {
    return { ready: true, enabled: true, model, mode, baseUrl, local: true };
  }

  const key = typeof block?.apiKey === 'string' ? block.apiKey.trim() : '';
  if (key) return { ready: true, enabled: true, model, mode, baseUrl };

  const envName = block?.apiKeyEnv;
  if (envName && env[envName]) {
    return { ready: true, enabled: true, model, mode, baseUrl, fromEnv: envName };
  }

  return {
    ready: false,
    enabled: true,
    mode,
    baseUrl,
    model,
    reason: '远程服务需要 API Key —— 去设置页填一个，或者把服务类型改成「本地」。',
  };
}

/** 对话模型（可选，用于 Tier-2 场景摘要精炼；直接使用 DSH 本体 ctx.llm 模型）是否可用 */
export function llmReady(cfg, hasHostLlm = true) {
  const enabled = cfg?.llm?.enabled === true;
  const provider = typeof cfg?.llm?.provider === 'string' ? cfg.llm.provider.trim() : '';
  const model = typeof cfg?.llm?.model === 'string' ? cfg.llm.model.trim() : '';
  if (!enabled) {
    return { ready: false, enabled: false, provider, model, reason: '未启用（当前使用零成本抽取式摘要）' };
  }
  if (!hasHostLlm) {
    return { ready: false, enabled: true, provider, model, reason: '当前未连接到 DSH 模型服务' };
  }
  if (!model) {
    return { ready: false, enabled: true, provider, model, reason: '请从 DSH 模型列表中选择一个模型' };
  }
  return { ready: true, enabled: true, provider, model };
}

/** Rerank 精排模型（可选）是否可用 */
export function rerankReady(cfg, env = process.env) {
  return optionalModelReady(cfg?.rerank, '未启用（当前使用 RRF 融合排序）', '没配 rerank 模型名称', env);
}
