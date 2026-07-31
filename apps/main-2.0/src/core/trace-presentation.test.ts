import { describe, expect, it } from "vitest";
import { normalizeSessionTraceStatus, tracePresentation } from "./trace-presentation";

describe("normalizeSessionTraceStatus", () => {
  it("normalizes legacy status values at read boundaries", () => {
    expect(normalizeSessionTraceStatus("success")).toBe("completed");
    expect(normalizeSessionTraceStatus("failure")).toBe("failed");
    expect(normalizeSessionTraceStatus("running")).toBe("running");
    expect(normalizeSessionTraceStatus("invalid")).toBeNull();
  });
});

describe("tracePresentation", () => {
  it("classifies lifecycle visibility", () => {
    expect(tracePresentation({ kind: "event", eventType: "codex.turn.started" })).toEqual({
      category: "lifecycle",
      visibility: "hidden",
    });
    expect(tracePresentation({ kind: "event", eventType: "codex.turn.completed" })).toEqual({
      category: "lifecycle",
      visibility: "turn_summary",
    });
  });

  it("classifies annotations and collaboration separately from tools", () => {
    for (const eventType of [
      "codex.plan",
      "codex.review.entered",
      "codex.review.exited",
      "codex.goal.updated",
    ]) {
      expect(tracePresentation({ kind: "event", eventType }).category).toBe("annotation");
    }
    for (const eventType of [
      "codex.collaboration.tool",
      "codex.collaboration.activity",
      "codex.collaboration.message",
    ]) {
      expect(tracePresentation({ kind: "event", eventType }).category).toBe("collaboration");
    }
    expect(tracePresentation({ kind: "event", eventType: "codex.reasoning_summary" }).category).toBe("reasoning");
    expect(tracePresentation({ kind: "event", eventType: "codex.context.compaction" }).category).toBe("context");
    expect(tracePresentation({ kind: "event", eventType: "codex.thread.settings" }).category).toBe("context");
    expect(tracePresentation({ kind: "tool_call", eventType: "codex.custom_tool" }).category).toBe("tool");
  });
});
