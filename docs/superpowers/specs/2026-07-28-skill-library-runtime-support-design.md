# Skill 库多 Runtime 支持与界面文案设计

## 问题

- Skill 发现弹窗的详情区已经明确展示当前 Skill 和下载图标，按钮仍显示“加入 Skill 库 / Add to Skill library”，信息重复且占用横向空间。
- 受管 Skill 的安装目标已有 Codex、Claude Code、Trae，本地 Skill 扫描已有 Qoder，但两套能力不一致，且缺少项目已经支持会话检索的 CodeBuddy。
- 安装目标弹窗编辑的是目标选择集合，但卡片文案使用“将安装 / 不安装”。打开已安装目标时仍会显示“将安装”，容易被理解成尚未安装。

## 方案

### 发现按钮

- 常态按钮改为“加入 / Add”。
- 加载态保留“正在加入… / Adding…”，继续明确反馈正在执行的动作。
- 点击逻辑、禁用状态、导入目标和其他 Skill 页面按钮均不改变。

相比“加入 Skill”或仅保留图标，“加入 / Add”最短，同时在当前详情区上下文中仍然明确。

### Runtime 支持

Skill 库的用户级安装目标统一为：

- Codex：`~/.codex/skills`
- Claude Code：`~/.claude/skills`
- CodeBuddy：`~/.codebuddy/skills`
- Qoder：`~/.qoder/skills`
- Trae：`~/.trae/skills`

其中 CodeBuddy 和 Qoder 的目录规则来自各自官方 Skill 文档；Codex、Claude Code、Qoder 和 Trae 已经部分存在于当前实现。目标列表保持显式枚举，安装继续复用现有的冲突检查、受管链接和 Windows Junction 行为。

本地 Skill 扫描同时加入 CodeBuddy 和 Trae 的用户级、项目级目录，使“发现本机已有 Skill”和“从本 App 安装到 Agent”覆盖同一组 Agent。项目目录发现逻辑也识别 `.codebuddy/skills`、`.qoder/skills` 和 `.trae/skills`。

暂不加入 Cursor、OpenCode 等目标：当前产品虽然能检索其中部分会话，但 Skill 管理代码尚未对这些产品形成完整的扫描、来源和安装约束；避免仅增加一个看似可选、实际行为未经验证的入口。

### 目标状态文案

- 已勾选改为“已选择 / Selected”。
- 未勾选改为“未选择 / Not selected”。
- 冲突继续显示“路径冲突 / Path conflict”。

文案只描述弹窗中的选择状态，安装的真实状态仍由打开弹窗时的初始勾选和保存结果决定。

## 验证

- 添加源代码测试，确认发现弹窗使用短文案且不再包含旧文案。
- 扩展受管 Skill 测试，确认五个目标均映射到正确用户目录，并保留冲突与清理保护。
- 扩展本地扫描测试，确认 CodeBuddy、Qoder 和 Trae 的用户级、项目级 Skill 可见。
- 添加界面测试，确认目标卡片使用“已选择 / 未选择”。
- 运行相关测试、完整测试、类型检查和生产构建。
