import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { cleanTitle } from "../format-adapters";
import type { LoadedSession, SessionTraceEvent, TokenUsage, TokenUsageEvent } from "../types";
import {
  createIndexedSession,
  createTokenUsage,
  dedupeTraceEvents,
  extractMessages,
  firstQuestion,
  firstStringField,
  isRecord,
  numberField,
  objectField,
  parseMaybeJson,
  parseTimestampMs,
  putTokenEvent,
  readJsonl,
  safeStat,
  shouldSkipFile,
  stringifyDetail,
  stringField,
  titleWithSummary,
  tokenEvent,
  tokenUsageFromEvents,
  unknownField,
  walkJsonlFiles,
  type SessionLoadOptions,
  type TraceEventDraft,
  type VirtualSessionFileStat,
} from "./common";
import { workBuddySessionIdentity } from "./workbuddy-paths";

const WORKBUDDY_DIR = ".workbuddy";

function workBuddySessionMeta(rows: unknown[]): { projectPath: string; timestamp: number; title: string } {
  let projectPath = "";
  let timestamp = 0;
  let title = "";
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (!projectPath) projectPath = stringField(row, "cwd");
    const rowTimestamp = parseTimestampMs(row.timestamp);
    if (rowTimestamp && (!timestamp || rowTimestamp < timestamp)) timestamp = rowTimestamp;
    if (!title && row.type === "ai-title") title = stringField(row, "aiTitle").trim();
  }
  return { projectPath, timestamp, title };
}

function optionalNumberField(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function firstPresentNumber(...values: Array<number | null>): number {
  return values.find((value): value is number => value !== null) ?? 0;
}

function firstNonZero(...values: number[]): number {
  return values.find((value) => value > 0) ?? 0;
}

function maxNumberField(value: unknown, keys: string[]): number {
  if (!isRecord(value)) return 0;
  return Math.max(0, ...keys.map((key) => numberField(value, key)));
}

function maxDetailNumber(value: unknown, keys: string[]): number {
  const details = Array.isArray(value) ? value : [value];
  return Math.max(0, ...details.map((detail) => maxNumberField(detail, keys)));
}

function workBuddyUsage(row: Record<string, unknown>): { usage: TokenUsage; messageId: string } | null {
  const providerData = objectField(row, "providerData");
  const message = objectField(row, "message");
  const usage = objectField(providerData, "usage");
  const rawUsage = objectField(providerData, "rawUsage");
  const messageUsage = objectField(message, "usage");
  if (!usage && !rawUsage && !messageUsage) return null;

  const totalInput = firstPresentNumber(
    optionalNumberField(usage, "inputTokens"),
    optionalNumberField(messageUsage, "input_tokens"),
    optionalNumberField(rawUsage, "prompt_tokens"),
  );
  const cacheRead = firstNonZero(
    numberField(rawUsage, "prompt_cache_hit_tokens"),
    numberField(messageUsage, "cache_read_input_tokens"),
    numberField(rawUsage, "cache_read_input_tokens"),
    numberField(usage, "cacheReadInputTokens"),
    maxDetailNumber(unknownField(rawUsage, "prompt_tokens_details"), ["cached_tokens"]),
    maxDetailNumber(unknownField(usage, "inputTokensDetails"), ["cached_tokens"]),
  );
  const cacheCreation = Math.max(
    numberField(rawUsage, "cache_creation_input_tokens"),
    numberField(rawUsage, "prompt_cache_write_tokens"),
  );
  const output = firstPresentNumber(
    optionalNumberField(usage, "outputTokens"),
    optionalNumberField(messageUsage, "output_tokens"),
    optionalNumberField(rawUsage, "completion_tokens"),
  );
  const reasoning = firstNonZero(
    numberField(rawUsage, "completion_thinking_tokens"),
    numberField(objectField(rawUsage, "completion_tokens_details"), "reasoning_tokens"),
  );
  if (!totalInput && !output && !cacheRead && !cacheCreation && !reasoning) return null;

  return {
    usage: createTokenUsage(
      Math.max(0, totalInput - cacheRead),
      Math.max(0, output),
      cacheRead,
      reasoning,
      cacheCreation,
    ),
    messageId: stringField(providerData, "messageId"),
  };
}

function extractWorkBuddyTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const events = new Map<string, TokenUsageEvent>();
  rows.forEach((row) => {
    if (!isRecord(row)) return;
    const parsed = workBuddyUsage(row);
    if (!parsed) return;
    const rawKey = parsed.messageId || stringField(row, "id") || stringField(row, "callId");
    if (!rawKey) return;
    const dedupeKey = rawKey.startsWith("workbuddy:") ? rawKey : `workbuddy:${rawKey}`;
    putTokenEvent(events, {
      ...tokenEvent(
        parseTimestampMs(row.timestamp),
        dedupeKey,
        parsed.usage.inputTokens,
        parsed.usage.outputTokens,
        parsed.usage.cachedInputTokens,
        parsed.usage.reasoningOutputTokens,
        parsed.usage.cacheCreationInputTokens,
      ),
    });
  });
  return [...events.values()];
}

