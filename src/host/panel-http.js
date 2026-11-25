// @ts-check
/**
 * 面板 RPC HTTP 适配层（路由、方法白名单、Origin 校验、参数强转与 JSON 响应）。
 */

/** 面板 RPC 前缀（client.js 的 fetch 前缀必须一致） */
export const API_PREFIX = '/verbatim-api';

/** 面板全部 RPC 方法清单 */
export const PANEL_METHODS = Object.freeze([
  'status',
  'timeline',
  'sceneDetail',
  'notes',
  'deletedNotes',
  'sample',
  'verify',
  'search',
  'set',
  'setExcludeRanges',
  'rebuild',
  'task',
  'flag',
  'flags',
  'unflag',
  'deleteNote',
  'restoreNote',
  'addNote',
  'globalConfig',
  'setGlobalConfig',
  'probeLocal',
  'dbOverview',
  'dbRows',
  'dbQuery',
  'dbMaintain',
  'recallLog',
  'mergeScene',
  'splitScene',
  'refineOneScene',
  'mediaPreview',
  'setMediaCaption',
  'findDuplicateNotes',
  'mergeNotes',
  'setSceneGist',
  'setMsgExcluded',
  'updateNote',
]);

/** 写操作强制走 POST */
export const WRITE_METHODS = new Set([
  'set',
  'setExcludeRanges',
  'rebuild',
  'flag',
  'unflag',
  'deleteNote',
  'restoreNote',
  'addNote',
  'setGlobalConfig',
  'dbMaintain',
  'mergeScene',
  'splitScene',
  'refineOneScene',
  'setMediaCaption',
  'mergeNotes',
  'setSceneGist',
  'setMsgExcluded',
  'updateNote',
]);

/** 已废弃的旧路径（明确告知迁移而不是静默 404） */
const LEGACY_PANEL_PATHS = new Set(['/stats', '/timeline', '/notes', '/flags']);

/** 不依赖会话日志的面板 RPC：跳过同步以保证即时响应 */
const SKIP_SYNC_METHODS = new Set([
  'globalConfig',
  'setGlobalConfig',
  'probeLocal',
  'task',
  'rebuild',
  'set',
  'setExcludeRanges',
  'addNote',
  'dbOverview',
  'dbRows',
  'dbQuery',
  'dbMaintain',
  'recallLog',
  'mergeScene',
  'splitScene',
  'refineOneScene',
  'mediaPreview',
  'setMediaCaption',
  'findDuplicateNotes',
  'mergeNotes',
  'setSceneGist',
  'setMsgExcluded',
  'updateNote',
]);

/** 带 HTTP 状态码的 RPC 错误 */
export class PanelError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PanelError';
    this.code = code;
    this.status = status;
  }
}

/** @param {any} input */
export function coerceParams(input) {
  const INT_KEYS = new Set(['msgId', 'sceneId', 'id', 'limit', 'offset']);
  const BOOL_KEYS = new Set(['value', 'reset', 'includeExcluded', 'excluded']);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    if (INT_KEYS.has(k) && /^-?\d+$/.test(v.trim())) { out[k] = Number(v); continue; }
    if (BOOL_KEYS.has(k) && (v === 'true' || v === 'false')) { out[k] = v === 'true'; continue; }
    out[k] = v;
  }
  return out;
}

/**
 * 读 HTTP JSON 请求体；GET/HEAD 返回 `{}`；非法 JSON 或超 1MB 返回 `null`。
 * @param {any} req
 * @returns {Promise<Record<string, any> | null>}
 */
