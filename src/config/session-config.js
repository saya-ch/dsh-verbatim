// session-config.js —— 会话级配置（D-014 / D-166 / D-169 / D-175）
//
// 一个会话一份 JSON：`$DSH_HOME/verbatim/sessions/<session-id>.json`
//
// ┌─ 配置目录分工（D-175）───────────────────────────────────────────────┐
// │ 运行时：$DSH_HOME/verbatim/sessions/<id>.json   ← 这里是唯一真源 │
// │ 项目内：<repo>/sessions/<id>.json                   ← 只放 fixture    │
// │         /默认模板，**不写运行时配置**（避免把用户数据提交进仓库）    │
// └──────────────────────────────────────────────────────────────────────┘
// 因此 loadSessionConfig / saveSessionConfig 都接受 dbRoot：测试与 fixture 场景
// 传项目目录，运行时传 `$DSH_HOME/verbatim`。
//
// 配置项（D-166 定稿为两个开关 + 一个预留项；D-230 改为默认全关）：
//   record        boolean  默认 false   新消息入库
//   tools         boolean  默认 false   注册 3 个工具（关掉省 schema token）
//   autoRecall    boolean  默认 false   **字段保留，面板不渲染**（D-166：以后加注入功能不用迁移配置）
//   excludeRanges Array    默认 []      软排除区间，左闭右开 [from, to)（D-169/D-170）
//
// 时区一律由 exclude-range.js 处理（= 复用 T2 的实现，见该文件顶部说明）。

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import { ConfigError, normalizeRanges, parseInstantStrict } from './exclude-range.js';

/** 应用数据目录名：$DSH_HOME/verbatim */
export const APP_DIR_NAME = 'verbatim';

/** 会话配置子目录 */
export const SESSIONS_DIR_NAME = 'sessions';

/**
 * 面板**渲染**的开关（PANEL.md §3.1）。
 * 注意 `autoRecall` 故意不在这个列表里 —— D-166：它是预留配置项，不是开关。
 */
export const SWITCH_KEYS = Object.freeze(['record', 'tools']);

/** 保留但不渲染的配置项（D-166） */
export const RESERVED_KEYS = Object.freeze(['autoRecall']);

/** 配置 schema 里的全部已知字段 */
export const CONFIG_KEYS = Object.freeze(['record', 'tools', 'autoRecall', 'excludeRanges']);

/** 默认配置的只读常量（要拿可改的副本请用 defaultSessionConfig()） */
export const DEFAULT_SESSION_CONFIG = Object.freeze({
  // **默认关**（作者 2026-11-18 明确要求，修正 D-009 的「记录默认常开」）。
  // 理由：这是会往本地写对话原文的事情，应该由人显式打开，
  // 而不是装上就开始记。默认关不会让任何既有数据消失。
  record: false,
  tools: false,
  autoRecall: false,
  excludeRanges: Object.freeze([]),
});

/**
 * 默认配置的**新副本**。每次返回新对象，避免调用方改到常量。
 * @returns {{ record: boolean, tools: boolean, autoRecall: boolean, excludeRanges: object[] }}
 */
export function defaultSessionConfig() {
  // 从常量派生，**不要再写第二份默认值** —— 之前这里硬编码了 record:true/tools:true，
  // 和 DEFAULT_SESSION_CONFIG 各写一遍，改一处忘一处（R5 审查也点出过）。
  return {
    record: DEFAULT_SESSION_CONFIG.record,
    tools: DEFAULT_SESSION_CONFIG.tools,
    autoRecall: DEFAULT_SESSION_CONFIG.autoRecall,
    excludeRanges: [],
  };
}

/** 给错误信息用的类型名 */
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  if (v instanceof Date) return 'Date';
  return typeof v;
}

/**
 * 取 DSH_HOME。语义与 `src/store/db.js` 的 resolveDshHome 一致：
 * 显式传入 > 环境变量 DSH_HOME > `~/.dsh`（Electron 里由宿主注入环境变量）。
 * 故意不 import db.js：那个模块会拉起 node:sqlite / 原生扩展，配置层不该背这个包袱。
 *
 * @param {string} [override]
 * @returns {string} 绝对路径
 */
