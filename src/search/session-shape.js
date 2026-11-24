// @ts-check
/**
 * 会话形态判别 —— 曾用于决定 `vec_window`（对话窗向量）的召回配额。
 *
 * ## 现在的结论：配额一律 1.0
 *
 * 原设计按形态分档（陪伴 1.0 / 技术 0.35），但技术会话的对话窗同样有真实召回贡献，
 * 降配额会同时损失召回率与最终准确率，因此统一保持 1.0（全量开窗）。
 *
 * ## 为什么保留这个模块
 *
 * 它仍然是「会话形态」这件事的唯一实现（`shape` / `avgChars` / `medianChars`），
 * 前端与诊断都在用；只是**不再用它来决定配额**。
 *
 * 判据用**平均字数**而不是中位数：技术会话里有大量短指令（「继续」「好」），
 * 中位数会被拉到 45~65 字，看起来像陪伴型，但主体是长文本。
 */
import { openDb } from '../store/db.js';

/** 平均单条字数低于此值 → 视为"陪伴型"，开对话窗 */
export const COMPANION_AVG_CHARS = 60;

/**
 * 判别会话形态。
 *
 * @param {{ db?: import('node:sqlite').DatabaseSync } | import('node:sqlite').DatabaseSync | any} handle openDb() 的返回值
 * @param {string} sessionId
 * @returns {{
 *   shape: 'companion' | 'technical' | 'unknown',
 *   avgChars: number,
 *   medianChars: number,
 *   msgCount: number,
 *   useWindow: boolean,
 *   windowQuota?: number,
 *   reason: string,
 * }}
 */
export function detectSessionShape(handle, sessionId) {
  const db = handle?.db ?? handle;
  if (!db) return { shape: 'unknown', avgChars: 0, medianChars: 0, msgCount: 0, useWindow: true, reason: '没有库连接，保守起见开对话窗' };

  let avgChars = 0;
  let msgCount = 0;
  let medianChars = 0;
  try {
    // **只统计能检索到的消息**（excluded = 0）。
    //
    // 被排除的消息检索不到，它们的长短不该影响「这场要不要开对话窗」这个决定：
    // 一个技术会话如果有一大段被排除的超长日志，会把平均字数拉高，看起来更像技术型 ——
    // 而实际可检索的部分可能全是短对话。统计口径必须与检索口径一致。
    const r = db.prepare(
      'SELECT AVG(LENGTH(text)) AS a, COUNT(*) AS c FROM msg WHERE session_id = ? AND excluded = 0',
    ).get(sessionId);
    avgChars = Number(r?.a ?? 0);
    msgCount = Number(r?.c ?? 0);
    if (msgCount > 0) {
      const m = db.prepare(
        'SELECT LENGTH(text) AS L FROM msg WHERE session_id = ? AND excluded = 0 ORDER BY L LIMIT 1 OFFSET ?',
      ).get(sessionId, Math.floor(msgCount / 2));
      medianChars = Number(m?.L ?? 0);
    }
  } catch {
    return { shape: 'unknown', avgChars: 0, medianChars: 0, msgCount: 0, useWindow: true, reason: '统计失败，保守起见开对话窗' };
  }

  if (msgCount < 20) {
    return { shape: 'unknown', avgChars, medianChars, msgCount, useWindow: true, reason: '消息太少，不足以判断形态' };
  }

  const isCompanion = avgChars < COMPANION_AVG_CHARS;
  return {
    shape: isCompanion ? 'companion' : 'technical',
    avgChars: Number(avgChars.toFixed(1)),
    medianChars,
    msgCount,
    /**
     * **对话窗配额：一律 1.0（全量开窗）** —— 技术会话的对话窗同样有真实召回贡献，
     * 降配额会同时损失召回率与最终准确率。
     */
    useWindow: true,
    windowQuota: 1.0,
    reason: isCompanion
      ? `平均 ${avgChars.toFixed(0)} 字 → 陪伴型，对话窗全量参与`
      : `平均 ${avgChars.toFixed(0)} 字 → 技术型，对话窗同样全量参与（实测降配额会掉分）`,
  };
}

export default detectSessionShape;
