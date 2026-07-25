# Workflow 渲染性能对比报告

## 结论

在同一台 Windows 机器、同一份合成压力数据下，`feat/workflow-incremental-ipc` 相比 `main-2.0`：

- 单次流式更新的平均传输对象从约 10.46 MiB 降至 21.79 KiB，减少 99.80%，约为原来的 1/491。
- payload 序列化 CPU 从平均 23.46 ms 降至 0.12 ms，减少 99.49%。
- 从提交一轮 delta 到收到合并事件的平均延迟从 63.82 ms 降至 36.86 ms，减少 42.24%。
- 每轮流式更新构造完整 `AppSnapshot` 的次数从 1 次降至 0 次。
- Workflow Renderer bundle 增加约 2.63 KiB（0.44%）；Main bundle 增加约 11.09 KiB（0.53%）。

结果证明增量 IPC 已经消除本次问题中最主要的跨进程数据放大和序列化开销。真实输入到下一帧绘制的 p95 尚未自动采集，因此不能只凭本报告宣称已经满足最终的 50 ms 用户交互指标。

## 对比对象

| 项目 | 基线 | 改造版本 |
| --- | --- | --- |
| Git ref | `origin/main-2.0` | `feat/workflow-incremental-ipc` |
| Commit | `1ecf6280a5e5ccaa4a73035cf70b4341867f04e3` | `2025ce74584e7175320edbec97f658208be6baed` |
| 构建模式 | Electron production build | Electron production build |

测试日期：2026-07-25。

## 测试环境

| 项目 | 值 |
| --- | --- |
| OS | Microsoft Windows 11 家庭版 中文版 |
| CPU | 13th Gen Intel Core i5-13500H |
| 内存 | 15.8 GiB |
| Node.js | v22.16.0 |
| npm | 10.9.2 |

两个版本使用隔离 Git worktree，并共享同一份安装依赖。测试期间未加载真实用户 Session、Skills、Runtime 或 Workflow 数据。

## Fixture 与方法

主进程基准使用以下合成数据：

- 500 个 Task。
- 每个 Task 20 条历史消息。
- 每条消息正文约 960 个字符。
- 每轮连续提交 30 个 Workflow-owned task delta。
- 每个进程执行 10 轮；分别启动 3 个进程取均值。
- 两个版本均保留原有 32 ms 流式合并窗口。

基准记录：delta 提交 CPU、事件送达延迟、`snapshot()`/`workflowProjection()` 调用次数、JSON 序列化 CPU 和事件对象字节数。JSON 字节数用于稳定比较事件对象规模，不代表 Electron IPC 的精确线上编码格式。

执行入口为 `scripts/workflow-performance-benchmark.ts`。示例：

```powershell
npx tsx scripts/workflow-performance-benchmark.ts C:\path\to\main-2.0 main-2.0 500 30 10
npx tsx scripts/workflow-performance-benchmark.ts C:\path\to\feature incremental-ipc 500 30 10
```

## 主进程结果

| 指标 | main-2.0 | 增量 IPC | 变化 |
| --- | ---: | ---: | ---: |
| 每轮事件数 | 1 | 1 | 合并语义不变 |
| 每轮完整 snapshot 次数 | 1 | 0 | -100% |
| 平均事件对象大小 | 10,963,153 B | 22,317 B | -99.80% |
| 平均 payload 序列化 CPU | 23.459 ms | 0.119 ms | -99.49% |
| 平均事件送达延迟 | 63.824 ms | 36.864 ms | -42.24% |
| 平均 delta 提交 CPU | 0.172 ms | 0.681 ms | +0.509 ms |

新版 delta 提交 CPU 略有增加，因为每个 delta 会生成当前实体的候选 patch，并在合并窗口内按实体 ID 去重。增加量小于 1 ms，同时换来了完整快照遍历和约 10 MiB 事件序列化的消除。按本 fixture 计算，单轮已观测主线程 CPU（delta 提交、snapshot 和序列化之和）由约 25.74 ms 降至约 0.80 ms。

## 构建产物

| 产物 | main-2.0 | 增量 IPC | 变化 |
| --- | ---: | ---: | ---: |
| Workflow Renderer chunk | 610,848 B | 613,536 B | +2,688 B / +0.44% |
| Main bundle | 2,161,141 B | 2,172,500 B | +11,359 B / +0.53% |

bundle 增量来自共享 IPC 合同、Renderer store、结构共享和本地交互状态逻辑，体积变化相对有限。

## 已验证的性能合同

`npm run test:workflow-performance` 已通过 8 个测试文件、178 个测试，覆盖：

- 高频事件合并与 direct patch payload 边界。
- sequence、重复事件和失序 resync。
- 未变化 definition、message 和其他集合的引用稳定。
- Composer 本地输入状态。
- Agent 下拉框交互逻辑。
- Run Center 关闭态和详情渲染。
- JSON 编辑器延迟解析。

## 尚不能自动证明的指标

当前仓库没有 Playwright、Webdriver 或 Electron CDP 性能采样工具，因此本报告没有自动测量：

- 键盘事件到下一次 paint 的 p50/p95。
- 下拉框选择到屏幕显示新值的帧延迟。
- Chrome Renderer long task、布局和 paint 时间。
- GPU 开启与关闭时 React Flow 的帧率。
- macOS 上的同 fixture 实测数据。

要补齐这些指标，不需要额外的领域知识 Skill，主要缺少自动化运行环境：

1. 增加 Playwright 的 Electron `_electron.launch` 或直接接入 Electron CDP。
2. 提供可重复导入的合成 Workflow fixture，禁止读取真实用户数据。
3. 在输入、下拉框和 IPC 应用位置写入 `performance.mark/measure`。
4. 分别配置 Windows 和 macOS runner，固定窗口尺寸、GPU 策略和 production build。
5. 每个场景预热后运行至少 30 次，输出 p50、p95、long task 数量和 trace 文件。

`frontend-inspector` 足以继续定位 React 状态、DOM 和样式边界；若后续经常执行此类对比，可以再创建一个 Electron performance Skill，把 fixture 生成、双 worktree 构建、CDP trace 和报告模板固化为标准流程。

## 建议

- 本次改造可以基于当前主进程基准和性能合同进入 MR 评审。
- MR 合并前补一次人工 Electron 冒烟，重点观察持续输出时输入、快速切换 Agent 和打开 Run Center。
- 将 Electron CDP 基准作为后续独立任务，不应阻塞已经明确降低 99.8% 事件体积的增量 IPC 修复。
