/**
 * tools/index.js —— 工具注册表（T8）
 *
 * 对外只注册 3 个核心工具 —— memory_search / memory_remember / memory_forget。
 * D-096：**注册期按开关过滤**——关掉的不注册，省 schema token（不是注册了再拒绝）。
 *
 * 开关语义（与 T9 的会话配置一一对应，默认值都来自 defaultSessionConfig）：
 *   tools  = false → 一个都不注册（TA要静静，连工具都别露出来）
 *   record = false → 不注册「写入侧」的记笔记口子（memory_remember），保留查询与删除
 *   autoRecall 是预留字段，与本表无关（D-166，面板不渲染）
 *
 * 注册表只依赖各工具的工厂函数，不 import 任何模块内部实现；
 * 依赖注入沿用各工具自己的口径（`{ handle }` / `{ repo, extras }` / `{ dbPath }`）。
 *
 * **会话隔离（A1）**：工具实例必须按会话创建（handler 要闭包捕获 sessionId），
 * 所以宿主应该用 `createSessionToolSet({ sessionId, ... })`，而不是共用一套：
 *   const set = createSessionToolSet({ handle, repo, extras, sessionId });
 *   sessionCtx.tools.register(toDshTool(set.tools[i]));
 * 连接不因此变多 —— 同一 dbPath 按引用计数共享一条（见 acquireHandle）。
 */

import { resolve as pathResolve } from 'node:path';

import { defaultSessionConfig, enabledOf, loadSessionConfig } from '../config/session-config.js';
import { openDb } from '../store/db.js';
import { createExtras, createRepo } from '../store/repo.js';
import { createForgetTool } from './memory-forget.js';
import { createRememberTool } from './memory-remember.js';
import { createSearchTool } from './memory-search.js';
import { normalizeSessionId } from './scope.js';

/**
 * 全部可用工具（按固定顺序，保证每次生成的 schema 顺序一致，缓存/对比都稳定）。
 * @type {Array<{
 *   name: string, kind: 'read'|'write', switchKeys: string[], factory: Function,
 *   since: string, note: string,
 * }>}
 */
export const TOOL_CATALOG = Object.freeze([
  {
    name: 'memory_search',
    kind: 'read',
    switchKeys: ['tools'],
    factory: createSearchTool,
    since: 'T4',
    note: '合并检索：when（标准时间路）+ query（关键词+语义）+ 两者组合；scope=msg|note|all',
  },
  {
    name: 'memory_remember',
    kind: 'write',
    switchKeys: ['tools', 'record'],
    factory: createRememberTool,
    since: 'T7',
    note: '记一条自己的笔记（写 note 表，不写 msg）',
  },
  {
    name: 'memory_forget',
    kind: 'write',
    switchKeys: ['tools'],
    factory: createForgetTool,
    since: 'T7',
    note: '软删自己的笔记 / 从回收站捡回来；msg 原文永远删不了',
  },
]);

/** 3 个核心工具的名字 */
export const CORE_TOOL_NAMES = Object.freeze([
  'memory_search',
  'memory_remember',
  'memory_forget',
]);

/** 全部可用工具名 */
export const ALL_TOOL_NAMES = Object.freeze(TOOL_CATALOG.map((t) => t.name));

/**
 * 由配置算出「该注册哪些工具」。
 *
 * @param {object} [config] 会话配置（T9 的形状：record / tools / excludeRanges）
 * @param {object} [_opts] 兼容旧参数（如 `{ withFlag }` 会被忽略，不再注册 memory_flag）
 * @returns {{tools: boolean, record: boolean, names: string[]}}
 */
export function planRegistration(config = defaultSessionConfig(), _opts = {}) {
  const flags = enabledOf(config);
  if (flags.tools !== true) return { tools: false, record: flags.record, names: [] };

  const names = [];
  for (const entry of TOOL_CATALOG) {
    // 每个工具声明自己依赖哪些开关；全开才注册（D-096：关掉的不注册）
    if (entry.switchKeys.every((key) => flags[key] === true)) names.push(entry.name);
  }
  return { tools: true, record: flags.record, names };
}

/**
 * 造一份工具注册表。
 *
 * 返回的就是 MCP / 宿主可以直接注册的数组：`{ name, description, parameters, handler }`
 * （BUILD-PLAN §3.4 的 ToolDef，一个字段不多一个不少）。
 *
 * @param {{
 *   handle?: object,          // openDb() / openPipelineDb() 的返回（最常用）
 *   repo?: object, extras?: object, dbPath?: string,
 *   config?: object,          // 会话配置；不给 = 默认全开
 *   sessionId?: string,       // A1：这个工具集绑定的会话（宿主按会话创建）
 *   now?: number|(() => number),
 *   guard?: boolean,          // 默认 true：工具抛异常时返回明确错误，而不是空结果（D-096）
 *   loadVec?: boolean,        // 只在「给了 dbPath、没给 handle」时用来自已开库
 *   logger?: { warn(msg: string): void }, // 未绑会话时在这里留一句警告
 * }} [opts]
 * @returns {Array<{name: string, description: string, parameters: object,
 *                  handler: (args: object, ctx?: object) => Promise<string>}>}
 */
