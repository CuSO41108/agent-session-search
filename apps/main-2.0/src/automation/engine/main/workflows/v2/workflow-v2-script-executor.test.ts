import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2Definition, type WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import { executeWorkflowV2Script } from "./workflow-v2-script-executor";
import { workflowV2ScriptCapabilityDigest, workflowV2ScriptOperationDigest } from "./workflow-v2-script-analysis";

const execFileAsync = promisify(execFile);

describe("workflow-v2 script executor", () => {
  test("executes an auto-authorized inline typescript transform", async () => {
    const node = {
      id: "echo",
      kind: "transform",
      title: "Echo",
      execModel: "script" as const,
      executionMode: "script" as const,
      outputFields: [{ key: "result", required: true }],
      script: {
        executable: { kind: "inline" as const, language: "typescript" as const, code: "return { result: 'ok' };" },
        parameters: [],
        capabilities: [],
        managerRisk: { level: "safe" as const, rationale: "Pure in-memory transform." },
        outputSchema: { type: "object" as const, required: ["result"] },
      },
    };
    const workDir = process.cwd();
    const output = await executeWorkflowV2Script({
      node,
      workDir,
      upstreamOutputs: [],
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      inputs: {},
      authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: "echo", risk: "safe", capabilities: [], capabilityDigest: workflowV2ScriptCapabilityDigest([]), operationDigest: workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir, inputs: {} }) },
    });

    expect(output.outputs).toEqual({ result: "ok" });
    expect(output.scriptReceipt).toMatchObject({ exitCode: 0, timedOut: false, stderrSummary: "", effectState: "none", operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(output.acceptance).toMatchObject({ outcome: "clean", issues: [] });
  });

  test("records stderr and applies warn or fail policy", async () => {
    const makeNode = (stderrPolicy: "warn" | "fail"): WorkflowV2ScriptNode => ({
      id: `stderr-${stderrPolicy}`,
      kind: "command",
      title: "Stderr",
      execModel: "script",
      executionMode: "script",
      outputFields: [{ key: "stdout", required: true }],
      script: {
        executable: { kind: "command", command: process.execPath, args: ["-e", "process.stderr.write('warning'); process.stdout.write('ok')"] },
        parameters: [],
        capabilities: ["process_spawn", "shell_execute"],
        managerRisk: { level: "dangerous", rationale: "Runs a bounded test process." },
        effectMode: "pure",
        idempotency: "safe_retry",
        stderrPolicy,
      },
    });
    const execute = (node: WorkflowV2ScriptNode) => {
      const operationDigest = workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir: process.cwd(), inputs: {} });
      return executeWorkflowV2Script({
        node, workDir: process.cwd(), upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 2_000, inputs: {},
        authorization: { decision: "allow_once", approvalRequestId: "approval", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: node.id, risk: "dangerous", capabilities: ["process_spawn", "shell_execute"], capabilityDigest: workflowV2ScriptCapabilityDigest(["process_spawn", "shell_execute"]), operationDigest },
      });
    };

    await expect(execute(makeNode("warn"))).resolves.toMatchObject({ acceptance: { outcome: "degraded", issues: [expect.objectContaining({ code: "script_stderr" })] }, scriptReceipt: { stderrSummary: "warning" } });
    await expect(execute(makeNode("fail"))).rejects.toMatchObject({ name: "WorkflowV2ScriptExecutionError", receipt: { stderrSummary: "warning" } });
  });

  test("marks a failed legacy command as effect unknown", async () => {
    const node: WorkflowV2ScriptNode = {
      id: "legacy-command", kind: "command", title: "Legacy command", execModel: "script", executionMode: "script", outputFields: [],
      script: {
        executable: { kind: "command", command: process.execPath, args: ["-e", "process.exit(1)"] },
        parameters: [], capabilities: ["process_spawn"], managerRisk: { level: "dangerous", rationale: "Legacy process contract." },
      },
    };
    const operationDigest = workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir: process.cwd(), inputs: {} });
    await expect(executeWorkflowV2Script({
      node, workDir: process.cwd(), upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 2_000, inputs: {},
      authorization: { decision: "allow_once", approvalRequestId: "approval", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: node.id, risk: "dangerous", capabilities: ["process_spawn"], capabilityDigest: workflowV2ScriptCapabilityDigest(["process_spawn"]), operationDigest },
    })).rejects.toMatchObject({ name: "WorkflowV2ScriptExecutionError", receipt: { effectState: "unknown" } });
  });

  test("terminates a timed-out command process tree before a child can keep producing side effects", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-script-tree-"));
    const marker = path.join(workDir, "child-survived.txt");
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 700)`;
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    const node: WorkflowV2ScriptNode = {
      id: "timeout-tree", kind: "command", title: "Timeout tree", execModel: "script", executionMode: "script", outputFields: [],
      script: { executable: { kind: "command", command: process.execPath, args: ["-e", parentCode] }, parameters: [], capabilities: ["process_spawn"], managerRisk: { level: "dangerous", rationale: "Fault injection." }, effectMode: "pure", idempotency: "safe_retry", stderrPolicy: "fail" },
    };
    const operationDigest = workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir, inputs: {} });
    const controller = new AbortController();
    const execution = executeWorkflowV2Script({ node, workDir, upstreamOutputs: [], signal: controller.signal, timeoutMs: 100, inputs: {}, authorization: { decision: "allow_once", approvalRequestId: "approval", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: node.id, risk: "dangerous", capabilities: ["process_spawn"], capabilityDigest: workflowV2ScriptCapabilityDigest(["process_spawn"]), operationDigest } });
    setTimeout(() => controller.abort(new Error("Script timed out.")), 100);
    try {
      await expect(execution).rejects.toMatchObject({ receipt: { timedOut: true, effectState: "unknown" } });
      await new Promise((resolve) => setTimeout(resolve, 900));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 10_000);

  test.each([
    ["synchronous loop", "while (true) {}"],
    ["unsettled promise", "return new Promise(() => {});"],
  ])("times out an inline TypeScript %s without blocking the workflow runtime", async (_name, code) => {
    const node: WorkflowV2ScriptNode = {
      id: "inline-timeout", kind: "transform", title: "Inline timeout", execModel: "script", executionMode: "script", outputFields: [],
      script: { ...createWorkflowV2InlineScriptSpec({ language: "typescript", code, timeoutMs: 25 }), effectMode: "pure", idempotency: "safe_retry", stderrPolicy: "fail" },
    };
    const operationDigest = workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir: process.cwd(), inputs: {} });

    await expect(executeWorkflowV2Script({
      node, workDir: process.cwd(), upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 25, inputs: {},
      authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: node.id, risk: "safe", capabilities: [], capabilityDigest: workflowV2ScriptCapabilityDigest([]), operationDigest },
    })).rejects.toMatchObject({ name: "WorkflowV2ScriptExecutionError", receipt: { timedOut: true, effectState: "unknown" } });
  });

  test("rejects nulls and invalid array items from the script output schema", async () => {
    const node: WorkflowV2ScriptNode = {
      id: "schema", kind: "transform", title: "Schema", execModel: "script", executionMode: "script", outputFields: [{ key: "items", required: true }],
      script: { ...createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { items: ['ok', 1] };" }), outputSchema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } } } },
    };
    const operationDigest = workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir: process.cwd(), inputs: {} });
    await expect(executeWorkflowV2Script({ node, workDir: process.cwd(), upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 2_000, inputs: {}, authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: node.id, risk: "safe", capabilities: [], capabilityDigest: workflowV2ScriptCapabilityDigest([]), operationDigest } })).rejects.toThrow("invalid array item");
  });

  test("rejects an authorization whose capability digest does not match", async () => {
    await expect(executeWorkflowV2Script({
      node: { id: "echo", kind: "transform", title: "Echo", execModel: "script", executionMode: "script", outputFields: [], script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return {};" }) },
      workDir: process.cwd(), upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 2_000, inputs: {},
      authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: "echo", risk: "safe", capabilities: [], capabilityDigest: "stale", operationDigest: "stale" },
    })).rejects.toThrow("capability digest");
  });

  test("collects staged, unstaged, and untracked files inside the selected absolute directory", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "workflow-git-scope-"));
    const reviewDirectory = path.join(repository, "src");
    const outsideDirectory = path.join(repository, "outside");
    await mkdir(reviewDirectory);
    await mkdir(outsideDirectory);
    await execFileAsync("git", ["init"], { cwd: repository });
    await writeFile(path.join(reviewDirectory, "modified.txt"), "before\n", "utf8");
    await writeFile(path.join(outsideDirectory, "ignored.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["-c", "user.name=AgentRecall Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repository });
    await writeFile(path.join(reviewDirectory, "modified.txt"), "after\n", "utf8");
    await writeFile(path.join(reviewDirectory, "staged.txt"), "staged\n", "utf8");
    await execFileAsync("git", ["add", "src/staged.txt"], { cwd: repository });
    await writeFile(path.join(reviewDirectory, "untracked.txt"), "untracked\n", "utf8");
    await writeFile(path.join(outsideDirectory, "ignored.txt"), "outside change\n", "utf8");

    const manifest = JSON.parse(await readFile(
      path.resolve("src/automation/engine/shared/bundled-workflows/code-change-review/workflow.json"),
      "utf8",
    )) as { definition: WorkflowV2Definition };
    const node = manifest.definition.nodes.find((candidate): candidate is WorkflowV2ScriptNode => candidate.id === "collect_changes" && candidate.execModel === "script");
    expect(node).toBeDefined();
    const inputs = { review_directory: reviewDirectory };
    const capabilities = ["workspace_read", "process_spawn", "shell_execute"] as const;
    const output = await executeWorkflowV2Script({
      node: node!,
      workDir: repository,
      upstreamOutputs: [],
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      inputs,
      authorization: {
        decision: "allow_once",
        approvalRequestId: "approval-git-scope",
        workflowId: manifest.definition.workflowId,
        graphVersion: manifest.definition.graphVersion,
        runId: "run-git-scope",
        nodeId: node!.id,
        risk: "dangerous",
        capabilities: [...capabilities],
        capabilityDigest: workflowV2ScriptCapabilityDigest(capabilities),
        operationDigest: workflowV2ScriptOperationDigest({
          workflowId: manifest.definition.workflowId,
          graphVersion: manifest.definition.graphVersion,
          runId: "run-git-scope",
          node: node!,
          workDir: repository,
          inputs,
        }),
      },
    });

    expect(output.outputs).toMatchObject({
      review_directory: await realpath(reviewDirectory),
      staged_files: ["src/staged.txt"],
      unstaged_files: ["src/modified.txt"],
      untracked_files: ["src/untracked.txt"],
      changed_files: ["src/modified.txt", "src/staged.txt", "src/untracked.txt"],
    });
    expect(output.outputs.changed_files).not.toContain("outside/ignored.txt");
  });
});
