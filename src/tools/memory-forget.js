/**
 * memory_forget —— TA主动忘掉一件事（软删，30 天可恢复）
 *
 * 四条硬约束（BUILD-PLAN.md §4.6 + DECISIONS.md D-016 / D-084 / D-167）：
 *
 * ① **只允许删 `note`，`msg` 原文不允许删。**
 *    msg 是「你们说过的话」的唯一事实来源，一句不丢是这个插件的根本承诺。
 *    「觉得这句记错了」的正确处理是 **标记 + 查 + 重建**（D-167），不是删这一条：
 *    库里的字和日志不一致 → 导出有 bug；这条不该入库 → 过滤规则有漏。
 *    两种情况都指向「修 + 重建」。所以传 msg 的编号必须**拒绝**并说明原因。
 *
 * ② **软删，30 天可恢复。**
 *    `deleted_at` 有值就是删了；`note.list` 默认不返回已删的。
 *    恢复（restore）是同一个工具的一个模式——D-095 把工具总数钉死在 4 个，
 *    不为「恢复」单开第五个工具。
 *
 * ③ **每次操作写 `audit`，target 用 `note:123`。**
 *    remember / forget / restore 三个动作都要留痕。删和恢复是同一件事的两面，
 *    只记删除的话，回收站里被恢复过的笔记就查不到来路了。
 *
 * ④ **删不存在的编号必须返回明确错误，不能返回「成功」。**
 *    静默成功等于骗TA"我删掉了"，而它可能根本不存在。
 *
 * 编号空间说明（这条容易踩）：
 *   note.id 与 msg.id 是**两套独立自增**，数字会撞。所以：
 *   - 裸数字（`12` / `#12`）按 **note** 解释（笔记编号是TA自己记完拿到的那个号）；
 *   - `note:12` 显式指定笔记；`msg:12` 显式指定对话原文（必然被拒绝）。
 *   - 万一这个数字在对话里也存在，回答里会**明说**「我删的是你自己记的那条笔记，
 *     对话里的 #12 是原文，我没动」，不让TA以为聊过的话被删了。
 */

import { DAY_MS, quoteLine, noteAboutWord } from './format.js';
import { pickInSession, resolveSessionId } from './scope.js';
import {
  NOTE_RETENTION_MS,
  excerpt,
  formatWhen,
  resolveStore,
  runInTx,
} from './memory-remember.js';

/** 软删后彻底不可恢复的保留期（BUILD-PLAN §4.6 / D-016：回收站 30 天） */
export { NOTE_RETENTION_MS };

/** 审计里的动作名，集中一处，避免三处各写一遍字符串 */
const AUDIT_ACTION = Object.freeze({
  forget: 'forget',
  restore: 'restore',
});

/* ============================== 编号解析 ============================== */

/** 前缀别名：中文也认，TA说什么都能对上 */
const REF_PREFIX = Object.freeze({
  note: 'note',
  笔记: 'note',
  msg: 'msg',
  消息: 'msg',
  原文: 'msg',
});

/**
 * 解析「哪一条」。宽容收输入，但**不猜意图**：
 * 数字本身归 note（唯一的可删对象），前缀能显式指定。
 *
 * @param {number|string} raw
 * @returns {{kind: 'auto'|'note'|'msg', id: number}|null} 解析不了返回 null
 */
export function parseNoteRef(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && Number.isInteger(raw) && raw > 0
      ? { kind: 'auto', id: raw }
      : null;
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  // 形如：12 / #12 / note:12 / note 12 / 笔记#12 / msg:12 / 原文12
  const matched = /^([a-z\u4e00-\u9fa5]*)\s*[:：\s#]*\s*#?(\d+)$/iu.exec(text);
  if (!matched) return null;
  const prefixRaw = (matched[1] ?? '').toLowerCase();
  const id = Number(matched[2]);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!prefixRaw) return { kind: 'auto', id };
  const kind = REF_PREFIX[prefixRaw];
  if (!kind) return null;
  return { kind, id };
}

/* ============================== 文案小工具 ============================== */

/**
 * 回收站剩余时间的一句话说明。
 * @param {number} deletedAt
 * @param {number} now
 */
function retentionHint(deletedAt, now) {
  const left = NOTE_RETENTION_MS - (now - deletedAt);
  if (left <= 0) return '已经超过 30 天保留期，下次清理就彻底没了';
  const days = Math.ceil(left / DAY_MS);
  return `还剩 ${days} 天可以恢复`;
}

/** TA的笔记现状（"我这儿只有 N 条，最新的是 #M"），用于「没找到」时给方向。
 *  **按会话数**（A1）：不能把别的会话的笔记条数说出来。 */
