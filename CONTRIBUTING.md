# Contributing to dsh-verbatim

感谢你关注并参与 `dsh-verbatim` 的开发与改进！

## 开发环境要求

- **Node.js `>=24`**（使用内置 `node:sqlite`）
- 安装依赖：

```powershell
npm install --no-audit --no-fund
```

## 前端构建与校验

`client.js` 是由 `src/client/*.js` 按顺序拼接生成的客户端产物，**不要直接手改根目录的 `client.js`**。

修改 `src/client/` 下的任意文件后，请重新打包并运行全量校验：

```powershell
# 重新生成 client.js
npm run build:client

# 校验 client.js 一致性、TypeScript 类型检查与入口语法检查
npm run check

# 运行完整单元测试与前端渲染测试
npm test
```

## 提交规范与隐私要求

1. **禁止提交任何真实用户数据**：测试夹具、示例片段、文档截图或注释中严禁包含真实的个人对话记录、真实 `session_id`、本机绝对路径（如 `C:\Users\...`）或内部评测数据集信息，请统一使用完全虚构的合成数据。
2. **保持隐私边界不可绕过**：涉及 `memory_search`、`memory_around`、`memory_timeline` 或仓储查询层的改动，必须保证 `excluded = 1` 与 `excludeRanges` 对 Agent 工具不可绕过（`allowExcluded` 仅允许用于本机管理面板）。
3. **提交 PR 前确认绿灯**：请确保 `npm run check` 与 `npm test` 均通过，并在 PR 描述中说明改动范围与验证方式。
