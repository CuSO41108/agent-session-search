import type { SessionStoreDatabase } from "./store/database";
import type { SessionSource } from "./types";

const MAX_FAMILY_DEPTH = 12;
const MAX_FAMILY_NODES = 200;

export interface SubagentSessionSummary {
  sessionKey: string;
  rawId: string;
  title: string;
  source: SessionSource;
  environmentId: string;
  environmentLabel: string;
  messageCount: number;
  lastActivityAt: number;
  aiSummary: string | null;
  originTurnIndex?: number | null;
}

export interface SubagentSessionNode extends SubagentSessionSummary {
  children: SubagentSessionNode[];
}

export interface SessionFamily {
  parent: SubagentSessionSummary | null;
  parentOriginTurnIndex?: number | null;
  children: SubagentSessionNode[];
  truncated: boolean;
}

interface SessionFamilyRow {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  environment_label: string | null;
  custom_title: string | null;
  original_title: string;
  first_question: string;
  message_count: number;
  last_activity_at: number;
  ai_summary: string | null;
  parent_session_id: string | null;
}

const EMPTY_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

export function findSessionFamily(
  db: SessionStoreDatabase,
  sessionKey: string,
): SessionFamily {
  const target = db.prepare(`
    SELECT session_key, raw_id, source, environment_id, parent_session_id
    FROM sessions
    WHERE session_key = ?
  `).get(sessionKey) as Pick<
    SessionFamilyRow,
    "session_key" | "raw_id" | "source" | "environment_id" | "parent_session_id"
  > | undefined;
  if (!target) return EMPTY_FAMILY;

  const rows = db.prepare(`
    SELECT
      sessions.session_key,
      sessions.raw_id,
      sessions.source,
      sessions.environment_id,
      environments.label AS environment_label,
      sessions.custom_title,
      sessions.original_title,
      sessions.first_question,
      sessions.message_count,
      sessions.ai_summary,
      sessions.parent_session_id,
      COALESCE(
        (
          SELECT MAX(message_events.timestamp)
          FROM message_events
          WHERE message_events.session_key = sessions.session_key
        ),
        (
          SELECT MAX(CAST(strftime('%s', messages.timestamp) AS INTEGER) * 1000)
          FROM messages
          WHERE messages.session_key = sessions.session_key
        ),
        CASE
          WHEN sessions.file_mtime_ms > 0 THEN sessions.file_mtime_ms
          ELSE sessions.timestamp
        END,
        0
      ) AS last_activity_at
    FROM sessions
    LEFT JOIN environments ON environments.id = sessions.environment_id
    WHERE sessions.source = ?
      AND sessions.environment_id = ?
      AND sessions.hidden = 0
  `).all(target.source, target.environment_id) as unknown as SessionFamilyRow[];
  const originTurnIndexes = findOriginTurnIndexes(
    db,
    rows,
    target.source,
    target.environment_id,
    collectFamilyParentSessionKeys(rows, target),
  );

  rows.sort(compareRows);
  const rowsByRawId = new Map<string, SessionFamilyRow>();
  const childrenByParentId = new Map<string, SessionFamilyRow[]>();
  for (const row of rows) {
    if (!rowsByRawId.has(row.raw_id)) rowsByRawId.set(row.raw_id, row);
    if (!row.parent_session_id) continue;
    const children = childrenByParentId.get(row.parent_session_id) ?? [];
    children.push(row);
    childrenByParentId.set(row.parent_session_id, children);
  }

  let truncated = false;
  let nodeCount = 0;
  const buildChildren = (
    parentRawId: string,
    depth: number,
    path: ReadonlySet<string>,
  ): SubagentSessionNode[] => {
    const candidates = childrenByParentId.get(parentRawId) ?? [];
    if (depth >= MAX_FAMILY_DEPTH) {
      if (candidates.length > 0) truncated = true;
      return [];
    }
    const children: SubagentSessionNode[] = [];
    for (const candidate of candidates) {
      if (path.has(candidate.raw_id)) {
        truncated = true;
        continue;
      }
      if (nodeCount >= MAX_FAMILY_NODES) {
        truncated = true;
        break;
      }
      nodeCount += 1;
      const nextPath = new Set(path);
      nextPath.add(candidate.raw_id);
      children.push({
        ...summaryFrom(candidate, originTurnIndexes.get(candidate.session_key) ?? null),
        children: buildChildren(candidate.raw_id, depth + 1, nextPath),
      });
    }
    return children;
  };

  const parentRow = target.parent_session_id
    ? rowsByRawId.get(target.parent_session_id) ?? null
    : null;
  return {
    parent: parentRow ? summaryFrom(parentRow) : null,
    parentOriginTurnIndex: originTurnIndexes.get(target.session_key) ?? null,
    children: buildChildren(target.raw_id, 0, new Set([target.raw_id])),
    truncated,
  };
}

