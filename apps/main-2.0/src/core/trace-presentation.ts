import type {
  SessionTraceCategory,
  SessionTraceEvent,
  SessionTraceStatus,
  SessionTraceVisibility,
} from "./types";

export interface SessionTracePresentation {
  category: SessionTraceCategory;
  visibility: SessionTraceVisibility;
}

export function normalizeSessionTraceStatus(value: unknown): SessionTraceStatus | null {
  if (value === "success" || value === "completed") return "completed";
  if (value === "failure" || value === "failed") return "failed";
  if (value === "running" || value === "aborted" || value === "unknown") return value;
  return null;
}

export function tracePresentation(
  event: Pick<SessionTraceEvent, "kind" | "eventType">,
): SessionTracePresentation {
  const eventType = event.eventType || "";
  if (eventType === "codex.turn.started" || eventType === "task_started") {
    return { category: "lifecycle", visibility: "hidden" };
  }
  if (
    eventType === "codex.turn.completed"
    || eventType === "codex.turn.aborted"
    || eventType === "task_complete"
    || eventType === "turn_aborted"
  ) {
    return { category: "lifecycle", visibility: "turn_summary" };
  }
  if (eventType === "codex.reasoning_summary" || eventType === "agent_reasoning") {
    return { category: "reasoning", visibility: "timeline" };
  }
  if (
    eventType === "codex.plan"
    || eventType === "codex.review.entered"
    || eventType === "codex.review.exited"
    || eventType === "codex.goal.updated"
  ) {
    return { category: "annotation", visibility: "timeline" };
  }
  if (eventType.startsWith("codex.collaboration.")) {
    return { category: "collaboration", visibility: "timeline" };
  }
  if (
    eventType === "codex.context.compaction"
    || eventType === "codex.thread.settings"
    || eventType === "codex.thread.rolled_back"
    || eventType === "context_compacted"
    || eventType === "thread_rolled_back"
  ) {
    return { category: "context", visibility: "timeline" };
  }
  return { category: "tool", visibility: "timeline" };
}
