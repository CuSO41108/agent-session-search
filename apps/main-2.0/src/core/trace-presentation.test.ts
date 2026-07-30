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
    expect(tracePresentation({ kind: "event", eventType: "codex.plan" }).category).toBe("annotation");
    expect(tracePresentation({ kind: "event", eventType: "codex.collaboration.activity" }).category).toBe("collaboration");
    expect(tracePresentation({ kind: "tool_call", eventType: "codex.custom_tool" }).category).toBe("tool");
  });
});