function summaryFrom(row: SessionFamilyRow, originTurnIndex: number | null = null): SubagentSessionSummary {
  return {
    sessionKey: row.session_key,
    rawId: row.raw_id,
    title: row.custom_title || row.original_title || row.first_question || "Untitled Session",
    source: row.source,
    environmentId: row.environment_id,
    environmentLabel: row.environment_label || (row.environment_id === "local" ? "Local" : row.environment_id),
    messageCount: row.message_count,
    lastActivityAt: row.last_activity_at,
    aiSummary: row.ai_summary?.trim() || null,
    originTurnIndex,
  };
}

interface OriginTraceRow {
  session_key: string;
  trace_index: number;
  timestamp: string;
  source_turn_id: string | null;
  event_type: string | null;
  attributes_json: string | null;
}

interface OriginBoundaryRow {
  session_key: string;
  boundary_order: number;
  timestamp: string;
  source_turn_id: string | null;
}

function collectFamilyParentSessionKeys(
  rows: readonly SessionFamilyRow[],
  target: Pick<SessionFamilyRow, "session_key" | "raw_id" | "parent_session_id">,
): string[] {
  const rowsByRawId = new Map(rows.map((row) => [row.raw_id, row]));
  const childrenByParentId = new Map<string, SessionFamilyRow[]>();
  for (const row of rows) {
    if (!row.parent_session_id) continue;
    const children = childrenByParentId.get(row.parent_session_id) ?? [];
    children.push(row);
    childrenByParentId.set(row.parent_session_id, children);
  }

  const keys = new Set<string>();
  const parent = target.parent_session_id ? rowsByRawId.get(target.parent_session_id) : undefined;
  if (parent) keys.add(parent.session_key);
  const stack = [target.raw_id];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const rawId = stack.pop();
    if (!rawId || visited.has(rawId)) continue;
    visited.add(rawId);
    const row = rowsByRawId.get(rawId);
    if (row) keys.add(row.session_key);
    else if (rawId === target.raw_id) keys.add(target.session_key);
    for (const child of childrenByParentId.get(rawId) ?? []) {
      stack.push(child.raw_id);
    }
  }
  return [...keys];
}

function findOriginTurnIndexes(
  db: SessionStoreDatabase,
  rows: readonly SessionFamilyRow[],
  source: SessionSource,
  environmentId: string,
  parentSessionKeys: readonly string[],
): Map<string, number> {
  if (rows.length === 0 || parentSessionKeys.length === 0) return new Map();
  const keyPlaceholders = parentSessionKeys.map(() => "?").join(", ");
  const traces = db.prepare(`
    SELECT trace_events.session_key, trace_events.trace_index, trace_events.timestamp,
      trace_events.source_turn_id, trace_events.event_type, trace_events.attributes_json
    FROM trace_events
    JOIN sessions ON sessions.session_key = trace_events.session_key
    WHERE sessions.source = ? AND sessions.environment_id = ?
      AND trace_events.session_key IN (${keyPlaceholders})
      AND trace_events.event_type IN (
        'codex.collaboration.tool',
        'codex.collaboration.activity',
        'codex.turn.started'
      )
    ORDER BY trace_events.session_key, trace_events.trace_index
  `).all(source, environmentId, ...parentSessionKeys) as unknown as OriginTraceRow[];
  const userBoundaries = db.prepare(`
    SELECT messages.session_key, messages.message_index AS boundary_order,
      messages.timestamp, messages.source_turn_id
    FROM messages
    JOIN sessions ON sessions.session_key = messages.session_key
    WHERE sessions.source = ? AND sessions.environment_id = ?
      AND messages.session_key IN (${keyPlaceholders})
      AND messages.role = 'user'
    ORDER BY messages.session_key, messages.message_index
  `).all(source, environmentId, ...parentSessionKeys) as unknown as OriginBoundaryRow[];

  const rowsByRawId = new Map(rows.map((row) => [row.raw_id, row]));
  const tracesBySessionKey = groupBySession(traces);
  const boundariesBySessionKey = groupBySession([
    ...userBoundaries,
    ...traces
      .filter((trace) => trace.event_type === "codex.turn.started")
      .map((trace) => ({
        session_key: trace.session_key,
        boundary_order: trace.trace_index,
        timestamp: trace.timestamp,
        source_turn_id: trace.source_turn_id,
      })),
  ]);
  const result = new Map<string, number>();

  for (const child of rows) {
    if (!child.parent_session_id) continue;
    const parent = rowsByRawId.get(child.parent_session_id);
    if (!parent) continue;
    const spawn = (tracesBySessionKey.get(parent.session_key) ?? []).find((trace) =>
      traceSpawnsChild(trace, child.raw_id));
    if (!spawn) continue;
    const boundaries = uniqueTurnBoundaries(boundariesBySessionKey.get(parent.session_key) ?? []);
    const sourceIndex = spawn.source_turn_id
      ? boundaries.findIndex((boundary) => boundary.source_turn_id === spawn.source_turn_id)
      : -1;
    const fallbackIndex = boundaries.reduce((latest, boundary, index) =>
      Date.parse(boundary.timestamp) <= Date.parse(spawn.timestamp) ? index : latest, -1);
    const originTurnIndex = sourceIndex >= 0 ? sourceIndex : fallbackIndex;
    if (originTurnIndex >= 0) result.set(child.session_key, originTurnIndex);
  }
  return result;
}

