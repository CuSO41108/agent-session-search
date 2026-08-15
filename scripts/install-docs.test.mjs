import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("V2 Electron troubleshooting uses the supported release and runtime checks", async () => {
  const guide = await readFile("docs/troubleshooting-electron-installation.md", "utf8");
  const installGuide = await readFile("Install.md", "utf8");

  assert.match(
    guide,
    /releases\/download\/v2-latest\/agent-recall-v2\.tgz/,
  );
  assert.doesNotMatch(
    guide,
    /releases\/latest\/download\/agent-recall-v2\.tgz/,
  );
  assert.doesNotMatch(guide, /agent-recall-v2\s*&/);
  assert.match(guide, /ZIP_NAME="electron-v\$\{ELECTRON_VERSION\}-darwin-\$\{ELECTRON_ARCH\}\.zip"/);
  assert.match(guide, /"\$ELECTRON_BINARY" --version/);
  assert.match(
    installGuide,
    /\[macOS Electron 安装故障排除指南\]\(docs\/troubleshooting-electron-installation\.md\)/,
  );
  const v2InstallGuide = installGuide.slice(installGuide.indexOf("## 安装并使用 v2"));
  assert.match(v2InstallGuide, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.doesNotMatch(v2InstallGuide, /--registry=https:\/\/registry\.npmmirror\.com/);
  assert.match(guide, /--registry=https:\/\/registry\.npmjs\.org\//);
});
