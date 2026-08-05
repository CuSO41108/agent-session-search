# AgentRecall V2 macOS 安装故障排除指南

## 问题描述

在 macOS 上通过 npm 全局安装 AgentRecall V2 后，启动应用时可能报错：

```
Error: ENOENT: no such file or directory, open '.../electron/path.txt'
```

或 Electron 二进制启动失败：

```
dyld: Library not loaded: @rpath/Electron Framework.framework/Electron Framework
```

## 根本原因

npm 的 `extract-zip` 模块在提取大型 Electron 二进制文件时，可能无法完全解压 `Electron.app/Contents/Frameworks` 目录，导致框架文件缺失。

## 解决方案

### 推荐：使用 npm 重新安装

最可靠的解决方案是让 V2 启动器自动重新下载和验证 Electron：

```bash
# 1. 卸载
npm uninstall -g agent-recall-v2

# 2. 清空 npm 缓存（可选但推荐）
npm cache clean --force

# 3. 重新安装，使用可靠镜像源
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall-v2.tgz \
  --registry=https://registry.npmmirror.com

# 4. 验证安装
agent-recall-v2 --version

# 5. 实际启动测试（观察是否正常启动，不是仅检查 --version）
agent-recall-v2 &
sleep 3
# 应该看到应用窗口或相关输出，按 Ctrl+C 退出
```

### 手动修复（如果重新安装不可行）

如果需要快速修复现有安装，而不重新下载：

```bash
# 1. 定位全局 node_modules 目录（使用 npm root -g，不要硬编码）
ELECTRON_DIR="$(npm root -g)/agent-recall-v2/node_modules/electron"

# 2. 验证路径是否存在（删除前检查）
if [ ! -d "$ELECTRON_DIR" ]; then
  echo "错误：未找到 $ELECTRON_DIR"
  exit 1
fi

# 3. 找到 Electron 缓存的 zip 文件
ZIP_FILE=$(find ~/Library/Caches/electron -name "electron-v*-darwin-arm64.zip" \
  -o -name "electron-v*-darwin-x64.zip" | sort -V | tail -1)

if [ -z "$ZIP_FILE" ]; then
  echo "未找到缓存的 Electron zip 文件"
  echo "建议重新安装：npm uninstall -g agent-recall-v2 && npm install -g agent-recall-v2"
  exit 1
fi

echo "使用缓存: $ZIP_FILE"

# 4. 清除不完整的提取内容
rm -rf "$ELECTRON_DIR/dist"

# 5. 用 unzip 重新提取（macOS 自带命令，比 extract-zip npm 模块更可靠）
unzip -q "$ZIP_FILE" -d "$ELECTRON_DIR/dist"

if [ ! -d "$ELECTRON_DIR/dist/Electron.app/Contents/Frameworks" ]; then
  echo "错误：Frameworks 目录仍然缺失，解压可能失败"
  exit 1
fi

# 6. 创建 path.txt（不能用 echo，会追加换行符）
printf '%s' 'Electron.app/Contents/MacOS/Electron' > "$ELECTRON_DIR/path.txt"

# 7. 验证文件内容（确保没有换行）
if [ "$(cat "$ELECTRON_DIR/path.txt" | wc -l)" -ne 0 ]; then
  echo "警告：path.txt 包含换行符，请手动修复"
  exit 1
fi

echo "✓ 修复完成"

# 8. 实际运行时验证（不仅是 --version，而是真实启动）
echo "启动应用验证..."
agent-recall-v2 &
RECALL_PID=$!
sleep 3
if ps -p $RECALL_PID > /dev/null 2>&1; then
  echo "✓ 应用成功启动"
  kill $RECALL_PID 2>/dev/null
else
  echo "✗ 应用启动失败，可能需要重新安装"
  exit 1
fi
```

## 验证步骤

完成修复后，确认以下内容：

```bash
# 1. 检查 Frameworks 目录是否存在
ls -la "$(npm root -g)/agent-recall-v2/node_modules/electron/dist/Electron.app/Contents/"

# 输出应包含：
# Frameworks
# Info.plist
# MacOS
# PkgInfo
# Resources

# 2. 检查 path.txt 内容（应无换行符）
cat "$(npm root -g)/agent-recall-v2/node_modules/electron/path.txt" | od -c

# 3. 测试实际启动（关键验证，不仅是 --version）
agent-recall-v2 &
# 应看到应用启动，按 Ctrl+C 退出
```

## 缓存位置

Electron 二进制缓存位置：
- **macOS**: `~/Library/Caches/electron/`
- **Linux**: `~/.cache/electron/`
- **Windows**: `%APPDATA%\electron\cache\`

## 已知限制

- 此问题仅在 npm 全局安装时出现，本地项目安装不受影响
- V2 启动器已包含缺失 `path.txt`、检查缓存完整性等修复流程，不建议直接修改 node_modules 中的 Electron 代码
- 镜像源配置（`ELECTRON_MIRROR`）仅加速下载，不能预防解压失败

## 推荐阅读

- [AgentRecall Install.md](../Install.md) - 完整安装指南
- npm extract-zip 模块问题跟踪
- Electron 官方 macOS 支持文档

## 后续步骤

如果以上方案均不可行，建议：

1. 报告问题到 [AgentRecall Issues](https://github.com/zszz3/AgentRecall/issues)，包含完整的错误日志
2. 尝试使用旧版本（如 v0.4.x）验证问题是否版本特定
3. 检查 macOS 系统更新和 xcode-select 工具链完整性
