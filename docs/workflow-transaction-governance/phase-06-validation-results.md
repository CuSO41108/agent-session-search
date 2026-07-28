# 阶段六验证结果

## 可重复命令

```powershell
npm run typecheck
npm run test:workflow-transaction
npm run test:workflow-performance
npm run test:scripts
npm run release-note:check
git diff --check
```

`test:workflow-transaction` 是事务治理的稳定聚焦入口，覆盖共享合同、工作区事务、操作 Broker、提交协调器、节点执行、恢复投影和 Renderer。

## 当前验收状态

- `npm run test:workflow-transaction`：47 个测试文件、494 项测试通过。
- `npm run test:workflow-performance`：8 个测试文件、184 项 Hub 与运行时回归测试通过。
- `npm run test:scripts`：91 项脚本、更新和打包辅助测试通过；测试使用隔离目录和合成数据。
- `npm run typecheck`、`git diff --check` 与 `npm run release-note:check` 通过；本事务治理分支相对共同基线只新增并维护一份发布说明。
- `test:workflow-performance` 首次运行有一项暂停/恢复时序断言失败；该项独立复现和完整性能套件重跑均通过。
- Windows 全量 `npm test` 本次有 43 项失败，仍集中在 POSIX 命令/路径、Windows 文件权限与符号链接、伪 CLI 启动和平台个性化断言；事务专项在同一次全量运行中保持通过。因为 Vitest 阶段失败，后续 `test:scripts` 未执行，全量套件不能标记为绿色。

## 故障注入矩阵

| 场景 | 自动化证据 |
| --- | --- |
| 严格事务工作区预检失败 | `workflow-runtime.test.ts` 验证节点发放前停止运行，脱敏写入 `preflight_blocked` 事件，并把无副作用的新事务持久化为已回滚状态 |
| baseline 冻结中断 | `workflow-v2-workspace-transaction.test.ts` 清除残留 staging 后重新冻结完整基线 |
| 保存点写入中断与账本边界 | `workflow-v2-workspace-transaction.test.ts` 验证残留保存点 staging 不会被当成有效快照；`workflow-v2-recovery.test.ts` 验证保存点后出现外部操作时隐藏文件回滚并引导全量补偿 |
| 文件提交前、中、后中断 | 同文件模拟首个原子替换完成后的恢复，并验证重复提交不产生冲突 |
| 隔离目录或保存点材料丢失、磁盘不足或容量不可查询 | `workflow-v2-workspace-transaction.test.ts` 验证恢复拒绝、空间不足拒绝和 `statfs` 失败时 fail closed；`workflow-v2-recovery-capabilities.test.ts` 与 `workflow-v2-recovery.test.ts` 验证缺失保存点不会显示回滚动作，缺失严格隔离工作区不会显示“继续” |
| 用户并发修改、回滚冲突与并发 Run 提交 | `workflow-v2-workspace-transaction.test.ts` 验证三方冲突、保留用户修改、回滚暂停，以及指向同一真实工作区的独立事务串行提交；`workflow-runtime.test.ts` 验证选择当前版本后只刷新内容绑定的工作区计划与审批，并完成最终提交 |
| 并发 durable 写入与恢复请求 | `workflow-v2-store.test.ts` 验证同一根目录的独立 Store 不会丢失事件；`workflow-runtime.test.ts` 验证同一 Run 的重复人工核验串行执行且只落账一次，拒绝在 Run 仍执行时刷新恢复状态，并在执行“继续”前发现恢复页打开后新增的文件冲突 |
| 材料保留期续期 | `transaction.test.ts` 验证保留期限从最近一次事务活动重新计算，避免长时间恢复后的 Run 在刚完成时立即被自动清理 |
| planned 写入前中断、planned 后中断、apply/receipt 间隙 | `workflow-v2-operation-broker.test.ts` 验证 planned 持久化失败时绝不调用 Adapter，并验证 WAL 顺序与 `applying` 恢复检查 |
| inspect 的 applied/not_applied/unknown | 同文件分别验证恢复为 `applied`、`compensated` 或保持 `unknown` |
| unknown 人工核验 | `workflow-runtime.test.ts`、`workflow-v2-store.test.ts`、`workflow-v2-recovery.test.ts` 与 `WorkflowRunCenter.test.tsx` 验证用户可依据远端记录核验为已应用/未应用，决定写入账本后刷新事务计数和恢复动作，在运行时和持久化边界拒绝超长审计身份与理由，并在 operation ledger 不可读时阻止继续 |
| 补偿中断、失败、逆序执行与不可逆残留 | `workflow-v2-operation-broker.test.ts` 验证补偿前检查、首次失败即停止及逆序 operationId；`workflow-runtime.test.ts` 对照验证可逆操作全部补偿后为 `rolled_back`，仍有不可逆 `applied` 操作时只能为 `partially_rolled_back` 并生成明确人工步骤 |
| API 超时但远端接受 | apply 失败后通过 inspect 证明 applied，且不重复 apply |
| 不可撤回消息 | `workflow-v2-external-adapters.test.ts` 验证消息不会被伪报为已补偿，且无 `retract` 的 Provider 在严格模式发送前失败关闭 |
| required tool 失败、历史乱序和 tool-call ID 异常 | `workflow-v2-node-acceptance.test.ts` 与 `workflow-runtime.test.ts` 验证漂亮输出不能掩盖失败，缺失/重复/未配对结果不能成为 clean |
| 脚本 stderr、schema、超时和残留子进程 | `workflow-v2-script-executor.test.ts` 验证策略、类型、unknown receipt，确认命令超时后子进程树不再产生副作用，并验证内联 TypeScript 的同步死循环与永不完成 Promise 都会被硬超时终止 |
| 非幂等脚本重试 | `workflow-v2-executor.test.ts` 验证 `onError=retry` 仍只执行一次并暂停人工确认 |
| 并行节点失败 | 同文件验证首个失败会请求取消仍在运行的兄弟节点，已启动节点全部收敛后不再发放下一批节点 |
| 暂停后立即继续 | `agent-hub.test.ts` 验证暂停会等待旧执行释放运行租约，再从同一冻结 Run 恢复并继续下游节点 |
| dirty/untracked/deleted 工作区 | `workflow-v2-workspace-transaction.test.ts` 和 `workflow-v2-script-executor.test.ts` 验证隔离基线与 Git 范围 |
| 最终报告与重启 | `workflow-v2-recovery.test.ts` 验证报告优先使用提交前事务快照，区分 created、modified、deleted，输出脱敏请求/receipt、补偿顺序，并为每个未知或已应用不可逆操作列出带 operationId 的人工步骤；`workflow-runtime.test.ts` 验证 Manager 建议脱敏、人工核验与恢复动作刷新证据、多文件冲突决定逐次落盘；`agent-hub-workflow-restore.test.ts` 验证重启优先恢复 durable 最终报告，为纯文件变更保留全量补偿动作，重新发现实时三方冲突，并在同一路径内容摘要变化后撤销过期 Manager 建议 |
| symlink/junction/路径逃逸 | `workflow-v2-workspace-transaction.test.ts` 与 `workflow-v2-store.test.ts` 验证拒绝链接提交和目录穿越 |
| commit plan 跨步骤恢复 | `workflow-v2-commit-coordinator.test.ts` 与 `workflow-v2-store.test.ts` 验证不可变计划顺序、同一 Run 多阶段计划归档、未知步骤 inspect 后续跑、冲突补偿、同一路径内容在冻结后变化时提交前失败关闭，以及外部步骤期间发生内容漂移时补偿已执行操作并拒绝文件提交 |
| 提交点与审批策略 | `transaction.test.ts`、`workflow-runtime.test.ts`、`workflow-v2-recovery.test.ts` 和 `WorkflowRunCenter.test.tsx` 验证非严格模式拒绝 checkpoint、自动阶段提交、required 恢复投影与内容级 plan digest 审批、计划变化后重新确认、阶段冲突解决后继续下游节点、冲突决定刷新工作区证据但拒绝外部步骤漂移、无剩余工作时隐藏“继续”，以及 batch/per-operation 启动选择 |
| `onError` 与 effectMode | `workflow-v2-executor.test.ts`、`workflow-runtime.test.ts` 验证 unknown 副作用暂停且不自动重跑 |