function workBuddyOutputDetail(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const text = output
      .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (isRecord(output) && typeof output.text === "string") return output.text;
  return stringifyDetail(output);
}

function extractWorkBuddyTraceEvents(rows: unknown[]): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];
  const namesByCallId = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const timestampMs = parseTimestampMs(row.timestamp);
    const timestamp = timestampMs ? new Date(timestampMs).toISOString() : "";
    const callId = stringField(row, "callId") || null;
    if (row.type === "function_call") {
      if (!callId) continue;
      const name = stringField(row, "name");
      if (!name) continue;
      const input = parseMaybeJson(unknownField(row, "arguments"));
      if (callId) namesByCallId.set(callId, name);
      events.push({
        kind: "tool_call",
        source: "workbuddy",
        title: titleWithSummary(name, firstStringField(input, ["command", "cmd", "path", "file_path", "query", "url"])),
        detail: stringifyDetail(input),
        timestamp,
        callId,
        eventType: "workbuddy.function_call",
        status: "running",
        attributes: { input },
      });
    } else if (row.type === "function_call_result") {
      if (!callId) continue;
      const callName = stringField(row, "name") || namesByCallId.get(callId);
      if (!callName) continue;
      const output = parseMaybeJson(unknownField(row, "output"));
      events.push({
        kind: "tool_result",
        source: "workbuddy",
        title: `${callName} result`,
        detail: workBuddyOutputDetail(output),
        timestamp,
        callId,
        eventType: "workbuddy.function_call_result",
        status: row.isError === true || row.status === "failed" || row.status === "error" ? "failed" : "completed",
        attributes: { output },
      });
    }
  }
  return dedupeTraceEvents(events);
}

export function loadWorkBuddySessionRows(
  filePath: string,
  rows: unknown[],
  projectsDir: string,
  stat: VirtualSessionFileStat = safeStat(filePath),
): LoadedSession | null {
  if (rows.length === 0) return null;
  const identity = workBuddySessionIdentity(projectsDir, filePath);
  if (!identity) return null;
  const meta = workBuddySessionMeta(rows);
  const messages = extractMessages(rows, "workbuddy");
  const question = firstQuestion(messages);
  const tokenEvents = extractWorkBuddyTokenEvents(rows);
  const traceEvents = extractWorkBuddyTraceEvents(rows);
  if (messages.length === 0 && traceEvents.length === 0) return null;
  return {
    session: createIndexedSession({
      keyPrefix: "workbuddy",
      rawId: identity.rawId,
      source: "workbuddy-cli",
      projectPath: meta.projectPath,
      filePath,
      originalTitle: meta.title || cleanTitle(question) || "Untitled Session",
      firstQuestion: cleanTitle(question),
      timestamp: meta.timestamp,
      tokenUsage: tokenUsageFromEvents(tokenEvents),
      stat,
      isSubagent: identity.isSubagent,
      parentSessionId: identity.parentSessionId,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

export function loadWorkBuddySessionFile(
  filePath: string,
  projectsDir: string,
  stat = safeStat(filePath),
): LoadedSession | null {
  return loadWorkBuddySessionRows(filePath, readJsonl(filePath), projectsDir, stat);
}

export function* loadWorkBuddySessionsIterator(
  workBuddyDir = path.join(os.homedir(), WORKBUDDY_DIR),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const projectsDir = path.join(workBuddyDir, "projects");
  if (!fs.existsSync(projectsDir)) return;
  for (const filePath of walkJsonlFiles(projectsDir)) {
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadWorkBuddySessionFile(filePath, projectsDir, stat);
    if (loaded) yield loaded;
  }
}

export function loadWorkBuddySessions(
  workBuddyDir = path.join(os.homedir(), WORKBUDDY_DIR),
): LoadedSession[] {
  return [...loadWorkBuddySessionsIterator(workBuddyDir)];
}
