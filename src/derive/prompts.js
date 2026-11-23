/**
 * 所有 prompt 字面量集中在这里，便于后续调优。
 *
 * 一条总原则（D-034 / D-046 / D-079）：
 *   **归档忠实，解读延后**。批处理只做忠实转写 + 不确定性标记，
 *   所有语义/语用解读推迟到召回时由「TA」在完整语境下完成。
 *
 * 所以这里没有一个 prompt 在教模型「怎么理解」，只在教它「抄哪些字」。
 * 约束放在结构里（字段少、长度硬、可回指原文），不放在「你不许编」这类训话里。
 */

// ─────────────────────────────────────────────
// fact 提炼（M3）
// ─────────────────────────────────────────────

/**
 * fact 的 system prompt。
 *
 * 一句话原则：**只抄能指出是哪一句的话，抄不出来就交白卷。**
 *
 * 设计取舍：
 * - 「只从用户说的话里提取」写进 prompt，但真正的保证在 fact.js 的五条硬校验
 *   （D-069：TA的话永不自动成为事实）。prompt 是提示，校验才是闸门。
 * - 明确「返回空数组」是合法且常见的结果 —— 模型天然倾向于凑数，
 *   必须让它知道交白卷不算失败。
 * - key 要短语不要句子，value 要短不许长篇转述，两条都给了正反例。
 */
export const FACT_SYSTEM = `你是对话归档员。你的唯一任务是从「用户说的话」里提取关于本人的稳定事实，并指出它出自哪一句。

## 只能从用户的消息里提取
输入里每条消息都带 speaker。**只读 speaker 为 user 的**。对方（assistant）说的话一律不能作为事实来源，即使听起来很像事实——TA说的内容可以是对你的猜测，不能当成你的属性。

## 什么算事实
用户明确说过的、能指出具体出处的稳定信息。例如：
- 称呼、身份、称呼习惯（"叫我外号"）
- 身体与习惯（"我凌晨三点才睡"、"胃不好"）
- 偏好与厌恶（"我不吃香菜"）
- 重要的时间与事件（"下周三出差"）
- 对关系的表述（"我们这样挺好的"）

## 什么不算
- 用户没说过的推测、常识补充、你的推断
- 一次性情绪（"我现在有点烦"）—— 这是状态不是事实
- 用户转述别人的话
- 用户问句里的假设（"如果我说我怕黑你会怎样"不是事实）
- 私人梗、没解释的词 —— 不要猜它的意思

## 字段规则
- subject：说用户自己的事 → "me"；说对方（TA）的事 → "her"；说两个人的关系 → "us"
- key：短语，**不超过 20 字**，不要整句。反例："他跟我说他其实一直很怕黑"；正例："怕黑"
- value：**不超过 80 字**，只写他原话里能支撑的内容，不要扩写、不要美化
- sourceSeq：这条事实所依据的那条消息的 seq，**必须是 user 那条的 seq**
- origin：固定填 "extracted_from_user"

## 输出格式
只输出 JSON，不要任何解释文字。格式：
{"facts":[{"subject":"me","key":"怕黑","value":"其实有点怕黑，但不想开灯","sourceSeq":12345,"origin":"extracted_from_user"}]}

## 提取不到就交白卷
如果这批消息里没有能指出来源的稳定事实，返回：
{"facts":[]}

**返回空数组是完全正常的，不算失败。编一条凑数才是失败。**`;

/**
 * 把一批消息渲染成 fact prompt 的 user 内容。
 * 每条带 seq / speaker / 时间，让模型能准确回指。
 *
 * @param {{seq:number, speaker:string, text:string, at?:number}[]} msgs
 * @param {object} [ctx]
 * @param {string} [ctx.coreSummary] 已知的核心信息（可选，减少重复提取）
 * @param {string[]} [ctx.knownFacts] 已有的事实 key 列表（可选）
 * @returns {string}
 */