跨场景公共断言由 `workflow-runtime.test.ts`、`workflow-v2-recovery.test.ts`、`agent-hub-workflow-restore.test.ts` 和 `WorkflowRunCenter.test.tsx` 完成：事务/节点状态、账本与 receipt、恢复报告、快照保留策略和用户可选动作必须同步投影，重启不得丢失 Manager 候选或伪造旧 Run 证据。

手动清理和保留期自动清理都会同时移除公开 Run 中的 operation receipt 与 recovery 投影；最终报告、事务摘要和用户恢复决定继续保留。

## 迁移与预检

- 缺失 `transactionPolicy` 的旧定义只解析为 `direct`，启动区明确显示“不保证回滚”；不会从提示词、脚本名或历史结果推断 effectMode、幂等性或适配器。
- 旧 Run 兼容读取时，缺失的 transaction、operation、receipt、recovery 和快照保持缺失。
- governed 模式要求脚本显式声明 effectMode、idempotency 和 stderrPolicy；`strict_atomic` 额外拒绝任意 command、未代理外部能力和缺失补偿适配器。
- 创建 Run 前检查已确认修订、审批模式、隔离/Broker 执行端口、可写持久账本、恢复审批入口和静态副作用合同；节点执行前实际冻结基线并检查受治理路径、链接、快照完整性、磁盘容量和 durable store 写入。任何失败均不发放节点任务，也不降级为 direct。

## 灰度边界

当前实现已按 `direct → controlled → strict_atomic → HTTP/可注入消息适配器 → 节点验收/策略保存点与提交点` 的顺序接通能力。新建 Workflow 默认使用 `strict_atomic`；旧 Workflow 仍按缺失合同兼容为 `direct`，不会被静默升级。严格 Agent 的外部写入不做隐式代理，必须改为 Broker 脚本节点；消息 Provider 未注入或缺少 `retract` 时，严格模式预检失败关闭。
