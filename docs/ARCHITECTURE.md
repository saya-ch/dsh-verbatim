# 系统架构说明

`dsh-verbatim` 采用「原文不可变 + 派生层可重建 + 会话强隔离」的本地记忆架构，全部数据默认存储在 `$DSH_HOME/verbatim/memory.db` 与 `$DSH_HOME/verbatim/sessions/<sessionId>.json`。

## 1. 数据分层

| 层级 | 表 / 文件 | 职责与不变式 |
|---|---|---|
| **配置真源** | `sessions/<id>.json` & `config.json` | 分别保存单会话开关（`record` / `tools` / `excludeRanges`）与全局模型/检索配置。 |
| **原文事实层** | `msg`、`media`、`msg_fts` | 按顺序留存每条消息原文与媒体引用；压缩仅标记 `in_surface = 0`，撤回执行物理删除。 |
| **主观笔记层** | `note` | 存放 Agent 或用户主动记下的想法/约定，支持软删（30 天保留期）与向量检索。 |
| **派生结构层** | `scene`、`window`（`exchange` / `thread`）、`chunk` | 完全由原文派生，可随时无损重切或重建；支持在时间轴锁定人工边界（`locked`）。 |
| **向量索引层** | `vec_msg`、`vec_chunk`、`vec_scene`、`vec_note`、`vec_window` | 优先使用原生 `sqlite-vec`（`vec0`），不可用时自动降级为纯 SQLite 余弦计算。 |

## 2. 陪伴优先切分与增量管道

- **增量同步（[src/pipeline.js](file:///c:/workspace/dsh-verbatim/src/pipeline.js)）**：读取宿主会话日志（`session.v4.jsonl.zstd`），按 `seq` 对齐增量入库，同时提取图片媒体元信息写入 `media` 表。
- **30 分钟静默成场**：活跃对话末尾保留为进行中消息，静默 30 分钟后自动归档为场景。
- **陪伴双粒度**：新会话与重建会话默认构建 `exchange`（单轮问答）与 `thread`（同主题微话题）两级片段，兼顾精确定位与上下文连贯性。

## 3. 混合检索与精排

1. **多路召回（[src/tools/memory-search.js](file:///c:/workspace/dsh-verbatim/src/tools/memory-search.js)）**：
   - `when` 解析（[src/tools/time-route.js](file:///c:/workspace/dsh-verbatim/src/tools/time-route.js)）：固定按上海时区（`UTC+8`）将标准日期/区间转为 `[from, to)`。
   - 关键词路：2 字以下走 `LIKE`，3 字以上走 `FTS5 trigram`。
   - 向量路：在满足索引覆盖门槛与模型一致性校验后，并行检索 `vec_msg` / `vec_chunk` / `vec_window` / `vec_note` 与 `vec_scene`。
2. **融合与精排**：
   - 各路结果经 RRF（`k = 60`）融合与区间去重。
   - 启用 `/rerank` 时扩大每路候选池（`perRoute = Math.max(limit * 3, 24)`），重排后对相近话题执行时间线聚簇折叠（`foldTimelineClusters`）。
   - 精排请求超时或异常时自动无感回退 RRF 原序。

## 4. 并发与热更新

- **会话级异步写锁（[src/host/session-lock.js](file:///c:/workspace/dsh-verbatim/src/host/session-lock.js)）**：同一会话的同步、索引重建、场景合并/拆分等写操作严格串行，避免 SQLite 锁冲突与状态竞态。
- **工具热重注（[index.js](file:///c:/workspace/dsh-verbatim/index.js)）**：在面板切换 `tools` 开关时，宿主立即对活跃 Agent 执行 `unregisterFor` + `registerFor`，无需重启即可生效。