function groupBySession<T extends { session_key: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const values = grouped.get(row.session_key) ?? [];
    values.push(row);
    grouped.set(row.session_key, values);
  }
  return grouped;
}

function uniqueTurnBoundaries(rows: readonly OriginBoundaryRow[]): OriginBoundaryRow[] {
  const sorted = [...rows].sort((left, right) =>
    Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.boundary_order - right.boundary_order);
  const identifiedTimestamps = sorted
    .filter((row) => row.source_turn_id)
    .map((row) => Date.parse(row.timestamp))
    .filter((value) => Number.isFinite(value));
  const seenSourceTurnIds = new Set<string>();
  return sorted.filter((row) => {
    if (!row.source_turn_id) {
      const timestamp = Date.parse(row.timestamp);
      if (!Number.isFinite(timestamp)) return true;
      return !identifiedTimestamps.some((candidate) => Math.abs(candidate - timestamp) <= 1_000);
    }
    if (seenSourceTurnIds.has(row.source_turn_id)) return false;
    seenSourceTurnIds.add(row.source_turn_id);
    return true;
  });
}

function traceSpawnsChild(trace: OriginTraceRow, childRawId: string): boolean {
  if (!trace.attributes_json) return false;
  try {
    const attributes = JSON.parse(trace.attributes_json) as {
      codex?: { rawType?: unknown };
      collaboration?: {
        kind?: unknown;
        tool?: unknown;
        agentThreadId?: unknown;
        newThreadId?: unknown;
        receiverThreadId?: unknown;
        receiverThreadIds?: unknown;
      };
    };
    const collaboration = attributes.collaboration;
    if (
      trace.event_type === "codex.collaboration.activity"
      && collaboration?.kind === "started"
      && collaboration.agentThreadId === childRawId
    ) {
      return true;
    }
    const rawType = typeof attributes.codex?.rawType === "string" ? attributes.codex.rawType : "";
    const spawn = collaboration?.tool === "spawn_agent" || rawType.startsWith("collab_spawn");
    if (!spawn) return false;
    return collaboration?.newThreadId === childRawId
      || collaboration?.receiverThreadId === childRawId
      || (Array.isArray(collaboration?.receiverThreadIds)
        && collaboration.receiverThreadIds.includes(childRawId));
  } catch {
    return false;
  }
}

function compareRows(left: SessionFamilyRow, right: SessionFamilyRow): number {
  return left.last_activity_at - right.last_activity_at
    || sessionTitle(left).localeCompare(sessionTitle(right))
    || left.session_key.localeCompare(right.session_key);
}

function sessionTitle(row: SessionFamilyRow): string {
  return (row.custom_title || row.original_title || row.first_question || "Untitled Session").toLocaleLowerCase();
}
