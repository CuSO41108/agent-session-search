# 修复 Custom 配置保存后丢失

## Bug 修复

- 修复 API 配置里"仅保存到应用"的 Codex Custom 配置在重新打开对话框后被翻回 Official、字段被 config.toml 内容覆盖的问题：应用内已保存的 Custom 配置现在始终是表单基线，当前 config.toml 状态只在"当前配置"区展示，不再悄悄冲掉你保存的内容。
