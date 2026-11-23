/**
 * scope.js —— 工具层的会话隔离（A1 / D-014）
 *
 * ## 为什么需要这个文件
 *
 * 数据层一直是对的：`msg.session_id` / `scene.session_id` 都在，
 * `msgsByTimeRange(sessionId, ...)` / `scenesByTimeRange(sessionId, ...)`
 * 都支持按会话过滤。**是工具层把所有查询的 sessionId 硬编码成了 null**
 * （全库），于是TA在 A 会话里查东西会翻到 B、C 会话的记忆。
 *
 * 这个文件只做一件事：把「这个工具实例属于哪个会话」解析出来，
 * 然后每个工具把结果透传给仓储层的 sessionId 参数。**五个工具共用一份实现**，
 * 不做第二份规则（两份规则一漂移，就又会有一个工具漏传）。
 *
 * ## 三态语义（别简化成两态，会踩坑）
 *
 * | 绑定情况 | sessionId | 行为 |
 * |---|---|---|
 * | 宿主按会话创建工具（`createToolSet({ sessionId })` / `createSessionToolSet`） | `'abc'` | **只查这个会话**（A1 要求的行为） |
 * | 单库模式（MCP 单会话 / 验收脚本 / 老测试，没有任何会话概念） | `null` | 不过滤（历史行为，向后兼容） |
 *
 * 第三态是「显式反悔」：`ctx.sessionId = null` 不能覆盖掉工具实例上绑定的
 * 真会话 —— 宿主传 ctx 时经常只带 `{ handle, repo, extras }`，
 * 一旦「ctx 里没有就当成全库」，隔离会随宿主写法悄悄失效。
 * 所以优先级是：**ctx.sessionId（非空字符串） > deps.sessionId**，
 * 空/缺省一律回落到已绑定的那个。
 *
 * 关键约束：判定「当前会话」的唯一来源是**工具实例被创建时绑定的 sessionId**
 * 或宿主显式传进来的 `ctx.sessionId`；工具参数（模型给的那几个）里没有、
 * 也不该有 sessionId —— TA不该能通过工具参数越权到别的会话。
 */

/**
 * 归一化 sessionId：非空字符串才算「绑定了会话」。
 * 其他一律返回 null（= 单库模式）。
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeSessionId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id ? id : null;
}

/**
 * 解析当前工具实例应该按哪个会话过滤。
 *
 * @param {object} [injected] 工具工厂的依赖（`createXxxTool({ sessionId })`）
 * @param {object} [ctx] 调用期上下文（handler 的第二个参数，宿主注入）
 * @returns {string|null} null = 单库模式（不过滤）
 */
export function resolveSessionId(injected = {}, ctx = {}) {
  return normalizeSessionId(ctx?.sessionId) ?? normalizeSessionId(injected?.sessionId);
}

/**
 * 这一行是不是属于当前会话。
 * `sessionId` 为 null（单库模式）时恒真 —— 向后兼容历史调用方。
 *
 * @param {{sessionId?: string|null}|null|undefined} row
 * @param {string|null} sessionId
 * @returns {boolean}
 */
export function inSession(row, sessionId) {
  if (!sessionId) return true;
  return row?.sessionId === sessionId;
}

/**
 * 过滤一组行，只留当前会话的（`sessionId` 为 null 时原样返回）。
 *
 * 用途：`repo.msgsByIds([id])` 是「按 id 查表、不按会话过滤」的接口
 * （BUILD-PLAN 的契约如此，核对面要能看到任意 id 的行）。工具层要用它时
 * 必须自己过一道会话，否则 A 会话能凭编号读到 B 会话的原文（存在性泄露，
 * 更糟的是 memory_forget 会拿它做跨会话判定）。
 *
 * @param {object[]} rows
 * @param {string|null} sessionId
 * @returns {object[]}
 */
export function pickInSession(rows, sessionId) {
  if (!Array.isArray(rows)) return [];
  return sessionId ? rows.filter((row) => row?.sessionId === sessionId) : rows;
}

/**
 * 空结果里「库里有 …」那行用的统计。
 *
 * **必须按会话取**：A 会话的空结果不能报出 B/C 会话的条数与日期跨度
 * （A1 的判定是「结果里没有 B 的 seq」，而条数同样能反推出 B 的存在）。
 * 老库/老 extras 没有 `stats.get` 时返回空对象，工具照样能跑。
 *
 * @param {object} extras createExtras() 的返回值
 * @param {string|null} sessionId
 * @returns {object}
 */
export function sessionStats(extras, sessionId) {
  try {
    const get = extras?.stats?.get;
    if (typeof get !== 'function') return {};
    return (sessionId ? get.call(extras.stats, { sessionId }) : get.call(extras.stats, {})) ?? {};
  } catch {
    return {};
  }
}