export function resolveDshHome(override) {
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(homedir(), '.dsh');
}

/**
 * 解析「记忆数据根目录」（= `$DSH_HOME/verbatim`）。
 *
 * 兼容三种调用方式：
 *   resolveDbRoot()                              → $DSH_HOME/verbatim
 *   resolveDbRoot('/tmp/wm')                     → /tmp/wm              （老签名：直接给 dbRoot）
 *   resolveDbRoot({ dbRoot: '/tmp/wm' })         → /tmp/wm
 *   resolveDbRoot({ dshHome: '/tmp/home' })      → /tmp/home/verbatim
 *
 * @param {string|{dbRoot?: string, dshHome?: string}|null|undefined} [opts]
 * @returns {string} 绝对路径
 */
export function resolveDbRoot(opts) {
  if (typeof opts === 'string' && opts.trim()) return path.resolve(opts.trim());

  const o = opts && typeof opts === 'object' ? opts : {};
  if (typeof o.dbRoot === 'string' && o.dbRoot.trim()) return path.resolve(o.dbRoot.trim());
  if (typeof o.dshHome === 'string' && o.dshHome.trim()) {
    return path.join(resolveDshHome(o.dshHome), APP_DIR_NAME);
  }
  return path.join(resolveDshHome(), APP_DIR_NAME);
}

/**
 * 会话配置目录：`<dbRoot>/sessions`
 * @param {string|object} [opts] 同 resolveDbRoot
 * @returns {string}
 */
export function sessionsDir(opts) {
  return path.join(resolveDbRoot(opts), SESSIONS_DIR_NAME);
}

/**
 * 校验 sessionId。挡住路径穿越（`../x`、`a/b`）和 Windows 非法字符。
 * @param {unknown} sessionId
 * @returns {string} 去空白后的 id
 * @throws {ConfigError}
 */
export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new ConfigError(`sessionId 必须是非空字符串，实际是 ${typeName(sessionId)}`, {
      path: 'sessionId',
    });
  }
  const id = sessionId.trim();
  if (/[\\/:*?"<>|]/.test(id) || id.startsWith('.') || id.length > 200) {
    throw new ConfigError(
      `sessionId 不能包含路径分隔符或特殊字符（\\ / : * ? " < > |），也不能以 . 开头，长度不得超过 200（收到 ${JSON.stringify(sessionId)}）`,
      { path: 'sessionId' },
    );
  }
  return id;
}

/**
 * 某个会话的配置文件绝对路径：`<dbRoot>/sessions/<id>.json`
 * @param {unknown} sessionId
 * @param {string|object} [opts]
 * @returns {string}
 * @throws {ConfigError} sessionId 非法时
 */
export function sessionConfigPath(sessionId, opts) {
  return path.join(sessionsDir(opts), `${assertSessionId(sessionId)}.json`);
}

/**
 * 校验并规范化一份配置对象（纯函数，不碰磁盘）。
 *
 * 规则：
 *   - `record` / `tools` / `autoRecall` 必须布尔（缺省补默认值）；
 *   - `excludeRanges` 走严格校验，非法即抛 ConfigError（不静默跳过）；
 *   - 未知字段**保留**（防以后版本/其他工具写的字段被 save 冲掉），并通过 onWarn 提示。
 *
 * @param {unknown} input
 * @param {{ path?: string, onWarn?: (msg: string) => void }} [opts]
 * @returns {{ record: boolean, tools: boolean, autoRecall: boolean, excludeRanges: object[] }}
 * @throws {ConfigError}
 */