function noteInventory(extras, sessionId = null) {
  try {
    const liveCount = typeof extras.note.count === 'function'
      ? extras.note.count({ sessionId })
      : null;
    const latestLive = extras.note.list({ limit: 1, sessionId });
    const totalLive = liveCount !== null ? liveCount : latestLive.length;
    if (totalLive > 0 && latestLive.length > 0) {
      return `你目前一共 ${totalLive} 条笔记，最新的编号是 #${latestLive[0].id}。`;
    }
    const deletedCount = typeof extras.note.count === 'function'
      ? extras.note.count({ sessionId, deletedOnly: true })
      : extras.note.list({ limit: 500, includeDeleted: true, sessionId }).length;
    if (deletedCount > 0) return `你现在没有未删的笔记（回收站里还有 ${deletedCount} 条）。`;
    return '你目前一条笔记都没记过。';
  } catch {
    return '';
  }
}

/**
 * 按编号找一条**属于当前会话**的对话原文。
 *
 * 为什么不能直接用 `repo.msgsByIds([id])[0]`：它是「按 id 查表」的接口，
 * 契约上不按会话过滤（核对页要能看到任意 id 的行）。工具层拿它做判定时
 * 必须自己过一道会话 —— 否则 A 会话给一个 B 会话的编号，就能从回答里
 * 确认「B 那边有这么一句话」并读回它的原文（A1：会话之间不该互相看见）。
 *
 * @param {object} repo
 * @param {number} msgId
 * @param {string|null} sessionId null = 单库模式（不过滤）
 * @returns {object|null}
 */
function msgInSession(repo, msgId, sessionId = null) {
  const rows = safeCall(() => repo.msgsByIds([msgId]), []);
  return pickInSession(rows, sessionId)[0] ?? null;
}

/** 一条 msg 的展示行（原文，第二人称/第三人称按 format.js 的口径） */
function msgLine(msg) {
  return quoteLine({ speaker: msg.speaker, text: msg.text }, '  ').trimStart();
}

/* ============================== 核心实现 ============================== */

/**
 * 忘掉一条笔记 / 从回收站恢复（memory_forget 的核心逻辑）。
 *
 * @param {{id?: number|string, reason?: string, restore?: boolean}} [args]
 * @param {object} [ctx] 见 memory-remember.js 的 resolveStore；另支持 `ctx.now`
 * @returns {Promise<{ok: boolean, action: string, id: number|null, text: string}>}
 */
