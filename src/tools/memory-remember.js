/**
 * memory_remember —— TA自己记一件事（D-084）
 *
 * 三条硬约束（来自 BUILD-PLAN.md §4.6 + DECISIONS.md D-069 / D-084）：
 *
 * ① **只写 `note` 表，绝不写 `msg`。**
 *    TA的话不是「对话」。混进 msg 会同时污染两件东西：
 *    - 检索：时间路/关键词路会把TA的笔记当成"你们聊过的话"返回；
 *    - fact 提炼：fact 只能从 speaker='user' 的 msg 提（D-069），
 *      但把TA的笔记塞进 msg 会让人误以为那里有「用户说过」的原文。
 *    msg 是「你们说过的话」，note 是「TA自己记的」——两个来源不能混。
 *
 * ② **返回文案必须标「（你自己记的）」。**
 *    D-084：这是第三种来源。TA的认知允许自由文本、允许想偏；
 *    系统记错了是系统坏了，TA想错了是TA的想法。文案上不标出来，
 *    TA就会把自己写的笔记当成"系统告诉TA的事实"，也就失去了这条区分。
 *
 * ③ **每次操作写 `audit`，target 用 `note:123`。**
 *    笔记是TA能改的记忆，必须留下可追溯的痕迹（面板「核对」页也读它）。
 *
 * 顺便说明模块分工：本文件是 tools 里 remember/forget 这一对的底座，
 * 导出 resolveStore / runInTx / formatWhen 等小工具给 memory-forget.js 复用；
 * 反向不导入，避免循环依赖。
 */

import { openDb } from '../store/db.js';
import {
  createRepo,
  createExtras,
  withTx,
  getDefaultExtras,
  getDefaultHandle,
  getDefaultRepo,
} from '../store/repo.js';
// 排版一律复用 T4 的 format.js，不复制一份（两套时间写法会让同一段时间有两种口吻）
import { fmtPhase, fmtRelative, fmtStamp, clipText, noteAboutLabel } from './format.js';
import { resolveSessionId } from './scope.js';

/* ================================ 常量 ================================ */

/** 单条笔记的字数上限（BUILD-PLAN §4.6 的补充要求：content ≤ 500 字） */
export const MAX_CONTENT_CHARS = 500;

/** 软删后的保留期：30 天（BUILD-PLAN §4.6 / D-016 的回收站口径） */
export const NOTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** `about` 的合法值（Agent 第一人称视角，区别于 `fact.subject` 的用户视角）：
 *  me = 关于你自己 · him = 关于他（用户）· us = 关于你们俩 */
export const ABOUT_VALUES = Object.freeze(['me', 'him', 'us']);

// about 的人类可读标签统一从 format.js 取（Agent 视角：me → 关于你自己，him → 关于他），
// 原来这里有第三份副本，三处一旦漂移同一条笔记会被读成"关于他/你"。

/* ============================== 小工具 ============================== */

/**
 * 字符串按码点数长度（"字"按字符算，不按 UTF-16 单元算——表情不会算成 2 个）。
 * 500 字上限必须按这个口径，否则「占了 1 个表情就算超额」会有说不清的边界。
 * @param {string} text
 */
function charCount(text) {
  return Array.from(String(text)).length;
}

/**
 * 时间三段式（D-042）：绝对 + 相对 + 时段。
 * 三个部件全部来自 T4 的 format.js（时区固定 +08:00，纯算术，D-176），
 * 这里只是拼成 `11-17 19:52（刚刚 · 晚上）` 这种一行读得完的形状。
 *
 * @param {number} at
 * @param {number} [now]
 * @returns {string}
 */
export function formatWhen(at, now = Date.now()) {
  const ts = Number(at);
  if (!Number.isFinite(ts)) return '时间不明';
  return `${fmtStamp(ts)}（${fmtRelative(ts, now)} · ${fmtPhase(ts)}）`;
}

/**
 * 把笔记正文压成一段适合塞进审计的短片。
 * 注意是**截断显示量**，不是改写——原文在库里一个字都不动（D-101）。
 * @param {string} text
 * @param {number} [max]
 */
export function excerpt(text, max = 80) {
  return clipText(text, max);
}

/**
 * 默认库的懒加载单例（只在 ctx 什么都不给时用）。
 * 复用 T1 的三个单例，保证全进程只有一条连接（理由见下方 ④）。
 */
let defaultStore = null;

