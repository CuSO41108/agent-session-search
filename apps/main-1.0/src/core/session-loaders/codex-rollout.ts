import type {
  CodexHistoryMode,
  CodexIncrementalState,
  SessionMessage,
  SessionTraceEvent,
} from "../types";

type TraceEventDraft = Omit<SessionTraceEvent, "index">;

export type NormalizedCodexFact =
  | {
      kind: "message";
      sourceTurnId: string | null;
      phase: SessionMessage["phase"];
      sourceRecordId: string | null;
      rawType: "response_item.message";
    }
  | {
      kind: "turn_lifecycle";
      event: TraceEventDraft;
    };

export interface CodexRolloutRecordResult {
  message: Extract<NormalizedCodexFact, { kind: "message" }> | null;
  traceEvents: TraceEventDraft[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function unixSecondsToIso(value: unknown): string | null {
  const seconds = nonNegativeNumber(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowTimestamp(row: Record<string, unknown>, preferred: unknown): string {
  return unixSecondsToIso(preferred) || stringValue(row.timestamp);
}

function historyMode(value: unknown): CodexHistoryMode {
  return value === "paginated" ? "paginated" : "legacy";
}

function responseMessageContext(
  payload: Record<string, unknown>,
  fallbackTurnId: string | null,
): Extract<NormalizedCodexFact, { kind: "message" }> | null {
  if (payload.type !== "message") return null;
  const metadata = record(payload.internal_chat_message_metadata_passthrough);
  const explicitTurnId = stringValue(metadata?.turn_id) || fallbackTurnId;
  const rawPhase = stringValue(payload.phase);
  const phase = rawPhase === "commentary" || rawPhase === "final_answer" ? rawPhase : null;
  const itemId = stringValue(payload.id);
  return {
    kind: "message",
    sourceTurnId: explicitTurnId || null,
    phase,
    sourceRecordId: itemId ? `response_item:${itemId}` : null,
    rawType: "response_item.message",
  };
}

function errorDetail(value: unknown): string {
  const error = record(value);
  if (!error) return stringValue(value);
  return stringValue(error.message) || stringValue(error.error) || "";
}

export class CodexRolloutAccumulator {
  private currentHistoryMode: CodexHistoryMode;
  private readonly activeTurnIds = new Set<string>();

  constructor(state?: Pick<CodexIncrementalState, "historyMode" | "activeTurnIds">) {
    this.currentHistoryMode = state?.historyMode ?? "legacy";
    for (const turnId of state?.activeTurnIds ?? []) {
      if (turnId) this.activeTurnIds.add(turnId);
    }
  }

  get historyMode(): CodexHistoryMode {
    return this.currentHistoryMode;
  }

  getActiveTurnIds(): string[] {
    return [...this.activeTurnIds];
  }

  consume(value: unknown): CodexRolloutRecordResult {
    const row = record(value);
    if (!row) return { message: null, traceEvents: [] };
    const payload = record(row.payload);
    if (!payload) return { message: null, traceEvents: [] };

    if (row.type === "session_meta") {
      this.currentHistoryMode = historyMode(payload.history_mode);
      return { message: null, traceEvents: [] };
    }

    const uniqueActiveTurnId = this.activeTurnIds.size === 1
      ? this.activeTurnIds.values().next().value as string
      : null;
    if (row.type === "response_item") {
      return {
        message: responseMessageContext(payload, uniqueActiveTurnId),
        traceEvents: [],
      };
    }
    if (row.type !== "event_msg") return { message: null, traceEvents: [] };

    const rawType = stringValue(payload.type);
    if (rawType === "task_started") {
      const sourceTurnId = stringValue(payload.turn_id) || null;
      if (sourceTurnId) this.activeTurnIds.add(sourceTurnId);
      const startedAt = unixSecondsToIso(payload.started_at) || stringValue(row.timestamp) || null;
      const attributes: Record<string, unknown> = { rawType };
      if (startedAt) attributes.startedAt = startedAt;
      const traceId = stringValue(payload.trace_id);
      if (traceId) attributes.traceId = traceId;
      const modelContextWindow = nonNegativeNumber(payload.model_context_window);
      if (modelContextWindow !== null) attributes.modelContextWindow = modelContextWindow;
      const collaborationModeKind = stringValue(payload.collaboration_mode_kind);
      if (collaborationModeKind) attributes.collaborationModeKind = collaborationModeKind;
      return {
        message: null,
        traceEvents: [{
          kind: "event",
          source: "codex",
          title: "Turn started",
          detail: "",
          timestamp: rowTimestamp(row, payload.started_at),
          callId: null,
          eventType: "codex.turn.started",
          status: "running",
          sourceTurnId,
          attributes,
        }],
      };
    }

    if (rawType === "task_complete") {
      const sourceTurnId = stringValue(payload.turn_id) || uniqueActiveTurnId;
      if (sourceTurnId) this.activeTurnIds.delete(sourceTurnId);
      const startedAt = unixSecondsToIso(payload.started_at);
      const endedAt = unixSecondsToIso(payload.completed_at) || stringValue(row.timestamp) || null;
      const durationMs = nonNegativeNumber(payload.duration_ms);
      const timeToFirstTokenMs = nonNegativeNumber(payload.time_to_first_token_ms);
      const error = errorDetail(payload.error);
      const attributes: Record<string, unknown> = { rawType };
      if (startedAt) attributes.startedAt = startedAt;
      if (endedAt) attributes.endedAt = endedAt;
      if (durationMs !== null) attributes.durationMs = durationMs;
      if (timeToFirstTokenMs !== null) attributes.timeToFirstTokenMs = timeToFirstTokenMs;
      if (error) attributes.error = error;
      return {
        message: null,
        traceEvents: [{
          kind: "event",
          source: "codex",
          title: error ? "Turn failed" : "Turn completed",
          detail: error,
          timestamp: endedAt || stringValue(row.timestamp),
          callId: null,
          eventType: "codex.turn.completed",
          status: error ? "failed" : "completed",
          sourceTurnId,
          attributes,
        }],
      };
    }

    if (rawType === "turn_aborted") {
      const sourceTurnId = stringValue(payload.turn_id) || uniqueActiveTurnId;
      if (sourceTurnId) this.activeTurnIds.delete(sourceTurnId);
      const startedAt = unixSecondsToIso(payload.started_at);
      const endedAt = unixSecondsToIso(payload.completed_at) || stringValue(row.timestamp) || null;
      const durationMs = nonNegativeNumber(payload.duration_ms);
      const abortReason = stringValue(payload.reason);
      const attributes: Record<string, unknown> = { rawType };
      if (startedAt) attributes.startedAt = startedAt;
      if (endedAt) attributes.endedAt = endedAt;
      if (durationMs !== null) attributes.durationMs = durationMs;
      if (abortReason) attributes.abortReason = abortReason;
      return {
        message: null,
        traceEvents: [{
          kind: "event",
          source: "codex",
          title: "Turn aborted",
          detail: abortReason,
          timestamp: endedAt || stringValue(row.timestamp),
          callId: null,
          eventType: "codex.turn.aborted",
          status: "aborted",
          sourceTurnId,
          attributes,
        }],
      };
    }

    return { message: null, traceEvents: [] };
  }
}