function readRequestBody(req) {
  return new Promise((resolve) => {
    if (!req || req.method === 'GET' || req.method === 'HEAD') return resolve({});
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    /** @param {Record<string, any> | null} v */
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > 1_000_000) return finish(null);
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return finish({});
      try {
        const parsed = JSON.parse(text);
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/**
 * @param {any} res
 * @param {any} body
 * @param {number} [status]
 */
function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * @param {any} req
 * @param {string[] | null} [allowedOrigins]
 * @returns {boolean}
 */
function isSameOriginRequest(req, allowedOrigins = null) {
  const secFetchSite = String(req?.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (secFetchSite === 'cross-site') return false;

  const rawOrigin = req?.headers?.origin;
  if (typeof rawOrigin !== 'string' || !rawOrigin.trim()) return true;
  const origin = rawOrigin.trim();
  if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) return true;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  const hostHeader = String(req?.headers?.host ?? '').trim();
  if (!hostHeader) return false;
  if (parsedOrigin.host.toLowerCase() === hostHeader.toLowerCase()) return true;

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  let parsedHost;
  try {
    parsedHost = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  const oHost = parsedOrigin.hostname.toLowerCase();
  const hHost = parsedHost.hostname.toLowerCase();
  const oPort = parsedOrigin.port || (parsedOrigin.protocol === 'https:' ? '443' : '80');
  const hPort = parsedHost.port || (parsedHost.protocol === 'https:' ? '443' : '80');
  return loopbackHosts.has(oHost) && loopbackHosts.has(hHost) && oPort === hPort;
}

/**
 * 把 `createPanelApi()` 适配成 HTTP handler。
 * @param {{ call(method: string, params?: any): Promise<any> }} api
 * @param {{
 *   beforeRequest?: (ctx: {method: string, sessionId: string|null}) => Promise<any>|any,
 *   afterCall?: (ctx: {method: string, params: Record<string, any>, result: unknown}) => Promise<any>|any,
 *   allowedOrigins?: string[],
 * }} [opts]
 */
export function createPanelHandler(api, opts = {}) {
  const beforeRequest = typeof opts.beforeRequest === 'function' ? opts.beforeRequest : null;
  const afterCall = typeof opts.afterCall === 'function' ? opts.afterCall : null;
  const allowedOrigins = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : null;

  return async function handler(/** @type {any} */ req, /** @type {any} */ res) {
    const httpMethod = String(req?.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'HEAD', 'OPTIONS'].includes(httpMethod)) {
      return sendJson(res, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `不支持的 HTTP 方法：${httpMethod}` }, 405);
    }
    if (!isSameOriginRequest(req, allowedOrigins)) {
      return sendJson(res, { ok: false, code: 'FORBIDDEN_ORIGIN', error: '拒绝跨站请求（Origin 校验未通过）' }, 403);
    }
    if (httpMethod === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, { ok: false, code: 'BAD_URL', error: '请求 URL 不合法' }, 400);
    }

    const rawPath = url.pathname;
    const p = rawPath.startsWith(API_PREFIX) ? rawPath.slice(API_PREFIX.length) || '/' : rawPath;

    if (!p.startsWith('/panel.')) {
      const legacy = LEGACY_PANEL_PATHS.has(p);
      return sendJson(
        res,
        {
          ok: false,
          code: legacy ? 'LEGACY_ENDPOINT' : 'NOT_FOUND',
          error: legacy
            ? `旧端点 ${p} 已废弃：它不按会话过滤，会把别的对话的数据混进来。请改用 ${API_PREFIX}/panel.status 等 RPC。`
            : `没有这个端点：${p}。RPC 路径形如 ${API_PREFIX}/panel.status`,
          methods: [...PANEL_METHODS],
        },
        legacy ? 410 : 404,
      );
    }

    const method = p.slice('/panel.'.length);
    if (httpMethod === 'GET' && WRITE_METHODS.has(method)) {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
      res.end(JSON.stringify({
        ok: false,
        method: `panel.${method}`,
        code: 'METHOD_NOT_ALLOWED',
        error: `写操作 panel.${method} 必须使用 POST 请求`,
      }));
      return;
    }
    const body = await readRequestBody(req);
    if (body === null) {
      return sendJson(res, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON 对象' }, 400);
    }

    /** @type {Record<string, any>} */
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const params = coerceParams({ ...query, ...body });

    if (beforeRequest && !SKIP_SYNC_METHODS.has(method)) {
      const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId.trim()
        : null;
      try {
        await beforeRequest({ method, sessionId });
      } catch { /* 同步失败不影响读取 */ }
    }

    try {
      const result = await api.call(method, params);
      if (afterCall) {
        try { await afterCall({ method, params, result }); } catch { /* 后置钩子失败不影响响应 */ }
      }
      return sendJson(res, result, 200);
    } catch (error) {
      const status = error instanceof PanelError ? error.status : 500;
      const errObj = /** @type {any} */ (error);
      return sendJson(
        res,
        {
          ok: false,
          method: `panel.${method}`,
          code: errObj?.code ?? 'INTERNAL_ERROR',
          error: errObj?.message ?? String(error),
        },
        status,
      );
    }
  };
}
