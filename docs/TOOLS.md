# Agent 工具与隐私边界

`dsh-verbatim` 向每个启用 `tools: true` 的会话注入以下 **3 个工具**（定义于 [src/tools/index.js](file:///c:/workspace/dsh-verbatim/src/tools/index.js)），所有工具实例在创建时闭包绑定当前 `sessionId`，返回纯文本结果。

## 1. 工具清单

| 工具 | 依赖开关 | 用途 |
|---|---|---|
| `memory_search` | `tools` | 统一检索入口：支持按 `when` 翻时间轴、按 `query` 混合检索原话/笔记、或留空查看最近一次聊天 |
| `memory_remember` | `tools` + `record` | 写入 Agent 主观笔记（`note` 表），可标注 `about: 'me' \| 'him' \| 'us'` |
| `memory_forget` | `tools` | 软删或从 30 天回收站恢复 Agent 笔记（**永远不可删除对话原文**） |

## 2. 检索返回格式

在陪伴会话下，`memory_search` 场景头提供精确时间区间，内部对话以单行紧凑格式呈现：

```text
「周末去公园」— 3 处

  11-16 14:10–14:25 · 6轮 · 92字 · 命中 2 处
    我：周六天气不错，去公园散步吗？
    他：好呀，顺便去湖边坐坐 kw+vec  ←
    我：记得带上相机和防晒。 kw+vec  ←
    他："/path/to/dsh_home/attachments/v1/objects/00/0000...png" [图片]
    [图片备注：公园湖边的长椅]
```

- `他` 表示用户，`我` 表示助手自身；`←` 标注命中的证据行。
- 命中消息若包含媒体附件，会自动解析本地附件路径（`sha256:` → `$DSH_HOME/attachments/v1/objects/...`）与用户编辑的 `caption` 备注。
- `scope='note'` 时若回收站存在未过期已删笔记，会自动附带可恢复编号提示。

## 3. 隐私与可知性边界

1. **排除内容绝对隔离**：用户在面板配置的「私密排除时段」或单条「暂不回想」消息对 Agent 完全隐藏；`includeExcluded` 参数不暴露给 Agent Schema，Agent 即使自行传入也无法绕过（仅宿主面板显式传入内部 `allowExcluded: true` 时可读）。
2. **降级透明**：当向量索引未配置、为空或覆盖率不足时，返回末尾明确标注降级状态（如 `vec:empty` / `vec:partial`），防止模型把“未建索引”误判为“从未聊过”。
3. **跨会话零泄露**：检索统计、笔记库存、前序上下文与错误提示均严格限定在当前 `sessionId` 内。
