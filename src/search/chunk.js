/**
 * 长文本分片 —— 只对「超长消息」用。
 *
 * 为什么需要：embedding 的上下文窗口有限，我们模型下来还要截断到 2000 字。
 * 一条 7301 字的消息，后半段永远搜不到 —— 这是静默的信息丢失。
 *
 * 但**绝大多数消息都不需要切**（作者 2026-11-18 的观察，实测印证）：
 *   QQ 真实聊天   消息中位数 12 字，最大 1685 字，**0 条超 2000**
 *   技术会话      消息中位数 337 字，最大 7301 字，87 条超 2000（1.2%）
 * 所以默认路径仍是一条消息一个向量，只有超过 CHUNK_MIN_CHARS 才切。
 *
 * 切分原则（"合理"体现在这里）：
 *   ① **按句子边界切**，不按字符硬切 —— 硬切会把半句话拆开，语义碎掉
 *   ② **相邻片重叠** —— 一句话横跨边界时，两边都能看到它
 *   ③ 片太大不好（语义发散），太小也不好（上下文不足）→ 目标 400 字
 *   ④ 切完如果只有 1 片，说明白切了 → 退回整条
 */

/** 低于这个字数不切（一条消息一个向量，走原路径） */
export const CHUNK_MIN_CHARS = 800;

/** 每片目标字数 */
export const CHUNK_TARGET_CHARS = 400;

/** 相邻片重叠字数 */
export const CHUNK_OVERLAP_CHARS = 80;

/**
 * 切句：中文句末标点 + 换行。
 * 注意保留标点本身（否则显示时会丢掉句号）。
 */
const SENTENCE_RE = /[^。！？!?\n]+[。！？!?\n]*/gu;

/**
 * 把文本切成句子数组，并记录每句在原文里的起止位置。
 * @param {string} text
 * @returns {{text: string, start: number, end: number}[]}
 */
export function splitSentences(text) {
  const out = [];
  const src = String(text ?? '');
  SENTENCE_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_RE.exec(src)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  // 正则没覆盖到的尾巴（比如纯空白）忽略即可
  return out;
}

/**
 * 切分长文本。
 *
 * @param {string} text
 * @param {{min?: number, target?: number, overlap?: number}} [opts]
 * @returns {{text: string, start: number, end: number, index: number}[] | null}
 *   不需要切（太短）时返回 null —— 调用方按"一条消息一个向量"处理。
 */
export function splitIntoChunks(text, opts = {}) {
  const src = String(text ?? '');
  const min = opts.min ?? CHUNK_MIN_CHARS;
  const target = opts.target ?? CHUNK_TARGET_CHARS;
  const overlap = opts.overlap ?? CHUNK_OVERLAP_CHARS;

  if (src.length < min) return null;

  const sentences = splitSentences(src);
  // 切不出句子（比如一整段没有标点）→ 按固定长度硬切，总比丢掉好
  if (sentences.length === 0) {
    const chunks = [];
    for (let i = 0, idx = 0; i < src.length; i += target - overlap, idx++) {
      chunks.push({
        text: src.slice(i, i + target),
        start: i,
        end: Math.min(src.length, i + target),
        index: idx,
      });
      if (i + target >= src.length) break;
    }
    return chunks.length > 1 ? chunks : null;
  }

  /** @type {{text: string, start: number, end: number, index: number}[]} */
  const chunks = [];
  let buf = '';
  let bufStart = 0;

  const flush = () => {
    if (buf.trim() === '') return;
    chunks.push({
      text: buf,
      start: bufStart,
      end: bufStart + buf.length,
      index: chunks.length,
    });
  };

  for (const s of sentences) {
    // 超长单句：自己就超过 target，先 flush 再硬切
    if (s.text.length > target && buf.trim() === '') {
      let off = s.start;
      while (off < s.end) {
        const slice = src.slice(off, off + target);
        chunks.push({ text: slice, start: off, end: off + slice.length, index: chunks.length });
        if (off + target >= s.end) break;
        off += target - overlap;
      }
      buf = '';
      bufStart = s.end;
      continue;
    }

    // 加进来会超 → 先 flush，再从上一片尾部留 overlap 作为新片开头
    if (buf.length > 0 && buf.length + s.text.length > target) {
      flush();
      // **重叠也要对齐句子边界**：不能在任意字符处截，否则新片开头是半句话
      const from = Math.max(0, buf.length - overlap);
      const boundary = buf.slice(from).search(/[。！？!?\n]/u);
      const cut = boundary >= 0 ? from + boundary + 1 : from;
      const tail = buf.slice(cut);
      bufStart = bufStart + cut;
      buf = tail;
    } else if (buf.length === 0) {
      bufStart = s.start;
    }
    buf += s.text;
  }
  flush();

  // 只切出一片 = 没省到事，退回整条（保持"一条消息一个向量"的统一语义）
  if (chunks.length <= 1) return null;
  return chunks;
}

