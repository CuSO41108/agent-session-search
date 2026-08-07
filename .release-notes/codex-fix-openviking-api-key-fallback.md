# 记忆服务支持 API Key 登录

## Bug 修复

- 修复仅使用 API Key（未登录 ChatGPT 账号）时记忆服务无法启动的问题：现在会直接使用 Codex 已配置的 API Key 完成记忆提取，不再要求额外的账号授权。
