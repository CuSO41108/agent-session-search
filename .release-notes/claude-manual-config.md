# Claude Code 手动配置适配

## Bug 修复

- API 配置的 Claude Code 页现在会显示 `~/.claude/settings.json` 里的当前路由状态（官方认证或第三方供应商、模型和配置文件路径），和 Codex 页保持一致。
- 手动在 settings.json 里配置过第三方 API 的用户，选择 Custom 时会自动带出已有的 Base URL、模型和 Key 环境变量作为基线，不再需要逐项重新填写；写入配置后状态区会自动刷新。
