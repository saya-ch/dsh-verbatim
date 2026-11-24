-- ============================================================================
-- dsh-verbatim（逐字记忆）—— 完整 DDL
--
-- 口径来源：IMPLEMENTATION.md §5（第一批 DDL）+ BUILD-PLAN.md §4.4 / §4.6（第二批补充）
-- 冲突时以 IMPLEMENTATION.md §5 为准（它已含 D-141/142/143 修正）。
--
-- 幂等：全库只用 CREATE ... IF NOT EXISTS，重复执行安全。db.js 每次打开都会跑一遍。
--
-- 文件分两段：
--   ① 基础段（本段）：不依赖任何扩展，加载 sqlite-vec 失败也照建。
--   ② vec 段（文末 @@vec-begin / @@vec-end 之间）：依赖 vec0 模块。
--      db.js 会按注释标记切分，sqlite-vec 加载失败时整段跳过（D-149 降级路径）。
--      vec0 是虚拟表，CREATE VIRTUAL TABLE 不支持依赖缺失时静默失败，
--      所以必须靠切分跳过，光加 IF NOT EXISTS 不够。
-- ============================================================================

PRAGMA journal_mode = WAL;      -- 单文件备份；并发读不阻塞
PRAGMA foreign_keys = ON;       -- beat / media 靠 ON DELETE CASCADE 跟着 msg 物理删
PRAGMA busy_timeout = 5000;     -- 面板与工具可能同时开库

