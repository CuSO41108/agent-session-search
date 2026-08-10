import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WorkflowScriptRunner } from "./workflow-executors";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function commandFor(runtime: Parameters<WorkflowScriptRunner["run"]>[0]["runtime"], source: string): {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
} {
  if (runtime === "bash") return { command: process.platform === "win32" ? "bash.exe" : "/bin/bash", args: ["-c", source] };
  if (runtime === "python") return { command: process.platform === "win32" ? "python.exe" : "python3", args: ["-c", source] };
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", "--input-type=module", "--eval", source],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export class WorkflowScriptProcessRunner implements WorkflowScriptRunner {
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly workDir: () => string) {}

  run(input: Parameters<WorkflowScriptRunner["run"]>[0]): Promise<{ stdout: string; stderr: string }> {
    const launch = commandFor(input.runtime, input.source);
    const key = `${input.runId}:${input.nodeId}`;
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: this.workDir(),
        env: launch.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.children.set(key, child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        this.children.delete(key);
        if (error) reject(error);
        else resolve({ stdout, stderr });
      };
      const stop = (message: string): void => {
        child.kill();
        finish(new Error(message));
      };
      const abort = (): void => stop("Script execution was cancelled.");
      const timer = setTimeout(() => stop(`Script execution timed out after ${input.timeoutSeconds} seconds.`), input.timeoutSeconds * 1000);
      input.signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stop("Script output exceeded 2 MB.");
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stop("Script output exceeded 2 MB.");
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (code === 0) finish();
        else finish(new Error(`Script exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
      });
      child.stdin.on("error", (error) => finish(error));
      child.stdin.end(input.stdin);
      if (input.signal.aborted) abort();
    });
  }

  async cancel(runId: string, nodeId: string): Promise<void> {
    this.children.get(`${runId}:${nodeId}`)?.kill();
  }
}
