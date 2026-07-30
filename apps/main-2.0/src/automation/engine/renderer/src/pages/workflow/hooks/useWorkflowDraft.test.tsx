// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, WorkflowDraftState, WorkflowV2Definition } from "../../../../../shared/types";
import type { WorkflowService } from "../../../app/services/workflow-service";
import { useWorkflowDraft, type WorkflowDraftController } from "./useWorkflowDraft";

const initialDefinition: WorkflowV2Definition = { workflowId: "draft", graphVersion: 1, objective: "", nodes: [], edges: [] };
const workflows = {} as WorkflowService;

function workflow(workflowId: string, started = false): WorkflowDraftState {
  return {
    workflowId, title: workflowId, status: "draft", revision: 1, configuredAgentId: "", modelId: "", reviewerConfiguredAgentId: "", reviewerModelId: "", objective: "",
    definition: { ...initialDefinition, workflowId },
    messages: started ? [{ id: `${workflowId}-assistant`, role: "assistant", content: "What should happen next?" }] : [],
    reply: "", error: undefined, runProgress: [], runContextDocument: "", contextDocument: "", runIds: [], createdAt: 1, updatedAt: 1,
  };
}

function snapshot(activeWorkflow: WorkflowDraftState): AppSnapshot {
  return { workflowDraft: activeWorkflow, configuredAgents: [], channels: [] } as unknown as AppSnapshot;
}

function Harness({ value, capture }: { value: AppSnapshot; capture: (controller: WorkflowDraftController) => void }) {
  const snapshotRef = useRef(value);
  snapshotRef.current = value;
  capture(useWorkflowDraft({
    snapshot: value,
    setSnapshot: () => undefined,
    snapshotRef,
    initialWorkflowDefinition: initialDefinition,
    workflows,
    configuredAgents: [],
    channels: [],
  }));
  return null;
}

describe("useWorkflowDraft local input drafts", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: WorkflowDraftController;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(value: AppSnapshot): Promise<void> {
    await act(async () => root.render(<Harness value={value} capture={(next) => { controller = next; }} />));
  }

  it("restores each workflow's unsubmitted objective after switching away and back", async () => {
    const workflowA = workflow("workflow-a");
    const workflowB = workflow("workflow-b");
    await render(snapshot(workflowA));
    await act(async () => controller.setWorkflowObjective("draft for A"));

    await render(snapshot(workflowB));
    expect(controller.workflowObjective).toBe("");
    await act(async () => controller.setWorkflowObjective("draft for B"));

    await render(snapshot(workflowA));
    expect(controller.workflowObjective).toBe("draft for A");
    await render(snapshot(workflowB));
    expect(controller.workflowObjective).toBe("draft for B");
  });

  it("captures a typed value synchronously before an immediate workflow switch", async () => {
    const workflowA = workflow("workflow-a");
    const workflowB = workflow("workflow-b");
    await render(snapshot(workflowA));

    await act(async () => {
      controller.setWorkflowObjective("last typed value");
      root.render(<Harness value={snapshot(workflowB)} capture={(next) => { controller = next; }} />);
    });
    await render(snapshot(workflowA));

    expect(controller.workflowObjective).toBe("last typed value");
  });

  it("restores each started workflow's unsubmitted reply after switching away and back", async () => {
    const workflowA = workflow("workflow-a", true);
    const workflowB = workflow("workflow-b", true);
    await render(snapshot(workflowA));
    await act(async () => controller.setWorkflowReply("reply for A"));

    await render(snapshot(workflowB));
    expect(controller.workflowReply).toBe("");
    await act(async () => controller.setWorkflowReply("reply for B"));

    await render(snapshot(workflowA));
    expect(controller.workflowReply).toBe("reply for A");
    await render(snapshot(workflowB));
    expect(controller.workflowReply).toBe("reply for B");
  });

  it("captures a reply synchronously before an immediate workflow switch", async () => {
    const workflowA = workflow("workflow-a", true);
    const workflowB = workflow("workflow-b", true);
    await render(snapshot(workflowA));

    await act(async () => {
      controller.setWorkflowReply("last typed reply");
      root.render(<Harness value={snapshot(workflowB)} capture={(next) => { controller = next; }} />);
    });
    await render(snapshot(workflowA));

    expect(controller.workflowReply).toBe("last typed reply");
  });

  it("does not restore a reply after it has been submitted", async () => {
    const workflowA = workflow("workflow-a", true);
    const workflowB = workflow("workflow-b", true);
    const sendDraftReply = vi.fn(async () => snapshot(workflowA));
    Reflect.set(workflows, "sendDraftReply", sendDraftReply);
    await render(snapshot(workflowA));
    await act(async () => controller.setWorkflowReply("submit me"));

    try {
      await act(async () => controller.sendWorkflowReply());
      expect(sendDraftReply).toHaveBeenCalledWith({ workflowId: "workflow-a", reply: "submit me" });
      await render(snapshot(workflowB));
      await render(snapshot(workflowA));
      expect(controller.workflowReply).toBe("");
    } finally {
      Reflect.deleteProperty(workflows, "sendDraftReply");
    }
  });

  it("resets only the active workflow's retained reply", async () => {
    const workflowA = workflow("workflow-a", true);
    const workflowB = workflow("workflow-b", true);
    await render(snapshot(workflowA));
    await act(async () => controller.setWorkflowReply("keep A"));
    await render(snapshot(workflowB));
    await act(async () => controller.setWorkflowReply("discard B"));
    await act(async () => controller.resetWorkflowLocalDraft());

    await render(snapshot(workflowA));
    expect(controller.workflowReply).toBe("keep A");
    await render(snapshot(workflowB));
    expect(controller.workflowReply).toBe("");
  });

  it("clears the active workflow's retained objective when its local draft is reset", async () => {
    const workflowA = workflow("workflow-a");
    const workflowB = workflow("workflow-b");
    await render(snapshot(workflowA));
    await act(async () => controller.setWorkflowObjective("discard me"));
    await act(async () => controller.resetWorkflowLocalDraft());
    await render(snapshot(workflowB));
    await render(snapshot(workflowA));

    expect(controller.workflowObjective).toBe("");
  });
});