/**
 * 解析工具上下文里的仓储依赖。
 *
 * 兼容四种传法，因为各轨道/测试/面板的装配方式不统一，工具层不该挑食：
 *   ① `{ handle }`            —— openDb() 的返回值（T8 编排最常见）
 *   ② `{ db }`                —— 裸 DatabaseSync
 *   ③ `{ repo, extras }`      —— 分开传（mock 风格，T4 那套）
 *   ④ `{ dbPath }` / 什么都不传 —— 自己开库（默认走 $DSH_HOME/verbatim/memory.db）
 *
 * 另外接受 `{ memory: {...} }` 包一层，方便宿主把整个记忆子系统的依赖塞在一个字段里。
 *
 * @param {Record<string, any>} [ctx]
 * @returns {{db: any, repo: any, extras: any, handle: any}}
 */
export function resolveStore(ctx = {}) {
  const source = ctx?.memory && typeof ctx.memory === 'object' ? ctx.memory : (ctx ?? {});

  // ① handle：repo/extras/db 都能从它派生，三者共享同一个连接，事务才跨命名空间生效
  if (source.handle && typeof source.handle === 'object' && source.handle.db) {
    const handle = source.handle;
    return {
      db: handle.db,
      repo: source.repo ?? createRepo(handle),
      extras: source.extras ?? createExtras(handle),
      handle,
    };
  }

  // ② 裸 DatabaseSync（只认最基础的 prepare，避免为了 instanceof 去 import node:sqlite）
  if (source.db && typeof source.db.prepare === 'function' && !source.repo && !source.extras) {
    const db = source.db;
    return { db, repo: createRepo(db), extras: createExtras(db), handle: null };
  }

  // ③ repo + extras 分开给（没有连接就拿不到事务，runInTx 会自动退化成直调）
  if (source.repo && source.extras) {
    const db = source.db && typeof source.db.prepare === 'function' ? source.db : null;
    return { db, repo: source.repo, extras: source.extras, handle: null };
  }

  // ④ 自己开库。**默认库必须复用 T1 的单例**（getDefaultHandle/Repo/Extras）：
  //    工具层若各开各的连接，两个连接同时写同一个文件就会撞 SQLite 的写锁
  //    （BEGIN IMMEDIATE 下另一方直接 "database is locked"）。
  //    T4 的 timeline/search 也是走这套单例，所以这里跟着走，全进程一个连接。
  if (source.dbPath) {
    const opened = openDb({ dbPath: source.dbPath });
    return { db: opened.db, repo: createRepo(opened), extras: createExtras(opened), handle: opened };
  }
  if (!defaultStore) {
    const handle = getDefaultHandle();
    defaultStore = { db: handle.db, repo: getDefaultRepo(), extras: getDefaultExtras(), handle };
  }
  return defaultStore;
}

/**
 * 在一个事务里跑 fn。拿到连接就用 withTx（嵌套自动 SAVEPOINT），
 * 拿不到（mock 场景）就直接跑——**绝不因为"没连接"而让写操作失败**。
 * @template T
 * @param {any} db
 * @param {() => T} fn
 * @returns {T}
 */
export function runInTx(db, fn) {
  return db ? withTx(db, fn) : fn();
}

/** 取当前时间：ctx 可注入 `now`，测试里能精确控制「30 天」这类边界 */
function nowOf(ctx) {
  const at = Number(ctx?.now);
  return Number.isFinite(at) ? at : Date.now();
}

/* ============================== 核心实现 ============================== */

/**
 * 记一条笔记（memory_remember 的核心逻辑，返回结构化结果便于测试/面板复用）。
 *
 * @param {{content?: string, about?: string}} [args]
 * @param {Record<string, any>} [ctx] 见 resolveStore 的说明；另支持 `ctx.now` / `ctx.sessionId`
 * @returns {Promise<{ok: true, id: number, at: number, about: string|null,
 *                    sessionId: string|null, content: string, text: string} |
 *                   {ok: false, error: string, text: string}>}
 */