export function createToolRegistry(opts = {}) {
  return createToolSet(opts).tools;
}

/**
 * 与 createToolRegistry 相同，但额外把「打开了的连接」一起交出来，便于宿主收尾。
 *
 * 为什么需要它：T4 的 timeline / search 只认 `handle`（或全局默认库单例），
 * 不吃 `dbPath`；而 T7 的 remember / forget 会自己按 `dbPath` 开库。
 * 如果放任不管，「给 dbPath」这条路径下就会出现两个连接指向两个库 —— 写入看得见、
 * 检索看不见。所以这里统一开一个连接，再分发给全部工具（集成时发现的接口不符之一）。
 *
 * 会话隔离（A1）：`sessionId` 绑定这个工具集属于哪个会话，**必须由宿主按会话传入**
 * （见 createSessionToolSet）。不传 = 单库模式（MCP 单会话 / 验收脚本 / 老测试），
 * 检索不过滤 —— 那是历史行为，不是"自动知道当前会话"。
 *
 * @param {object} [opts] 同 createToolRegistry，另支持 `sessionId` / `logger`
 * @returns {{tools: object[], plan: object, sessionId: string|null, close: () => void}}
 */
export function createToolSet(opts = {}) {
  const config = opts.config ?? defaultSessionConfig();
  const plan = planRegistration(config, opts);
  const sessionId = normalizeSessionId(opts.sessionId);

  // 依赖注入：各工具的工厂自己解析（handle > repo/extras > dbPath > 默认库单例）
  const deps = {};
  for (const key of ['handle', 'repo', 'extras', 'dbPath', 'now']) {
    if (opts[key] !== undefined) deps[key] = opts[key];
  }
  // sessionId 走单独一条：非法值（空串/非字符串）不能变成"绑定了一个空会话"
  if (sessionId) deps.sessionId = sessionId;

  // 没绑会话时给一声警告：这个模式会跨会话检索，只有单库场景才该这么用。
  // 不主动 console.warn（别污染 MCP 的 stdout / 测试输出），只走宿主给的 logger。
  if (!sessionId) {
    opts.logger?.warn?.(
      '[verbatim] 工具集没有绑定 sessionId：检索会跨会话（只有单库模式 / 验收脚本该这样）。' +
        '宿主请按会话创建：createSessionToolSet({ sessionId, ... })',
    );
  }

  let lease = null;
  if (deps.handle === undefined && deps.repo === undefined && deps.dbPath !== undefined) {
    lease = acquireHandle(deps.dbPath, opts.loadVec !== false);
    deps.handle = lease.handle;
    delete deps.dbPath;
  }

  // handle 只建一次 repo/extras：预编译语句缓存能复用，repo 与 extras 也共享同一个
  // 事务上下文（withTx 按连接记账）。每调用一次新建一套会让缓存白建。
  if (deps.handle && !deps.repo) deps.repo = createRepo(deps.handle);
  if (deps.handle && !deps.extras) deps.extras = createExtras(deps.handle);

  const guard = opts.guard !== false;
  const byName = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));

  const tools = plan.names.map((name) => {
    const tool = byName.get(name).factory(deps);
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      handler: guard ? withStoreGuard(tool.handler, name) : tool.handler,
    };
  });

  return {
    tools,
    plan,
    sessionId,
    close() {
      lease?.release();
      lease = null;
    },
  };
}

/**
 * 给**一个会话**造一套工具实例 —— 宿主（index.js）该用的就是这个。
 *
 * 和 createToolSet 的差别只有三件事：
 *   ① `sessionId` **必填**。没有它工具只能查全库，A1 的洞就还在；
 *   ② 没显式给 `config` 时按 `sessions/<sessionId>.json` 读这个会话的开关
 *      （A3：开关按会话存 —— A 关掉「给TA工具」不该影响 B）；
 *   ③ 返回的 handler 已经闭包住 sessionId，宿主 execute 里照旧传
 *      `{ handle, repo, extras }` 也不会把会话弄丢（见 scope.js 的三态语义）。
 *
 * 连接复用：同一个 `dbPath` 只开一条连接（按引用计数关闭），传 `handle` 时
 * 完全不新开连接 —— 宿主应该把启动时那条 handle 传进来。
 *
 * @param {{
 *   sessionId: string,                 // 必填
 *   handle?: object, repo?: object, extras?: object, dbPath?: string,
 *   config?: object,                   // 不给就按会话配置读（A3）
 *   dbRoot?: string,                   // 会话配置目录的父目录（$DSH_HOME/verbatim）
 *   dshHome?: string,                  // 或者给 $DSH_HOME（配置在 <dshHome>/verbatim/sessions/）
 *   now?: number|(() => number), guard?: boolean,
 *   loadVec?: boolean, logger?: { warn(msg: string): void },
 * }} opts
 * @returns {{tools: object[], plan: object, sessionId: string, config: object,
 *            close: () => void}}
 * @throws {TypeError} 没给 sessionId（这是防"忘绑会话"的硬闸门）
 */
