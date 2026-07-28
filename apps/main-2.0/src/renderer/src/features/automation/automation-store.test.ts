import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SNAPSHOT } from "../../../../automation/engine/renderer/src/app/app-state";
import type { AutomationChange } from "../../../../shared/ipc/automation";
import { AutomationStore } from "./automation-store";

function change(sequence: number): AutomationChange {
  return {
    protocolVersion: 1,
    sequence,
    detectedAt: sequence,
    domain: "workflow",
    entityId: "workflow-state",
    operation: "patch",
    payload: { activeWorkflowId: "wf" },
  };
}

describe("AutomationStore", () => {
  it("notifies only store subscribers for incremental changes", () => {
    const store = new AutomationStore(DEFAULT_SNAPSHOT);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.applyChange(change(1))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().workflowStore.activeWorkflowId).toBe("wf");
  });

  it("replaces the bootstrap snapshot and resets sequence tracking", () => {
    const store = new AutomationStore(DEFAULT_SNAPSHOT);
    store.applyChange(change(3));
    const next = { ...DEFAULT_SNAPSHOT, workDir: "C:/repo" };

    store.replace(next);

    expect(store.getSnapshot()).toBe(next);
    expect(store.applyChange(change(1))).toBe(true);
  });
});