export async function rememberNote(args = {}, ctx = /** @type {Record<string, any>} */ ({})) {
  const raw = args.content;
  const now = nowOf(ctx);
  // A1：这条笔记归哪个会话。绑定会话的工具记进去的笔记带 session_id，
  // 于是只有同一个会话的 search / forget 看得见、删得掉它。
  const sessionId = resolveSessionId({}, ctx);

  // ① 内容校验：空的不写。返回明确原因，不静默失败（D-096）
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content) {
    return {
      ok: false,
      error: 'empty_content',
      text: [
        '这条没记成：内容是空的，我没有东西可写。',
        '想记的话，把要紧的那句直接写进 content 就行。',
      ].join('\n'),
    };
  }

  // ② 长度上限：500 字。超了**不截断**——截断等于替TA改了自己的想法，
  //    宁可退回让TA拆成两条（D-101：系统不负责替TA裁剪语义）。
  const chars = charCount(content);
  if (chars > MAX_CONTENT_CHARS) {
    return {
      ok: false,
      error: 'too_long',
      text: [
        `这条没记成：${chars} 字，超过一次能记的 ${MAX_CONTENT_CHARS} 字。`,
        '拆成两条，或者只留最要紧的那句——不用把整段话搬进来。',
      ].join('\n'),
    };
  }

  // ③ about：只认 me / him / us（Agent 第一人称视角），拿不准就别填（填错了比空着更糟）
  let about = null;
  if (args.about !== undefined && args.about !== null && String(args.about).trim() !== '') {
    const value = String(args.about).trim().toLowerCase();
    if (!ABOUT_VALUES.includes(value)) {
      const aboutLabels = ctx?.aboutLabels ?? null;
      const hintMe = noteAboutLabel('me', aboutLabels);
      const hintHim = noteAboutLabel('him', aboutLabels);
      const hintUs = noteAboutLabel('us', aboutLabels);
      return {
        ok: false,
        error: 'bad_about',
        text: [
          `这条没记成：about 只认 ${ABOUT_VALUES.join(' / ')}，收到「${String(args.about)}」。`,
          `me = ${hintMe} · him = ${hintHim} · us = ${hintUs}。拿不准就别填，空着也一样能记。`,
        ].join('\n'),
      };
    }
    about = value;
  }

  // ④ 落库。note + audit 两条语句放进同一个事务：
  //    要么「记下了且有痕」，要么都没发生——不允许出现"记了但查不到谁记的"。
  let store;
  try {
    store = resolveStore(ctx);
  } catch (error) {
    return {
      ok: false,
      error: 'store_unavailable',
      text: [
        `这条没记成：记忆库打不开（${error?.message ?? error}）。`,
        '这条内容现在不在任何地方——你可以等一下再说一次。',
      ].join('\n'),
    };
  }

  try {
    const id = runInTx(store.db, () => {
      const noteId = store.extras.note.insert({ content, about, at: now, sessionId });
      store.extras.audit.insert({
        action: 'remember',
        target: `note:${noteId}`,
        detail: {
          about,
          chars,
          preview: excerpt(content, 80),
          at: now,
        },
        at: now,
      });
      return noteId;
    });

    return {
      ok: true,
      id,
      at: now,
      about,
      sessionId,
      content,
      text: [
        '记下了（你自己记的）。',
        '',
        `「${content}」`,
        '',
        [
          `笔记 #${id}`,
          about ? noteAboutLabel(about, ctx?.aboutLabels ?? null) : null,
          formatWhen(now, now),
        ]
          .filter(Boolean)
          .join(' · '),
        '',
        '这是你自己记的，不是系统告诉你的事实——所以就算记偏了，那也是你的想法。',
        `以后想找回来，记着它的编号 #${id} 就行；不想要了就说「把 #${id} 忘掉」。`,
      ].join('\n'),
    };
  } catch (error) {
    return {
      ok: false,
      error: 'write_failed',
      text: [
        `这条没记成：写入时出错了（${error?.message ?? error}）。`,
        'note 和审计是一起写的，所以没有留下半条。——过一会儿再试一次。',
      ].join('\n'),
    };
  }
}

/**
 * 造一个绑定好依赖的工具（T8 的 tools/index.js 直接用这个）。
 *
 * `deps.sessionId`（A1）：绑定这个工具实例属于哪个会话。记进去的笔记带
 * `note.session_id`，只有同一会话的检索/删除看得见它。
 *
 * @param {object} [deps] 形如 `{ handle }` / `{ repo, extras }` / `{ dbPath }` / `{ sessionId }`
 */
export function createRememberTool(deps = {}) {
  return {
    name: 'memory_remember',
    description:
      '把一件你想记住的事写进你自己的笔记。写进去的是「你自己记的」——不是系统告诉你的事实，' +
      '所以允许带上你的看法和语气。适合记：他说过的一句让你在意的话、你自己发现的事、你不想忘的瞬间、' +
      '你自己的判断。不适合记：整段对话原文（那些已经在记忆里了，用不着抄一遍）。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: `你想记下的内容。一句话到一小段都行，最多 ${MAX_CONTENT_CHARS} 字。`,
          maxLength: MAX_CONTENT_CHARS,
        },
        about: {
          type: 'string',
          enum: [...ABOUT_VALUES],
          description:
            '这条是关于谁的：me = 关于你自己 · him = 关于他（用户）· us = 关于你们俩。' +
            '拿不准就别填，空着也能记。',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    /**
     * @param {{content?: string, about?: string}} args
     * @param {object} [ctx]
     * @returns {Promise<string>} 纯文本，不返回 JSON（D-095）
     */
    async handler(args = {}, ctx = {}) {
      const result = await rememberNote(args, { ...deps, ...ctx });
      return result.text;
    },
  };
}

/** 默认工具实例（不绑依赖，第一次调用时才开默认库） */
export const memoryRememberTool = createRememberTool();

export default memoryRememberTool;
