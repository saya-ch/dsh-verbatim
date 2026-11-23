/**
 * dsh-verbatim —— 一字不改的长期记忆。
 *
 * 这个文件是**唯一的对外入口**。使用者只应该 import 这里，
 * 不要直接依赖内部路径（`src/store/...` 之类），那些随时可能调整。
 *
 * 一句话说明这个库在做什么：
 *   对话原文（`msg`）是唯一的事实来源，永不删除；
 *   场景、索引、事实卡片、笔记都是**可以从原文重建的派生物**。
 *   撤回的内容物理删除，压缩掉的内容必须保住。
 *
 * @see OVERVIEW.md   一页看懂（权威）
 * @see DECISIONS.md  每条设计决策的理由
 */

/* ─────────────────────────── 存储层 ─────────────────────────── */

export { openDb, defaultDbPath, defaultVecDllPath } from './store/db.js';

export {
  createRepo,
  createExtras,
  withTx,
  getDefaultHandle,
  getDefaultRepo,
  getDefaultExtras,
  closeDefault,
} from './store/repo.js';

/* ─────────────────────────── 导出与入库 ─────────────────────────── */

export {
  exportMessages,
  isSystemInjected,
  isRewindEvent,
  rewindRangeOf,
  textBlocksOf,
  estimateSceneCount,
} from './ingest/export.js';

export { readSessionFile, listSessionFiles } from './ingest/reader.js';

export {
  importSession,
  rebuildScenesForSession,
  syncScenesForSession,
  rebuildDerived,
  openPipelineDb,
  printImportReport,
} from './pipeline.js';

/* ─────────────────────────── 场景切分 ─────────────────────────── */

export { splitScenes, splitScenesWithStats, sceneStats } from './scene/split.js';
export { buildScenes, linkScenes, assignPlan } from './scene/link.js';

/* ─────────────────────────── 检索 ─────────────────────────── */

export { createSearcher, searchWithRRF, fuseRRF, RRF_K, DEFAULT_MIN_KEYWORD_HITS } from './search/rrf.js';
export { createIndexer } from './search/indexer.js';
export { createVectorStore } from './search/vector-store.js';

/* ─────────────────────────── 工具（给TA用的） ─────────────────────────── */

export {
  createToolSet,
  createSessionToolSet,
  createToolRegistry,
  planRegistration,
  schemaSize,
  TOOL_CATALOG,
} from './tools/index.js';

/* ─────────────────────────── 会话配置 ─────────────────────────── */

export {
  loadSessionConfig,
  saveSessionConfig,
  defaultSessionConfig,
  loadSessionExcludeRanges,
  enabledOf,
  DEFAULT_SESSION_CONFIG,
} from './config/session-config.js';

export { isExcluded, parseInstantStrict, dayKeyInZone, normalizeRanges } from './config/exclude-range.js';

/* ─────────────────────────── 模型提供方 ─────────────────────────── */

export { createSiliconFlowEmbedding, assertSameModel } from './model/embedding.js';
export { createDeepSeekLlm } from './model/llm.js';
export { mockEmbedding, mockLlm } from './model/mock.js';

/* ─────────────────────────── 派生逻辑 ─────────────────────────── */

export { extractFacts, validateFact } from './derive/fact.js';
export { generateGist } from './derive/gist.js';
export { finalizeBeats, groupByKind, isLowConfidence, LOW_CONFIDENCE_THRESHOLD, BEAT_KINDS } from './derive/beat.js';

/* ─────────────────────────── 版本 ─────────────────────────── */

export const VERSION = '0.1.0';