export function createSessionToolSet(opts = {}) {
  const sessionId = normalizeSessionId(opts.sessionId);
  if (!sessionId) {
    throw new TypeError(
      'createSessionToolSet: 必须给 sessionId —— 工具要按会话隔离（A1）。' +
        '确实需要一个不分会话的工具集，请显式调用 createToolSet()。',
    );
  }

  let config = opts.config;
  if (!config) {
    const configOpts = {};
    if (opts.dbRoot) configOpts.dbRoot = opts.dbRoot;
    if (opts.dshHome) configOpts.dshHome = opts.dshHome;
    try {
      // 会话配置是 A3 的唯一真源：sessions/<id>.json（D-175 目录分工）
      config = loadSessionConfig(sessionId, Object.keys(configOpts).length ? configOpts : undefined);
    } catch (error) {
      // 配置坏了不能让工具直接消失：按默认开关注册，并留一条可查的警告
      opts.logger?.warn?.(
        `[verbatim] 读不了会话 ${sessionId} 的配置，按默认开关注册工具：${error?.message ?? error}`,
      );
      config = defaultSessionConfig();
    }
  }

  const set = createToolSet({ ...opts, sessionId, config });
  return { ...set, config };
}

/* ============================ 连接共享（A1 的副作用） ============================
 * 宿主给每个会话各造一套工具实例，但**不可以各开一条连接**：
 *   - SQLite 写锁下两个连接同时写同一个库 → "database is locked"（BEGIN IMMEDIATE）；
 *   - 每条连接都要重跑 PRAGMA 调优 + 加载 sqlite-vec，白白多花内存和时间。
 * 所以同一 dbPath 只开一条，按引用计数关闭：最后一个工具集 close() 时才真关。
 * `:memory:` 例外 —— 那是每个调用方各要一个独立库（测试常用），从不共享。
 * ============================================================================ */

/** dbPath → { handle, refs } */
const sharedHandles = new Map();

/**
 * 借一条连接（可能新开，也可能复用）。
 * @param {string} dbPath
 * @param {boolean} loadVec
 * @returns {{handle: object, release: () => void}}
 */
function acquireHandle(dbPath, loadVec) {
  if (dbPath === ':memory:') {
    const handle = openDb({ dbPath, loadVec });
    return {
      handle,
      release() {
        try {
          handle.close();
        } catch {
          // 已经关了就算了
        }
      },
    };
  }

  const key = pathResolve(dbPath);
  let entry = sharedHandles.get(key);
  if (!entry) {
    entry = { handle: openDb({ dbPath: key, loadVec }), refs: 0 };
    sharedHandles.set(key, entry);
  }
  entry.refs += 1;
  let released = false;
  return {
    handle: entry.handle,
    release() {
      if (released) return; // close() 幂等
      released = true;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        sharedHandles.delete(key);
        try {
          entry.handle.close();
        } catch {
          // 关不上不影响退出
        }
      }
    },
  };
}

/** 只要 schema（MCP 握手/面板预览用，别把 handler 序列化出去） */
export function toolSchemas(tools = []) {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * 把「库打不开 / handler 抛异常」变成一句说得清的错误，而不是空结果。
 *
 * D-096 的理由：空结果会被TA读成「我们没聊过」。所以宁可报错，也要说明白
 * 「是记忆库这边出问题了」，并给出怎么恢复。
 *
 * @param {(args: object, ctx?: object) => Promise<string>} handler
 * @param {string} name
 */
export function withStoreGuard(handler, name) {
  return async function guarded(args = {}, ctx = {}) {
    try {
      const text = await handler(args, ctx);
      // 工具都是返回纯文本；返回非字符串说明装配错了，直接说清楚（不吞）
      if (typeof text !== 'string') {
        return `${name} 内部返回了非文本结果（${typeof text}），这不是「没有记录」，是装配错误。`;
      }
      return text;
    } catch (error) {
      return [
        `${name} 这次没跑成：${error?.message ?? error}`,
        '这不是「你们没聊过」——是记忆库这边出错了。',
        '可以稍后重试；如果一直这样，就需要重建记忆库（原文在会话日志里不会丢）。',
      ].join('\n');
    }
  };
}

/** 汇总 schema 体量（D-096 关心的就是它：未注册的工具不产生 token） */
export function schemaSize(tools = []) {
  const text = JSON.stringify(toolSchemas(tools));
  return { tools: tools.length, chars: text.length };
}

/* ============================== 兼容导出 ============================== */

/** 3 个工具的默认实例（全开、不绑依赖，第一次调用才开默认库） */
export const defaultTools = createToolRegistry();

export default createToolRegistry;