-- ---------------------------------------------------------------------------
-- ② 场景：一段对话
--
-- 注意建表顺序：msg 有 scene_id 外键指向 scene，所以 scene 必须先建。
-- SQLite 允许前向引用（建表时不校验父表），但一旦 foreign_keys=ON，
-- 先建 msg 再插数据会报 "no such table: main.scene"。
--
-- **AUTOINCREMENT（v5 起，D-118 的直接后果）**：
-- 没有它时 SQLite 会复用被删行的 rowid。rewind 物理删掉 #3 之后，
-- 下一条新消息就会拿到 id=3 —— 而向量索引里 #3 的旧向量还躺着，
-- 于是一条被撤回的话会被算到一条无关的新消息头上（实测 score=1.0000）。
-- 撤回失效比忘记可怕，所以这里从库结构上堵死：id 永不复用。
-- 代价只是 id 会一直增长，不影响任何逻辑（没有地方假设 id 连续）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scene (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL,
  start_at      INTEGER NOT NULL,          -- epoch ms
  end_at        INTEGER NOT NULL,          -- epoch ms
  msg_count     INTEGER NOT NULL,          -- 消息条数（对人输出按「轮」说，D-197）
  -- T3 算出来的派生字段（D-195）：落库而不是每次让消费者自己算，口径才一致。
  -- 迁移：v3 → v4 由 db.js 的 migrate() 逐列 ALTER 补上。
  has_excluded        INTEGER NOT NULL DEFAULT 0,  -- 本场是否含被软排除的消息
  excluded_count      INTEGER NOT NULL DEFAULT 0,  -- 含几条
  has_out_of_surface  INTEGER NOT NULL DEFAULT 0,  -- 本场是否含 in_surface=0（被压缩）的消息
  out_of_surface_count INTEGER NOT NULL DEFAULT 0, -- 含几条
  crosses_compaction  INTEGER NOT NULL DEFAULT 0,  -- 是否跨压缩点（切分硬条件之一）
  compacted_count     INTEGER NOT NULL DEFAULT 0,  -- 本场被压缩过的条数
  gap_before_ms INTEGER,                   -- 与上一场的间隔
  gap_after_ms  INTEGER,                   -- 与下一场的间隔
  preceded_by   INTEGER REFERENCES scene(id),
  followed_by   INTEGER REFERENCES scene(id),
  lead_in       TEXT,                      -- JSON：前一场尾巴 2 条原文（只存原文，D-100）
  gist          TEXT,                      -- 仅供检索，永不注入（D-035）
  gist_source   TEXT,                      -- 'extractive' | 'llm' | NULL
  locked        INTEGER NOT NULL DEFAULT 0, -- 人工合并/拆分后置 1，避免增量同步误改
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scene_time ON scene(session_id, start_at);

-- ---------------------------------------------------------------------------
-- ① 消息原文：唯一的事实来源
--
-- 与 IMPLEMENTATION.md §5 相比新增的列：
--   vec_model / vec_dim —— D-152 校验用。索引时记下"这些向量是谁算的、多少维"，
--   查询前比对，模型不一致就拒绝查询并提示重建（不同模型向量空间不可比，
--   混算不报错但结果无意义，这是最危险的静默 bug）。
--   excluded —— D-169/170 软排除：入库、可逆、检索默认跳过（WHERE excluded = 0）。
--   已有库由 db.js 的 migrate() 走 ALTER TABLE 补列（见 MIGRATIONS）。
--
-- id 用 AUTOINCREMENT（v5 起）：理由见上面 scene 表的注释 —— 被 rewind 删掉的
-- msg id 绝不能被复用，否则向量表里的旧向量会认到一条新消息上（D-118）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS msg (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL,
  seq          INTEGER NOT NULL,
  at           INTEGER NOT NULL,             -- epoch ms
  speaker      TEXT    NOT NULL CHECK (speaker IN ('user','assistant')),
  text         TEXT    NOT NULL,             -- 原文，一字不改（D-050）
  in_surface   INTEGER NOT NULL DEFAULT 1,   -- 1 = 当前上下文可见
  compacted_at INTEGER,                      -- 被压缩的时间戳，NULL = 没被压过（D-142）
  excluded     INTEGER NOT NULL DEFAULT 0,   -- 1 = 软排除：入库存着但检索不到（D-169/170，可逆）
  scene_id     INTEGER REFERENCES scene(id),
  vec_model    TEXT,                         -- 向量模型 id，如 sf:Qwen/Qwen3-Embedding-4B@1024
  vec_dim      INTEGER,                      -- 向量维度，如 1024（D-144）
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_msg_at        ON msg(at);
CREATE INDEX IF NOT EXISTS idx_msg_scene     ON msg(scene_id, seq);
CREATE INDEX IF NOT EXISTS idx_msg_surface   ON msg(in_surface, at);
-- 时间路按会话 + 区间扫；UNIQUE(session_id, seq) 的索引不能替代 at 区间
CREATE INDEX IF NOT EXISTS idx_msg_sess_at   ON msg(session_id, at);
-- 排除是少数派（11-08 一整天），默认检索要 skip 掉它们
CREATE INDEX IF NOT EXISTS idx_msg_excluded  ON msg(excluded, at);

-- ---------------------------------------------------------------------------
-- ③ 互动类型：发展通道（第二批填充）
-- 12 类，一条消息可属多类，分开存（D-104）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beat (
  id         INTEGER PRIMARY KEY,
  msg_id     INTEGER NOT NULL REFERENCES msg(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  confidence REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beat_kind ON beat(kind, msg_id);

-- ---------------------------------------------------------------------------
-- ④ 事实：必须能指回原话（source_seq 必须指向真实 msg.seq，且 speaker='user'）
-- 结构化校验（sourceSeq 存在 / speaker=user / inSurface=1 / key≤20 / value≤80）
-- 由 T5 的 fact 提炼层负责，这里只保证字段先到位。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact (
  id          INTEGER PRIMARY KEY,
  subject     TEXT    NOT NULL CHECK (subject IN ('me','her','us')),
  key         TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  source_kind TEXT    NOT NULL DEFAULT 'msg' CHECK (source_kind IN ('msg','scene')),
  source_seq  INTEGER NOT NULL,              -- 必须指向真实 msg.seq
  origin      TEXT    NOT NULL,              -- extracted_from_user | user_confirmed | her_claim
  created_at  INTEGER NOT NULL,
  session_id  TEXT                           -- 归属会话（v16 起，NULL = 遗留无归属）
);
CREATE INDEX IF NOT EXISTS idx_fact_subject ON fact(subject, key);
CREATE INDEX IF NOT EXISTS idx_fact_session ON fact(session_id, subject, created_at);

-- ---------------------------------------------------------------------------
-- ⑤ 媒体：只记位置
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY,
  msg_id     INTEGER NOT NULL REFERENCES msg(id) ON DELETE CASCADE,
  path       TEXT    NOT NULL,
  sha256     TEXT,
  width      INTEGER,
  height     INTEGER,
  caption    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_msg ON media(msg_id);

-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ⑦ TA自己的笔记：memory_remember 的落点（BUILD-PLAN §4.6）
--
-- 为什么单独建表而不写进 msg：TA的话不是"对话"，混进 msg 会污染检索和 fact 提炼
-- （fact 只认 speaker='user'，但检索会把TA的笔记当原话返回）。
-- 软删（deleted_at），30 天内可恢复；msg 原文永远不允许删（唯一事实来源）。
-- ---------------------------------------------------------------------------
-- session_id（v6 起，A1 会话隔离）：
--   note 是「TA自己记的」，也属于某一段关系/某一个会话。没有这一列时，
--   memory_remember 写进去的笔记会被**所有会话**的 memory_search / memory_forget 看见，
--   等于TA可以在 A 会话里翻到、甚至删掉 B 会话里写的笔记。
--   列放在最后（而不是 id 后面）是为了让「新库 CREATE TABLE」与
--   「老库 ALTER TABLE ADD COLUMN」得到完全相同的列顺序。
--   NULL = v5 及更早的遗留笔记（那时还没有归属概念）；迁移 v5→v6 会在
--   「库里只有一个会话」时自动回填，多会话时保持 NULL 并记 warning（见 db.js）。
CREATE TABLE IF NOT EXISTS note (
  id         INTEGER PRIMARY KEY,
  content    TEXT    NOT NULL,
  about      TEXT,                -- me | him | us（Agent 视角，可空，由工具层校验取值）
  at         INTEGER NOT NULL,
  deleted_at INTEGER,
  session_id TEXT                 -- 归属会话；NULL = 遗留/未归属
);
CREATE INDEX IF NOT EXISTS idx_note_at      ON note(at);
CREATE INDEX IF NOT EXISTS idx_note_deleted ON note(deleted_at, at);
-- 按会话列笔记（面板「TA的笔记」与 memory_search scope=note 都走这条）
CREATE INDEX IF NOT EXISTS idx_note_session ON note(session_id, at);

-- ---------------------------------------------------------------------------
-- ⑧ 操作审计：每次 remember / forget / restore / rebuild 留痕
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY,
  action TEXT    NOT NULL,        -- remember | forget | restore | rebuild
  target TEXT    NOT NULL,        -- note:123
  detail TEXT,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit(target, at);
CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit(at);

-- ---------------------------------------------------------------------------
-- ⑧.5 标记：核对页"这条有问题"只记一笔（D-167/168）
--
-- 硬语义：flag **不影响检索、不删任何东西**（msg 是唯一事实来源，单条删除会破坏"一句不丢"）。
-- 同一 msg_id 允许多条标记（不同人不同时提出），list 按 at 倒序。
-- 与 excluded 的区别：excluded 是"整段不看"（检索过滤），flag 是"某条可疑"（只留痕）。
-- resolved_at 为 NULL = 未取消标记。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flag (
  id          INTEGER PRIMARY KEY,
  msg_id      INTEGER NOT NULL REFERENCES msg(id) ON DELETE CASCADE,
  reason      TEXT,
  at          INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flag_msg  ON flag(msg_id);
CREATE INDEX IF NOT EXISTS idx_flag_open ON flag(resolved_at, at);

-- ---------------------------------------------------------------------------
-- ⑨ 全文索引：trigram 对中文有效，但只匹配 ≥ 3 个字符（2 字查询走 LIKE 兜底）
-- content='msg' 是 external content 表：索引数据不重复存正文，体积小
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  text,
  content='msg',
  content_rowid='id',
  tokenize='trigram'
);

-- 触发器保持同步：insert / delete / update 三个方向都要，否则 FTS 会与 msg 漂移。
--
-- 注意 update 触发器带了 `OF text` 限定：只有正文变了才重建 FTS。
-- 文档里的通用 AFTER UPDATE 会在改 in_surface / scene_id 时也重写一遍索引 ——
-- 回填压缩标记、把 7,572 条消息挂到场景上时，那是上万次无意义的 FTS 重写。
CREATE TRIGGER IF NOT EXISTS msg_ai AFTER INSERT ON msg BEGIN
  INSERT INTO msg_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS msg_ad AFTER DELETE ON msg BEGIN
  INSERT INTO msg_fts(msg_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS msg_au AFTER UPDATE OF text ON msg BEGIN
  INSERT INTO msg_fts(msg_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO msg_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ============================================================================
-- 向量索引段（BUILD-PLAN §4.4 / IMPLEMENTATION.md §1）
--
-- 只有 sqlite-vec 扩展加载成功时 db.js 才会执行本段；失败则整段跳过，
-- 上层退回暴力余弦（7,572 条 30 MB / 10.8 ms，功能等价，接口不变）。
--
-- 两个坑（D-149）：
--   ① 必须 new DatabaseSync(path, { allowExtension: true })
--   ② 主键必须传 BigInt，传 Number 报 "Only integers are allows for primary key values"
-- 维度 1024（D-144）：不是 2560，2560 一年后 488 MB / 188 ms 不可接受。
--
-- 两个入口各自独立索引（D-039）：msg 原文一路、scene.gist 一路。
-- ---------------------------------------------------------------------------
-- ⑨ 长文本分片映射（D-247）
--
-- 只对**超长消息**用：一条 7301 字的消息，截断到 2000 字嵌入的话，
-- 后 5300 字永远搜不到 —— 这是静默的信息丢失。
--
-- 分片的向量存在向量段的一张虚拟表里（rowid = chunk.id），基础段只建映射表。
-- 短消息（< CHUNK_MIN_CHARS）仍然一条一个向量，不经过这张表。
--
-- msg_id 级联删除：原文被 rewind 物理删掉时，它的分片一起消失。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunk (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id     INTEGER NOT NULL REFERENCES msg(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,              -- 第几片（0 起）
  start_char INTEGER NOT NULL,              -- 在原文里的起止位置，用来回显命中段
  end_char   INTEGER NOT NULL,
  UNIQUE (msg_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_chunk_msg ON chunk(msg_id);

-- ---------------------------------------------------------------------------
-- ⑩ 场景内滑动对话窗（Window）：把连续短消息聚合成有重叠的完整语义段，
--    解决「一件事跨多句说出」与「多词跨句检索」；长消息（>=400 字）不入窗，
--    保留单条消息向量与超长分片向量的完整泛用性。
--    scene_id 级联删除：重切场景时旧窗口自动清理（对应向量由代码同事务清）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS window (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL,
  scene_id     INTEGER NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'window', -- 'window' | 'exchange' | 'thread'
  start_msg_id INTEGER NOT NULL,
  end_msg_id   INTEGER NOT NULL,
  start_at     INTEGER NOT NULL,
  end_at       INTEGER NOT NULL,
  msg_count    INTEGER NOT NULL,
  text         TEXT    NOT NULL,
  vec_model    TEXT,
  vec_dim      INTEGER,
  UNIQUE (scene_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_window_session_time ON window(session_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_window_scene        ON window(scene_id);
CREATE INDEX IF NOT EXISTS idx_window_vec          ON window(session_id, vec_model);

-- v14：删除 window_fts（连同 3 个同步触发器）。
--
-- 曾经的假设是「用 FTS5 在窗口上做跨句多词检索」，实测证明这条路在中文上不成立：
--   ① trigram 分词器只索引长度 ≥3 的连续串 → 「妈妈」「歌单」「锁屏」这类 2 字词
--      **根本不进索引**（window_fts 与 msg_fts 对它们都是 0 命中）
--   ② 中文查询按标点切词后往往只剩 1~2 个「整句」，FTS `A AND B` 要求整句同窗出现，
--      在四个样本 778 条多词查询上命中率是 0.0%
-- 现行实现改为 `window.text LIKE '%词%'` 的 OR 召回 + 「至少命中 N 个不同词」过滤
-- （见 repo.js 的 window.searchKeyword），召回率提升到 3.9%~37.1%，不需要 FTS。
-- 留着这张表只会让**每次窗口写入多 3 次触发器开销**，且永远不被读。
-- 老库由 db.js 的 v13→v14 迁移 DROP。

-- ============================================================================
-- @@vec-begin
CREATE VIRTUAL TABLE IF NOT EXISTS vec_msg USING vec0(
  msg_id INTEGER PRIMARY KEY,
  emb    float[1024]
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_scene USING vec0(
  scene_id INTEGER PRIMARY KEY,
  emb      float[1024]
);

-- 长文本分片向量（D-247）：rowid = chunk.id
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunk USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  emb      float[1024]
);

-- 笔记向量：rowid = note.id（用于 note 参与语义检索与高权重置顶召回）
CREATE VIRTUAL TABLE IF NOT EXISTS vec_note USING vec0(
  note_id INTEGER PRIMARY KEY,
  emb     float[1024]
);

-- 场景内滑动对话窗向量：rowid = window.id
CREATE VIRTUAL TABLE IF NOT EXISTS vec_window USING vec0(
  window_id INTEGER PRIMARY KEY,
  emb       float[1024]
);
-- @@vec-end
