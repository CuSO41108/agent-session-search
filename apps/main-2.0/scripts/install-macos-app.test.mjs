import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const { BUNDLE_IDENTIFIER, findInstalledMacosApp, installMacosApp, uninstallMacosApp } = require("../bin/install-macos-app.cjs");
const temporaryDirectories = new Set();

after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(dir);
  return dir;
}

async function makeFakePackage() {
  const packagePath = await makeTempDir("agent-recall-app-pkg-");
  fs.mkdirSync(path.join(packagePath, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packagePath, "assets"), { recursive: true });
  fs.writeFileSync(path.join(packagePath, "package.json"), JSON.stringify({ name: "agent-recall-v2", version: "1.2.3" }));
  fs.writeFileSync(path.join(packagePath, "bin", "agent-recall.cjs"), "// fake cli\n");
  fs.writeFileSync(path.join(packagePath, "assets", "app-icon.png"), "fake-png");
  return packagePath;
}

const fakeBuildIcns = (sourceIconPath, workDir) => {
  const icnsPath = path.join(workDir, "AppIcon.icns");
  fs.writeFileSync(icnsPath, "fake-icns");
  return icnsPath;
};

test("installMacosApp creates a launchable wrapper bundle", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const result = installMacosApp({
    platform: "darwin",
    packagePath,
    nodePath: "/fake/node",
    applicationsDirs: [appsDir],
    buildIcns: fakeBuildIcns,
  });

  assert.equal(result.status, "installed");
  assert.deepEqual(result.warnings, []);
  const appPath = path.join(appsDir, "agent-recall-v2.app");
  assert.equal(result.appPath, appPath);
  const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
  assert.match(plist, new RegExp(BUNDLE_IDENTIFIER));
  assert.match(plist, /<string>1\.2\.3<\/string>/);
  const launcherPath = path.join(appPath, "Contents", "MacOS", "AgentRecall");
  const launcher = fs.readFileSync(launcherPath, "utf8");
  assert.match(launcher, /exec "\/fake\/node" ".*agent-recall\.cjs"/);
  assert.match(launcher, /exec \/bin\/zsh -lc 'agent-recall-v2'/);
  if (process.platform !== "win32") {
    // Windows has no Unix execute bits; chmod is a no-op there.
    assert.equal(fs.statSync(launcherPath).mode & 0o111, 0o111);
  }
  assert.equal(fs.readFileSync(path.join(appPath, "Contents", "Resources", "AppIcon.icns"), "utf8"), "fake-icns");
});

test("installMacosApp is idempotent and refuses foreign bundles", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const options = { platform: "darwin", packagePath, nodePath: "/fake/node", applicationsDirs: [appsDir], buildIcns: fakeBuildIcns };
  assert.equal(installMacosApp(options).status, "installed");
  assert.equal(installMacosApp(options).status, "installed");

  const foreignDir = await makeTempDir("agent-recall-apps-foreign-");
  const foreignApp = path.join(foreignDir, "agent-recall-v2.app", "Contents");
  fs.mkdirSync(foreignApp, { recursive: true });
  fs.writeFileSync(path.join(foreignApp, "Info.plist"), "<key>CFBundleIdentifier</key><string>com.someone-else.app</string>");
  const refused = installMacosApp({ ...options, applicationsDirs: [foreignDir] });
  assert.equal(refused.status, "error");
  assert.match(refused.detail, /not created by AgentRecall/);
  assert.equal(fs.existsSync(path.join(foreignApp, "Info.plist")), true);
});

test("installMacosApp falls back to the next writable directory", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const missingDir = path.join(appsDir, "does-not-exist");
  const result = installMacosApp({
    platform: "darwin",
    packagePath,
    nodePath: "/fake/node",
    applicationsDirs: [missingDir, appsDir],
    buildIcns: fakeBuildIcns,
  });
  assert.equal(result.status, "installed");
  assert.equal(result.appPath, path.join(appsDir, "agent-recall-v2.app"));
});

test("installMacosApp degrades to an icon-less bundle when icns generation fails", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const result = installMacosApp({
    platform: "darwin",
    packagePath,
    nodePath: "/fake/node",
    applicationsDirs: [appsDir],
    buildIcns: () => null,
  });
  assert.equal(result.status, "installed");
  assert.equal(result.warnings.length, 1);
  assert.equal(fs.existsSync(path.join(appsDir, "agent-recall-v2.app", "Contents", "Resources", "AppIcon.icns")), false);
});

test("installMacosApp reports unsupported on non-macOS platforms", async () => {
  const packagePath = await makeFakePackage();
  assert.equal(installMacosApp({ platform: "win32", packagePath }).status, "unsupported");
});

test("findInstalledMacosApp and uninstallMacosApp only touch our bundle", async () => {
  const packagePath = await makeFakePackage();
  const homeDir = await makeTempDir("agent-recall-app-home-");
  const appsDir = path.join(homeDir, "Applications");
  fs.mkdirSync(appsDir, { recursive: true });
  assert.equal(findInstalledMacosApp({ homeDir }), null);

  installMacosApp({ platform: "darwin", packagePath, nodePath: "/fake/node", applicationsDirs: [appsDir], buildIcns: fakeBuildIcns });
  assert.equal(findInstalledMacosApp({ homeDir }), path.join(appsDir, "agent-recall-v2.app"));

  const removed = uninstallMacosApp({ homeDir });
  assert.equal(removed.status, "removed");
  assert.equal(fs.existsSync(path.join(appsDir, "agent-recall-v2.app")), false);
  assert.equal(uninstallMacosApp({ homeDir }).status, "absent");

  const foreignApp = path.join(appsDir, "agent-recall-v2.app", "Contents");
  fs.mkdirSync(foreignApp, { recursive: true });
  fs.writeFileSync(path.join(foreignApp, "Info.plist"), "<key>CFBundleIdentifier</key><string>com.someone-else.app</string>");
  assert.equal(uninstallMacosApp({ homeDir }).status, "absent");
  assert.equal(fs.existsSync(path.join(foreignApp, "Info.plist")), true);
});