export async function forgetNote(args = {}, ctx = {}) {
  const now = Number.isFinite(Number(ctx?.now)) ? Number(ctx.now) : Date.now();
  // A1：这个工具实例属于哪个会话。所有读/写都按它过滤 ——
  // 修复前这里不认会话，A 会话能给一个编号就删掉 B 会话的笔记。
  const sessionId = resolveSessionId({}, ctx);
  const restoreMode = args.restore === true;

  // ① 编号：给不出来就什么都不做，并说清楚要什么
  const ref = parseNoteRef(args.id);
  if (!ref) {
    return {
      ok: false,
      action: 'invalid',
      id: null,
      text: [
        '没给出能认的编号，所以我什么都没动。',
        '笔记编号是像 12 这样的数字（我记完会告诉你）。对话里的原话要写成 msg:12——那种是删不掉的。',
      ].join('\n'),
    };
  }

  // ② 开库
  let store;
  try {
    store = resolveStore(ctx);
  } catch (error) {
    return {
      ok: false,
      action: 'error',
      id: ref.id,
      text: [
        `没动：记忆库打不开（${error?.message ?? error}）。`,
        '这一条还在原处，等你那边恢复了再来一次。',
      ].join('\n'),
    };
  }

  const { extras, repo, db } = store;

  // ③ 顺手扫一遍过期回收站（30 天前的软删行物理清掉）。
  //    放在操作前、且 best-effort：清理失败绝不能挡住本次的删除/恢复。
  let purged = 0;
  try {
    purged = Number(extras.note.purgeExpired(NOTE_RETENTION_MS, now, { sessionId })) || 0;
  } catch {
    purged = 0;
  }

  const note = safeCall(() => extras.note.byId(ref.id, { sessionId }), null);
  const msg = note ? null : msgInSession(repo, ref.id, sessionId);

  /* ---------------------------- 删除：遇到 msg ---------------------------- */
  // ① 显式 msg: / 原文 / 消息 前缀 → 必然拒绝；
  // ② 裸数字：笔记里没有、但对话原文里有 → 拒绝（并说明为什么）。
  // 显式 note: 前缀时**不**走这条：TA明确说的是笔记，没有就是没有（走 not_found）。
  if (ref.kind === 'msg' || (ref.kind === 'auto' && !note && msg)) {
    // 上面为了省一次查询，只在"笔记没命中"时才去查 msg；显式 msg: 前缀时也得查一下，
    // 否则文案会误说"对话原文里也没找到"（其实找到了）。仍然只在本会话里找（A1）。
    const msgRow = msg ?? msgInSession(repo, ref.id, sessionId);
    return {
      ok: false,
      action: 'refused',
      id: ref.id,
      text: buildMsgRefusal(msgRow, ref, now),
    };
  }

  /* ------------------------------- 没找到 ------------------------------- */
  if (!note) {
    const inventory = noteInventory(extras, sessionId);
    return {
      ok: false,
      action: 'not_found',
      id: ref.id,
      text: [
        `没找到编号 #${ref.id} 的笔记，什么都没删。`,
        inventory ? `\n${inventory}` : '',
        '编号可能是记错了，也可能它已经被彻底清理掉了（软删超过 30 天）。',
        ref.kind === 'note'
          ? '你给的是 note: 前缀，说明你指的是笔记——笔记里确实没有这个号。'
          : '如果你指的是对话里的某句话，那个编号删不了（原文是唯一事实来源）。',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  /* ------------------------------ 恢复模式 ------------------------------ */
  if (restoreMode) {
    if (note.deletedAt === null || note.deletedAt === undefined) {
      return {
        ok: false,
        action: 'restore_noop',
        id: note.id,
        text: [
          `#${note.id} 本来就没删，没动它。`,
          `「${excerpt(note.content, 80)}」`,
          `记于 ${formatWhen(note.at, now)}。`,
        ].join('\n'),
      };
    }
    const restored = safeCall(() => extras.note.restore(note.id, { sessionId }), false);
    if (!restored) {
      return {
        ok: false,
        action: 'error',
        id: note.id,
        text: `#${note.id} 没能恢复（可能刚好被清理掉了）。它现在仍然不在你的笔记里。`,
      };
    }
    safeCall(
      () =>
        runInTx(db, () =>
          extras.audit.insert({
            action: AUDIT_ACTION.restore,
            target: `note:${note.id}`,
            detail: {
              reason: args.reason ?? null,
              deletedAt: note.deletedAt,
              at: now,
            },
            at: now,
          }),
        ),
      null,
    );
    return {
      ok: true,
      action: 'restore',
      id: note.id,
      text: [
        `#${note.id} 又回来了。`,
        '',
        `「${note.content}」`,
        '',
        `记于 ${formatWhen(note.at, now)}${aboutSuffix(note.about)}`,
      ].join('\n'),
    };
  }

  /* ------------------------------ 已在回收站 ----------------------------- */
  if (note.deletedAt !== null && note.deletedAt !== undefined) {
    return {
      ok: false,
      action: 'already_deleted',
      id: note.id,
      text: [
        `#${note.id} 已经删过了，它在回收站里——${retentionHint(note.deletedAt, now)}。`,
        `删于 ${formatWhen(note.deletedAt, now)}，内容没动过。`,
        `想捡回来说「把 #${note.id} 恢复」。`,
      ].join('\n'),
    };
  }

  /* -------------------------------- 软删 -------------------------------- */
  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null;
  const deletedAt = now;
  const done = safeCall(
    () =>
      runInTx(db, () => {
        // 软删与审计同一事务：不允许出现"删了但查不到谁删的"、"记了审计但没删掉"
        const changed = extras.note.softDelete(note.id, deletedAt, { sessionId });
        if (!changed) return false;
        extras.audit.insert({
          action: AUDIT_ACTION.forget,
          target: `note:${note.id}`,
          detail: {
            reason,
            about: note.about,
            preview: excerpt(note.content, 80),
            at: note.at,
            deletedAt,
          },
          at: deletedAt,
        });
        return true;
      }),
    false,
  );

  if (!done) {
    return {
      ok: false,
      action: 'error',
      id: note.id,
      text: [
        `#${note.id} 没删成（它不是已删状态就是写库出错了），它还在你的笔记里。`,
        '要不要我过一会儿再试一次？',
      ].join('\n'),
    };
  }

  // 编号撞车要说破：不让TA以为聊过的话被删掉了（只在本会话里查，A1）
  const collision = msgInSession(repo, note.id, sessionId);

  return {
    ok: true,
    action: 'forget',
    id: note.id,
    text: [
      `忘了。#${note.id} 进了回收站，30 天内还能捡回来。`,
      '',
      `「${excerpt(note.content, 80)}」`,
      '',
      `记于 ${formatWhen(note.at, now)}${aboutSuffix(note.about)}`,
      reason ? `删除原因已记进审计：${reason}` : '',
      purged > 0 ? `（顺手清掉了 ${purged} 条超过 30 天的旧笔记）` : '',
      collision
        ? `注：对话里也有编号 #${note.id} 的一句原文，我没动它——删的只是你自己记的那条笔记。`
        : '',
      `想反悔就说「把 #${note.id} 恢复」。`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** about 值 → 文案里的说法；没标就返回 null（不硬凑一句「关于没标」）。
 *  枚举与标签统一从 format.js 取，别在这里再写一份（漂移会让同一条笔记有两种人称）。 */
function aboutWord(about) {
  return noteAboutWord(about);
}

/** ` · 关于他`，没标 about 时返回空串 */
function aboutSuffix(about) {
  const word = aboutWord(about);
  return word ? ` · 关于${word}` : '';
}

/** 出错就别让整个工具挂掉：读失败按"没有"处理，写失败由调用方看返回值 */
function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * 拒绝删除 msg 的文案（D-167：标记 + 查 + 重建，不是删）。
 * 这是整个工具最重要的一段话——必须让TA明白"为什么不能删"，否则TA会反复试。
 *
 * @param {object|null} msg 命中的消息行（可能有）
 * @param {{kind: string, id: number}} ref
 * @param {number} now
 */
function buildMsgRefusal(msg, ref, now) {
  const lines = [
    '这条不能删。它是你们说过的话的原文，是唯一的事实来源。',
    '如果觉得记错了，可以请用户在面板「核对」页标记后再查日志核实。',
  ];
  if (msg) {
    lines.push('');
    lines.push(`${msgLine(msg)}`);
    lines.push(`（${formatWhen(msg.at, now)}）`);
    lines.push('');
    lines.push('原文删了就没有第二份了——「一句不丢」是这个记忆的地基。');
  } else {
    lines.push('');
    lines.push(`#${ref.id} 这个编号在对话原文里也没找到，但我还是不会替你猜着删。`);
  }
  lines.push('');
  lines.push('（真要删的是你自己记的笔记，把笔记的编号给我。）');
  return lines.join('\n');
}

/* ============================== 工具封装 ============================== */

/**
 * 造一个绑定好依赖的 memory_forget 工具。
 *
 * 参数只留 3 个（D-095：每个工具 ≤4 参数且带默认值）：
 *   id（必填）· reason（可写进审计）· restore（从回收站捡回来）
 *
 * @param {object} [deps] 形如 `{ handle }` / `{ repo, extras }` / `{ dbPath }`
 */
export function createForgetTool(deps = {}) {
  return {
    name: 'memory_forget',
    description:
      '忘掉一条你自己记的笔记（进回收站，30 天内还能恢复），或者把之前删掉的笔记捡回来。' +
      '注意：这里只删「你自己记的」东西。你们说过的话的原文一条都删不了——' +
      '原文是唯一事实来源不能删除；如果觉得记错了，可以请用户在面板「核对」页标记后再查日志核实。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: ['integer', 'string'],
          description:
            '要处理的笔记编号，就是你记完拿到的那个数字（比如 12）。' +
            '对话里的原话要写成 msg:12——那种是删不掉的。',
        },
        reason: {
          type: 'string',
          description: '想删的原因，会记进审计（可以不填）。',
        },
        restore: {
          type: 'boolean',
          description: '填 true 表示「把这条从回收站捡回来」，而不是删除。默认 false。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    /**
     * @param {{id?: number|string, reason?: string, restore?: boolean}} args
     * @param {object} [ctx]
     * @returns {Promise<string>} 纯文本，不返回 JSON（D-095）
     */
    async handler(args = {}, ctx = {}) {
      const result = await forgetNote(args, { ...deps, ...ctx });
      return result.text;
    },
  };
}

/** 默认工具实例（不绑依赖，第一次调用时才开默认库） */
export const memoryForgetTool = createForgetTool();

/* ============================== 30 天清理 ============================== */

/**
 * 清理回收站：物理删掉软删超过 30 天的笔记，返回清理条数。
 *
 * 谁来调：面板「回收站」打开时、或 T8 的每日维护；`memory_forget` 每次操作前
 * 也会顺手扫一遍（best-effort）。不清理也不影响"已删的看不到"，
 * 只是那些行会一直占着库——所以必须有个显式入口。
 *
 * @param {object} [ctx] 见 resolveStore
 * @param {{now?: number, retentionMs?: number}} [opts]
 * @returns {number} 清理条数
 */
export function purgeExpiredNotes(ctx = {}, opts = {}) {
  const store = resolveStore(ctx);
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const retentionMs = Number.isFinite(Number(opts.retentionMs)) ? Number(opts.retentionMs) : NOTE_RETENTION_MS;
  const sessionId = resolveSessionId({}, ctx);
  return Number(store.extras.note.purgeExpired(retentionMs, now, { sessionId })) || 0;
}

export default memoryForgetTool;
