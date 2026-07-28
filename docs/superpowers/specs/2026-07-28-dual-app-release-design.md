# AgentRecall 双应用 Release 设计

## 目标

同一次 GitHub Release 同时展示并提供 AgentRecall 1.0 与 `agent-recall-v2`，让用户能明确区分两套应用并分别下载安装。

## 发布模型

- V1 与 V2 共用一个语义化版本号、Git tag 和 GitHub Release。
- Release 正文固定包含 “AgentRecall 1.0” 与 “agent-recall-v2” 两个区块。
- Release note 继续通过 `release-target: v1|v2|both` 路由；某一应用没有单独变化时显示同步发布说明，不挪用另一应用的更新内容。
- 任一应用存在待发布的用户可见变化时，都重新构建和发布两套应用，保证 “latest” Release 始终包含两套可安装资产。

## 资产隔离

V1 保持现有兼容名称：

- `agent-recall-<version>.tgz`
- `agent-recall.tgz`
- `update.json`

V2 使用独立名称：

- `agent-recall-v2-<version>.tgz`
- `agent-recall-v2.tgz`
- `update-v2.json`

两套安装包分别生成校验和。V2 更新客户端只读取 `update-v2.json` 并下载 `agent-recall-v2.tgz`，避免误装 V1。

## 工作流

发布工作流收集自上个稳定 tag 以来的全部 release notes，生成 V1 note、V2 note 和双应用展示正文。随后统一计算版本、安装并测试两个应用、构建和验证两组资产，最后创建 draft Release。只有两组远端资产下载复验都通过后，Release 才转为正式发布。

## 验证

- release-note 单元测试覆盖按目标分组、空目标同步说明和双区块渲染。
- V2 发布资产测试覆盖独立文件名、URL、校验和与清单。
- V2 更新测试覆盖 `update-v2.json` 查找和 V2 手动安装地址。
- 工作流测试确认两个应用都参与构建、上传和远端复验。
