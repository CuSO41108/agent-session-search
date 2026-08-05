# 让目录记忆只跟踪新对话

<!-- release-target: v2 -->

## Bug 修复

- OpenViking Memory 现在只按所选目录增量跟踪开启后的新对话，不再批量导入历史会话；旧内容仍可通过会话搜索找到并按需保存。
- Codex 使用 API Key 或自定义接口时，Memory 添加目录会沿用当前 Provider，不再错误提示缺少 OAuth 凭据。