export function validateSessionConfig(input, opts = {}) {
  const at = opts.path ?? 'sessionConfig';
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError(`${at}：配置必须是 JSON 对象，实际是 ${typeName(input)}`, { path: at });
  }

  const defaults = defaultSessionConfig();
  const out = {};

  for (const key of ['record', 'tools', 'autoRecall']) {
    const v = input[key];
    if (v === undefined) {
      out[key] = defaults[key];
      continue;
    }
    if (typeof v !== 'boolean') {
      throw new ConfigError(
        `${at}.${key}：必须是 true/false，实际是 ${typeName(v)}（${JSON.stringify(v)}）`,
        { path: `${at}.${key}` },
      );
    }
    out[key] = v;
  }

  out.excludeRanges = sanitizeExcludeRanges(input.excludeRanges, `${at}.excludeRanges`);

  // 未知字段原样保留（写回时不丢），只在需要时告警
  const unknown = [];
  for (const key of Object.keys(input)) {
    if (CONFIG_KEYS.includes(key)) continue;
    out[key] = input[key];
    unknown.push(key);
  }
  if (unknown.length && onWarn) {
    onWarn(`${at}：有未知配置项 ${unknown.map((k) => JSON.stringify(k)).join(', ')}，已保留但不会被使用`);
  }

  return out;
}

/**
 * 校验 excludeRanges 并返回**保持原样写法**的副本（字符串还是字符串）。
 * 归一化成数字只发生在匹配时，配置文件和面板显示都要认得出人写的东西。
 *
 * @param {unknown} raw
 * @param {string} at 错误信息里的字段路径
 * @returns {object[]}
 * @throws {ConfigError}
 */
function sanitizeExcludeRanges(raw, at) {
  if (raw === undefined || raw === null) return [];
  // 复用严格校验：抛错即配置非法；返回值只用于校验，不写回配置
  normalizeRanges(raw, { path: at });
  return raw.map((r) => {
    const item = { from: r.from, to: r.to };
    if (typeof r.reason === 'string' && r.reason.trim()) item.reason = r.reason.trim();
    return item;
  });
}

/**
 * 读一个会话的配置。文件不存在 → 返回默认值（不落盘）。
 *
 * @param {unknown} sessionId
 * @param {string|{dbRoot?: string, dshHome?: string, onWarn?: (msg:string)=>void}} [opts]
 * @returns {{ record: boolean, tools: boolean, autoRecall: boolean, excludeRanges: object[] }}
 * @throws {ConfigError} sessionId 非法 / JSON 语法错 / 字段非法 / 读盘失败
 */
export function loadSessionConfig(sessionId, opts = {}) {
  const file = sessionConfigPath(sessionId, opts);
  const onWarn = typeof opts?.onWarn === 'function' ? opts.onWarn : undefined;

  if (!fs.existsSync(file)) return defaultSessionConfig();

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`读不了会话配置：${file}（${e.message}）`, {
      code: 'CONFIG_READ_FAILED',
      path: file,
    });
  }

  if (!text.trim()) {
    throw new ConfigError(
      `会话配置是空文件：${file}。空文件不能当成默认值——那会悄悄把排除区间清掉，请写明配置或删掉该文件`,
      { code: 'CONFIG_INVALID_JSON', path: file },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`会话配置不是合法 JSON：${file}\n  ${e.message}`, {
      code: 'CONFIG_INVALID_JSON',
      path: file,
    });
  }

  return validateSessionConfig(parsed, { path: file, onWarn });
}

/**
 * 合并写回配置（读 → 合并 patch → 严格校验 → 原子写）。
 * 只给 patch 里出现的字段，其余保持不变；文件不存在时以默认值为底。
 *
 * @param {unknown} sessionId
 * @param {object} patch 例如 `{ record: false }` 或 `{ excludeRanges: [...] }`
 * @param {string|{dbRoot?: string, dshHome?: string, onWarn?: (msg:string)=>void}} [opts]
 * @returns {{ record: boolean, tools: boolean, autoRecall: boolean, excludeRanges: object[] }} 落盘后的完整配置
 * @throws {ConfigError}
 */
