import { describe, expect, it } from "vitest";
import {
  reduceWorkflowRunStream,
  workflowRunStreamKey,
} from "./workflow-run-stream";

describe("Workflow Runtime stream state", () => {
  it("clears a restarted node and appends deltas without mixing parallel nodes", () => {
    const nodeA = workflowRunStreamKey("run-1", "node-a");
    const nodeB = workflowRunStreamKey("run-1", "node-b");
    const previous = { [nodeA]: "stale", [nodeB]: "other" };

    const restarted = reduceWorkflowRunStream(previous, {
      runId: "run-1",
      nodeId: "node-a",
      type: "started",
      timestamp: 1,
    });
    const first = reduceWorkflowRunStream(restarted, {
      runId: "run-1",
      nodeId: "node-a",
      type: "delta",
      content: "hello ",
      timestamp: 2,
    });
    const second = reduceWorkflowRunStream(first, {
      runId: "run-1",
      nodeId: "node-a",
      type: "delta",
      content: "world",
      timestamp: 3,
    });

    expect(second).toEqual({
      [nodeA]: "hello world",
      [nodeB]: "other",
    });
  });
});