/**
 * 这条消息要不要切（解码前的快速判断，给 indexer 用）。
 * @param {string} text
 * @param {number} [min]
 */
export function shouldChunk(text, min = CHUNK_MIN_CHARS) {
  return String(text ?? '').length >= min;
}

/** 分片上下文头最大长度 */
export const CHUNK_HEADER_CHARS = 100;

/**
 * 扫描原文从开头到 startChar 之前的结构状态（最近 Markdown 标题 + 当前活跃表格表头）。
 * 零 LLM、O(N) 单遍扫描。
 *
 * @param {string} msgText
 * @param {number} startChar
 * @returns {{ heading: string|null, tableHeader: string|null }}
 */
export function extractChunkStructure(msgText, startChar) {
  const pos = Number(startChar);
  if (!Number.isFinite(pos) || pos <= 0) return { heading: null, tableHeader: null };
  const before = String(msgText ?? '').slice(0, pos);
  const lines = before.split('\n');
  let inCode = false;
  let heading = null;
  let tableHeader = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      tableHeader = null;
      continue;
    }
    if (inCode) continue;

    if (/^#{1,4}\s+\S/.test(trimmed)) {
      heading = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
      tableHeader = null;
      continue;
    }

    // 检测 Markdown 表格：当前行像 `| a | b |`，下一行像 `|---|---|`
    if (
      trimmed.startsWith('|')
      && i + 1 < lines.length
      && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
    ) {
      tableHeader = `${trimmed}\n${lines[i + 1].trim()}`;
      i += 1; // 跳过分隔行
      continue;
    }

    // 非空且不是表格行 → 离开表格作用域
    if (trimmed && !trimmed.startsWith('|')) {
      tableHeader = null;
    }
  }
  return { heading, tableHeader };
}

/**
 * 为长消息分片拼接轻量结构头（第 0 片不加；idx > 0 时仅拼上所属章节标题与跨片表格表头，
 * 不拼原消息首行以免同一长消息的所有分片在向量空间撞车）。
 * 只用于向量嵌入与 Rerank 打分，绝不改变返回给 Agent 的原文分片展示。
 *
 * @param {string} msgText 原消息全文
 * @param {string} chunkText 当前分片文本
 * @param {number} idx 分片序号（0-based）
 * @param {number} [startChar] 分片在原文中的起始偏移（用于提取所属标题与活跃表格表头）
 * @returns {string}
 */
export function formatChunkWithContext(msgText, chunkText, idx, startChar = 0) {
  const slice = String(chunkText ?? '');
  if (!Number.isFinite(Number(idx)) || Number(idx) <= 0) return slice;
  const full = String(msgText ?? '');
  if (!full.trim()) return slice;

  const { heading, tableHeader } = extractChunkStructure(full, startChar);
  const prefixes = [];
  if (heading && !slice.startsWith('#')) {
    prefixes.push(`[章节: ${heading}]`);
  }
  if (tableHeader && !slice.includes(tableHeader.split('\n')[0])) {
    prefixes.push(tableHeader);
  }
  if (prefixes.length === 0) return slice;
  return `${prefixes.join('\n')}\n${slice}`;
}