export function saveSessionConfig(sessionId, patch, opts = {}) {
  const file = sessionConfigPath(sessionId, opts);
  const onWarn = typeof opts?.onWarn === 'function' ? opts.onWarn : undefined;

  if (patch !== undefined && patch !== null && (typeof patch !== 'object' || Array.isArray(patch))) {
    throw new ConfigError(`saveSessionConfig 的 patch 必须是对象，实际是 ${typeName(patch)}`, {
      path: 'patch',
    });
  }

  const current = loadSessionConfig(sessionId, opts);
  const merged = validateSessionConfig({ ...current, ...(patch ?? {}) }, { path: file, onWarn });

  const text = `${JSON.stringify(merged, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file); // 原子替换：不会留下半截 JSON
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不影响主错误
    }
    throw new ConfigError(`写不了会话配置：${file}（${e.message}）`, {
      code: 'CONFIG_WRITE_FAILED',
      path: file,
    });
  }

  return merged;
}

/**
 * 面板 `panel.set` 的落点（PANEL.md §5）：改单个开关。
 *
 * 只允许 CONFIG_KEYS 里的布尔项（含 `autoRecall` —— 面板不渲染它，但 RPC 契约里保留，
 * 以后加注入功能时前端不用改协议，D-166）。
 *
 * @param {unknown} sessionId
 * @param {'record'|'tools'|'autoRecall'} key
 * @param {unknown} value
 * @param {string|object} [opts]
 * @returns {object} 落盘后的完整配置
 * @throws {ConfigError}
 */
export function setSessionFlag(sessionId, key, value, opts = {}) {
  const allowed = [...SWITCH_KEYS, ...RESERVED_KEYS];
  if (!allowed.includes(key)) {
    throw new ConfigError(
      `开关名只能是 ${allowed.map((k) => JSON.stringify(k)).join(' / ')}，收到 ${JSON.stringify(key)}`,
      { path: 'key' },
    );
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${key} 必须是 true/false，实际是 ${typeName(value)}（${JSON.stringify(value)}）`, {
      path: key,
    });
  }
  return saveSessionConfig(sessionId, { [key]: value }, opts);
}

/**
 * 整组替换排除区间（面板「按日期排除」用）。
 * @param {unknown} sessionId
 * @param {object[]} ranges 人写的写法，如 `[{ from: '2026-11-08', to: '2026-11-09', reason: '调试期' }]`
 * @param {string|object} [opts]
 * @returns {object} 落盘后的完整配置
 * @throws {ConfigError}
 */
export function setSessionExcludeRanges(sessionId, ranges, opts = {}) {
  return saveSessionConfig(sessionId, { excludeRanges: ranges }, opts);
}

/**
 * 取某个会话的排除区间，**已归一化成 epoch 毫秒**（可直接喂给 isExcluded / applyExclusions）。
 *
 * @param {unknown} sessionId
 * @param {string|object} [opts]
 * @returns {Array<{from:number, to:number, reason:string|null, fromText:string|null, toText:string|null}>}
 * @throws {ConfigError}
 */
export function loadSessionExcludeRanges(sessionId, opts = {}) {
  const cfg = loadSessionConfig(sessionId, opts);
  return normalizeRanges(cfg.excludeRanges, { path: `${sessionConfigPath(sessionId, opts)}.excludeRanges` });
}

/**
 * 配置文件是否存在（面板要区分「默认值」与「用户真的配过」）。
 * @param {unknown} sessionId
 * @param {string|object} [opts]
 * @returns {boolean}
 */
export function sessionConfigExists(sessionId, opts) {
  return fs.existsSync(sessionConfigPath(sessionId, opts));
}

/**
 * 缺文件时落一份默认配置（显式调用才会写盘；load 本身不写）。
 * @param {unknown} sessionId
 * @param {string|object} [opts]
 * @returns {object}
 */
export function ensureSessionConfig(sessionId, opts = {}) {
  if (sessionConfigExists(sessionId, opts)) return loadSessionConfig(sessionId, opts);
  return saveSessionConfig(sessionId, {}, opts);
}

/**
 * 面板 `panel.status → enabled` 的形状（PANEL.md §5）。
 * `autoRecall` 恒带在返回值里（协议稳定），但面板不渲染开关（D-166）。
 *
 * @param {object} cfg
 * @returns {{ record: boolean, tools: boolean, autoRecall: boolean }}
 */
export function enabledOf(cfg) {
  return {
    record: cfg?.record === true,
    tools: cfg?.tools === true,
    autoRecall: cfg?.autoRecall === true,
  };
}

// 常见场景下少写一次 import：这两个工具属于「配置里写日期」这件事的一部分
export { parseInstantStrict, normalizeRanges };
