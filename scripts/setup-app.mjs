import { spawn } from "node:child_process";
import path from "node:path";

const appDirectory = process.argv[2];
const supportedDirectories = new Set(["apps/main-1.0", "apps/main-2.0"]);

if (!supportedDirectories.has(appDirectory)) {
  process.stderr.write("Usage: node scripts/setup-app.mjs apps/main-1.0|apps/main-2.0\n");
  process.exitCode = 1;
} else {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["ci", "--prefix", path.normalize(appDirectory)], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      AGENT_RECALL_SKIP_STATUSLINE_INSTALL: "1",
    },
  });
  child.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`npm ci stopped by ${signal}.\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}
