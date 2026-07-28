# 修复已安装版本的 OpenViking 下载

## Bug 修复

- 全局安装的 agent-recall-v2 现在会下载与当前版本匹配的 OpenViking 运行环境，不再误用 Electron 版本号或尝试调用仅源码仓库存在的构建脚本。
