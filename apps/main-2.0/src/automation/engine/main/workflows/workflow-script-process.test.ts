import { describe, expect, test } from "vitest";
import { WorkflowScriptProcessRunner } from "./workflow-script-process";

describe("WorkflowScriptProcessRunner", () => {
  test.runIf(process.platform !== "win32")("runs a Bash Script node with structured stdin and stdout", async () => {
    const runner = new WorkflowScriptProcessRunner(() => process.cwd());
    const result = await runner.run({
      runId: "run",
      nodeId: "script",
      runtime: "bash",
      source: "node -e 'process.stdin.on(\"data\", value => console.log(JSON.stringify({result: JSON.parse(value).name})))'",
      stdin: JSON.stringify({ name: "Workflow" }),
      timeoutSeconds: 5,
      permissions: ["workspace_read"],
      signal: new AbortController().signal,
    });

    expect(JSON.parse(result.stdout)).toEqual({ result: "Workflow" });
    expect(result.stderr).toBe("");
  });

  test.runIf(process.platform !== "win32")("terminates Scripts that exceed their timeout", async () => {
    const runner = new WorkflowScriptProcessRunner(() => process.cwd());
    await expect(runner.run({
      runId: "run",
      nodeId: "slow",
      runtime: "bash",
      source: "sleep 2; echo '{\"result\":true}'",
      stdin: "{}",
      timeoutSeconds: 0.02,
      permissions: ["workspace_read"],
      signal: new AbortController().signal,
    })).rejects.toThrow("timed out");
  });
});