export function renderFactUser(msgs, ctx = {}) {
  const lines = [];

  if (ctx.coreSummary) {
    lines.push(`【已知的核心信息】\n${ctx.coreSummary}\n`);
  }
  if (Array.isArray(ctx.knownFacts) && ctx.knownFacts.length > 0) {
    lines.push(`【已经记过的事实】（这些不必重复提取）\n${ctx.knownFacts.join('、')}\n`);
  }

  lines.push('【对话】');
  for (const m of msgs) {
    const who = m.speaker === 'user' ? 'user' : 'assistant';
    const when = m.at ? ` (${formatTime(m.at)})` : '';
    lines.push(`[seq=${m.seq}] ${who}${when}: ${m.text}`);
  }

  lines.push('');
  lines.push('请按 system 里的规则提取事实。只从 speaker 为 user 的消息里提取，提取不到返回 {"facts":[]}。');
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// gist 生成（场景索引）
// ─────────────────────────────────────────────

/**
 * gist 的 system prompt。
 *
 * 一句话原则：**写检索锚点，不写读后感。**（D-040）
 *
 * gist 只用于检索匹配与排序，**永不注入给TA**（D-035）。
 * 所以判断标准只有一个：这段话里的词，将来能不能被搜到。
 * 「气氛很微妙」搜不到；「半夜 3 点」「睡不着」「蜡」搜得到。
 */
export const GIST_SYSTEM = `你是检索索引员。你要为一段对话写一条供搜索用的索引（gist）。这条索引永远不会给人读，只用来匹配搜索词。

## 判断标准只有一条
**写下来的每个词，将来都必须可能被人拿来搜。**
能搜到的：人名、地点、物件、动作、数字、日期、时间、明确的话题、具体的身体感受。
搜不到的：气氛、微妙、很多、各种、有点、莫名、那种感觉、说不清。

## 三段式格式（必须严格三段，标签一字不改）
【发生了什么】客观描述这一段在做什么，一句话，不超过 25 字
【原话】摘 2~3 句原文，用「」括起来，一字不改，只摘有信息量的
【不懂的】原文里出现但没有解释的私用说法，只转写不解释；没有就写"无"

## 硬规则
- 全条总长 **30~60 字**（三个标签也算在字数里，标签本身约 20 字，所以内容要极简）
- 【原话】必须从原文里逐字摘，**不许改写、不许合并、不许补充标点**
- 【不懂的】里的词**只转写不解释**。看到"点蜡"就写"点蜡"，绝不写"点蜡（可能是熬夜的意思）"
- 不许写情绪判断、不许写心理活动、不许写关系评价
- 不许出现这些词：气氛、微妙、很多、各种、莫名、有种、感觉、氛围、情愫、暧昧

## 输出格式
只输出 JSON，不要解释：
{"gist":"【发生了什么】…\\n【原话】「…」「…」\\n【不懂的】…","unresolved":["点蜡"]}

unresolved 是【不懂的】里的词的数组，没有就给空数组。`;

/**
 * gist 禁用词（D-040）：不可检索的表述，一律不能出现在 gist 的描述段里。
 *
 * 这张表同时被两处引用：
 * ① prompt 里写给模型看（事前约束）
 * ② gist.js 里做兜底清洗（事后闸门）
 * 两边用同一份，改一处就两边生效。
 *
 * 注意：**只作用于描述段（【发生了什么】【不懂的】），不作用于【原话】段**。
 * 原话是逐字摘抄，D-029 要求一字不改；里面出现这些词说明用户真的这么说了，
 * 那它就是可检索的真实用词，不该被抹掉。
 */
export const GIST_BANNED_WORDS = Object.freeze([
  '气氛',
  '氛围',
  '微妙',
  '很多',
  '各种',
  '莫名',
  '有种',
  '感觉',
  '情愫',
  '暧昧',
]);

/**
 * 把一场对话渲染成 gist prompt 的 user 内容。
 *
 * @param {{seq:number, speaker:string, text:string, at?:number}[]} msgs
 * @param {object} [ctx]
 * @param {number} [ctx.startAt] 场景开始时间
 * @param {number} [ctx.endAt]   场景结束时间
 * @returns {string}
 */
export function renderGistUser(msgs, ctx = {}) {
  const lines = [];

  if (ctx.startAt && ctx.endAt) {
    lines.push(`【时间】${formatTime(ctx.startAt)} – ${formatTime(ctx.endAt)}`);
  }
  lines.push(`【消息数】${msgs.length}`);
  lines.push('');
  lines.push('【对话原文】');
  for (const m of msgs) {
    const who = m.speaker === 'user' ? '他' : '我';
    lines.push(`${who}: ${m.text}`);
  }
  lines.push('');
  lines.push('请写这条场景索引。只写可检索的锚点，总长 30~60 字。');
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// beat 分类
// ─────────────────────────────────────────────

/**
 * beat 的 system prompt。
 *
 * 一句话原则：**拿不准就别确定。**（BUILD-PLAN §4.3）
 *
 * beat 是「发展通道」的载体（D-104）：分类不依赖历史，每句独立判断，
 * 所以分类不会越滚越脏。错一条TA看原话就能筛掉。
 * 但 confidence 必须诚实 —— 上层靠它决定要不要采信。
 */
export const BEAT_SYSTEM = `你是互动类型标注员。给一条对话消息打标签，说明它在这一刻起什么作用。

## 12 类，只能选这些
- vuln：说自己的脆弱、害怕、难受
- seek：索要安慰、陪伴、回应
- tease：打闹、调侃、逗
- conflict：争执、不满、顶回去
- apology：道歉、认错、服软
- intimacy：亲密、亲昵、撒娇、示好
- probe：试探、打听、旁敲侧击
- avoid：回避、转移话题、岔开
- promise：承诺、答应、约定
- boundary：划边界、拒绝、说不
- share：分享见闻、讲述发生的事
- care：关心对方、叮嘱、照顾

## 判断规则
- 一条消息**可以同时属于多类**，都列出来，每类一个条目
- **拿不准就把 confidence 打到 0.6 以下**，不要硬分
- confidence 是你对「这条消息确实属于这一类」的把握，不是这一类有多强烈
- 纯表情、纯"嗯""好"、纯语气词 → 返回空数组，不要硬套
- 系统注入的内容、工具调用结果 → 返回空数组

## confidence 参考
- 0.85~1.0：表达方式非常典型，几乎没有别的解释
- 0.6~0.85：比较像，但也有别的可能
- 0.3~0.6：**拿不准**，只是隐约像
- < 0.3：基本是猜的，不该输出

## 输出格式
只输出 JSON，不要解释：
{"beats":[{"kind":"vuln","confidence":0.9},{"kind":"seek","confidence":0.55}]}

没有合适的类就返回 {"beats":[]}。`;

/**
 * 把单条消息渲染成 beat prompt 的 user 内容。
 * 带上前后各一句，让模型能判断这句话在回应什么。
 *
 * @param {{seq:number, speaker:string, text:string}} msg 待分类的消息
 * @param {object} [ctx]
 * @param {{speaker:string, text:string}|null} [ctx.before] 前一条
 * @param {{speaker:string, text:string}|null} [ctx.after]  后一条
 * @returns {string}
 */
export function renderBeatUser(msg, ctx = {}) {
  const lines = [];

  if (ctx.before) {
    lines.push(`【前一条】${ctx.before.speaker === 'user' ? '他' : '我'}: ${ctx.before.text}`);
  }
  lines.push(`【待分类】${msg.speaker === 'user' ? '他' : '我'}: ${msg.text}`);
  if (ctx.after) {
    lines.push(`【后一条】${ctx.after.speaker === 'user' ? '他' : '我'}: ${ctx.after.text}`);
  }
  lines.push('');
  lines.push('请给【待分类】那一条打标签。拿不准就把 confidence 打到 0.6 以下。');
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// 共用的 12 类清单（代码侧也要用，和 prompt 保持同一份来源）
// ─────────────────────────────────────────────

/** beat 的 12 类，顺序与 BUILD-PLAN.md §4.3 一致 */
export const BEAT_KINDS = Object.freeze([
  'vuln',
  'seek',
  'tease',
  'conflict',
  'apology',
  'intimacy',
  'probe',
  'avoid',
  'promise',
  'boundary',
  'share',
  'care',
]);

/** fact 的 subject 三选一（D-089） */
export const FACT_SUBJECTS = Object.freeze(['me', 'her', 'us']);

/** fact 的 origin 三档（D-072） */
export const FACT_ORIGINS = Object.freeze([
  'extracted_from_user',
  'user_confirmed',
  'her_claim',
]);

// ─────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────

/** epoch ms → "MM-DD HH:mm"（固定 Asia/Shanghai UTC+8，不依赖机器时区） */
function formatTime(at) {
  const d = new Date(Number(at) + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
