// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowAgentNode, WorkflowDefinition, WorkflowRun } from "../../../../automation/engine/shared/workflow/model";

const api = vi.hoisted(() => ({
  getWorkflowCore: vi.fn(),
  onWorkflowRunStream: vi.fn(() => () => undefined),
}));

vi.mock("../../../../automation/engine/renderer/src/app/services/agent-recall-service", () => ({
  agentRecallAutomationService: () => api,
}));

vi.mock("./automation-provider", () => ({
  useAutomationStoreSnapshot: () => ({
    configuredAgents: [{ id: "agent-1", name: "Claude Code" }],
    workDir: "/workspace/project",
  }),
}));

vi.mock("./workflow-graph-canvas", () => ({
  WorkflowGraphCanvas: ({ onSelectNode }: { onSelectNode: (nodeId: string) => void }) => (
    <button type="button" data-testid="workflow-graph" onClick={() => onSelectNode("inspect-code")}>Workflow graph</button>
  ),
}));

import { WorkflowFeaturePage } from "./workflow-feature-page";

function runningWorkflow(): { definition: WorkflowDefinition; run: WorkflowRun } {
  const node: WorkflowAgentNode = {
    id: "inspect-code",
    kind: "agent",
    title: "检查代码",
    goal: "理解代码结构",
    inputs: [],
    outputs: [{ key: "summary", name: "摘要", description: "代码摘要", type: "text", required: true }],
    acceptanceCriteria: ["给出摘要"],
    agentId: "agent-1",
    instructions: ["检查工作目录"],
    constraints: [],
  };
  const definition: WorkflowDefinition = {
    id: "workflow-1",
    name: "代码检查",
    description: "检查当前代码",
    inputs: [],
    nodes: [node],
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    definition,
    run: {
      id: "run-1",
      workflowId: definition.id,
      definition,
      inputs: {},
      status: "running",
      nodeRuns: {
        [node.id]: {
          nodeId: node.id,
          status: "running",
          attempt: 1,
          resolvedInputs: { existingResume: "很长的输入内容".repeat(400) },
          startedAt: 2,
        },
      },
      events: [{ sequence: 1, type: "node_started", timestamp: 2, nodeId: node.id, attempt: 1 }],
      startedAt: 2,
    },
  };
}

function completedWorkflow(): { definition: WorkflowDefinition; run: WorkflowRun } {
  const snapshot = runningWorkflow();
  const node = snapshot.definition.nodes[0] as WorkflowAgentNode;
  node.outputs = [
    { key: "architecture", name: "现有架构", description: "架构摘要", type: "text", required: true },
    { key: "constraints", name: "实现约束", description: "约束列表", type: "list", required: true },
    { key: "extensionPoints", name: "可复用扩展点", description: "扩展点列表", type: "list", required: true },
  ];
  snapshot.run.status = "completed";
  snapshot.run.finishedAt = 4;
  snapshot.run.nodeRuns[node.id] = {
    nodeId: node.id,
    status: "completed",
    attempt: 1,
    resolvedInputs: { requirement: "分析当前项目" },
    outputs: {
      architecture: "第一段架构说明。\n\n第二段架构说明。",
      constraints: ["第一项", "第二项"],
      extensionPoints: [{ point: "新增会话来源", evidence: "types.ts" }],
    },
    startedAt: 2,
    finishedAt: 4,
  };
  snapshot.run.events = [
    { sequence: 1, type: "node_started", timestamp: 2, nodeId: node.id, attempt: 1 },
    { sequence: 2, type: "node_completed", timestamp: 4, nodeId: node.id, attempt: 1, durationMs: 2 },
  ];
  return snapshot;
}

describe("WorkflowFeaturePage live output", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const snapshot = runningWorkflow();
    api.getWorkflowCore.mockResolvedValue({ definitions: [snapshot.definition], runs: [snapshot.run] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a pre-delta waiting state above long resolved inputs for a running Agent node", async () => {
    await act(async () => {
      root.render(<WorkflowFeaturePage language="zh" globalReviewEnabled runtimeReviewEnabled />);
      await Promise.resolve();
    });
    const runTab = [...container.querySelectorAll<HTMLButtonElement>(".workflow-core-mode button")]
      .find((button) => button.textContent?.includes("Current run"));
    if (!runTab) throw new Error("Current run tab was not rendered");

    await act(async () => {
      runTab.click();
      await Promise.resolve();
    });

    const liveOutput = container.querySelector<HTMLElement>(".workflow-core-live-output");
    const resolvedInputs = container.querySelector<HTMLElement>(".workflow-core-run-data");
    expect(liveOutput).not.toBeNull();
    expect(liveOutput!.textContent).toContain("正在等待 Agent 输出");
    expect(resolvedInputs).not.toBeNull();
    expect(liveOutput!.compareDocumentPosition(resolvedInputs!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("renders validated outputs as readable paragraphs, lists, and properties", async () => {
    const snapshot = completedWorkflow();
    api.getWorkflowCore.mockResolvedValue({ definitions: [snapshot.definition], runs: [snapshot.run] });
    await act(async () => {
      root.render(<WorkflowFeaturePage language="zh" globalReviewEnabled runtimeReviewEnabled />);
      await Promise.resolve();
    });
    const runTab = [...container.querySelectorAll<HTMLButtonElement>(".workflow-core-mode button")]
      .find((button) => button.textContent?.includes("Current run"));
    if (!runTab) throw new Error("Current run tab was not rendered");
    await act(async () => {
      runTab.click();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='workflow-graph']")?.click();
      await Promise.resolve();
    });

    const output = [...container.querySelectorAll<HTMLDetailsElement>(".workflow-core-run-disclosure")]
      .find((details) => details.querySelector("summary")?.textContent?.includes("输出"));
    if (!output) throw new Error("Output disclosure was not rendered");
    expect(output.querySelector("pre")).toBeNull();
    expect(output.querySelectorAll(".workflow-core-run-paragraph")).toHaveLength(2);
    expect([...output.querySelectorAll(".workflow-core-run-list > li")].map((item) => item.textContent))
      .toEqual(expect.arrayContaining(["第一项", "第二项"]));
    expect(output.textContent).toContain("新增会话来源");
    expect(output.textContent).toContain("types.ts");
  });
});
