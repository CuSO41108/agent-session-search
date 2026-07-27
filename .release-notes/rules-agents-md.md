# Rules 同步支持 AGENTS.md

## Bug 修复

- 数字资产的 Rules 同步现在会识别 AGENTS.md：包括全局 `~/.codex/AGENTS.md`、项目根目录和子目录里的 AGENTS.md，可以像 CLAUDE.md 一样上传到云端并在另一台设备还原。
- 老用户重跑一次 Rules 初始化 SQL 即可解锁 AGENTS.md 上传；上传遇到旧表约束时会给出明确的重跑 SQL 提示，而不是晦涩的数据库报错。
