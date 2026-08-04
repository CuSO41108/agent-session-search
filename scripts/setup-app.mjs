import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const appDirectory = process.argv[2];
const supportedDirectories = new Set(["apps/main-1.0", "apps/main-2.0"]);
const require = createRequire(import.meta.url);

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: options.shell,
      env: options.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${options.label} stopped by ${signal}.`));
      } else if (code !== 0) {
        reject(new Error(`${options.label} exited with code ${code ?? 1}.`));
      } else {
        resolve();
      }
    });
  });
}

async function setupApplication() {
  const normalizedDirectory = path.normalize(appDirectory);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(npm, ["ci", "--prefix", normalizedDirectory], {
    label: "npm ci",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      AGENT_RECALL_SKIP_STATUSLINE_INSTALL: "1",
    },
  });

  if (appDirectory === "apps/main-2.0") {
    const dependencyTools = require(path.resolve(normalizedDirectory, "bin", "staged-package-dependencies.cjs"));
    await dependencyTools.restoreEmbeddedPostgresNativeLinks(path.resolve(normalizedDirectory, "node_modules"));
  }

  const electronCli = path.join(normalizedDirectory, "node_modules", "electron", "cli.js");
  await runCommand(process.execPath, [electronCli, "--version"], {
    label: "Electron runtime validation",
    shell: false,
    env: process.env,
  });
}

if (!supportedDirectories.has(appDirectory)) {
  process.stderr.write("Usage: node scripts/setup-app.mjs apps/main-1.0|apps/main-2.0\n");
  process.exitCode = 1;
} else {
  setupApplication().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
