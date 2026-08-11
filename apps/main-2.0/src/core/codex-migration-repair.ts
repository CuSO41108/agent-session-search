import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGENT_RECALL_ORIGINATORS = new Set(["agent-recall", "agent-recall-v2"]);
const FIRST_LINE_LIMIT = 256 * 1024;
const FIRST_LINE_CHUNK_SIZE = 16 * 1024;
const LEGACY_MESSAGE_ID = /^msg_[0-9a-f-]{36}$/i;
const LEGACY_FUNCTION_CALL_ID = /^fc_[0-9a-f]{64}$/i;
const LEGACY_FUNCTION_OUTPUT_ID = /^fco_[0-9a-f]{64}$/i;
const MIGRATED_CALL_ID = /^call_migrated_[0-9a-f]{24}$/i;

export interface CodexMigrationRepairResult {
  scannedFiles: number;
  repairedFiles: number;
  repairedItemIds: number;
  failedFiles: number;
}

export async function repairLegacyAgentRecallCodexRollouts(
  homeDir = os.homedir(),
): Promise<CodexMigrationRepairResult> {
  const result: CodexMigrationRepairResult = {
    scannedFiles: 0,
    repairedFiles: 0,
    repairedItemIds: 0,
    failedFiles: 0,
  };

  for (const relativeRoot of [path.join(".codex", "sessions"), path.join(".tcodex", "sessions")]) {
    for (const filePath of await listJsonlFiles(path.join(homeDir, relativeRoot))) {
      result.scannedFiles += 1;
      try {
        const repairedItemIds = await repairLegacyRolloutFile(filePath);
        if (repairedItemIds > 0) {
          result.repairedFiles += 1;
          result.repairedItemIds += repairedItemIds;
        }
      } catch {
        // A locked or concurrently removed file is retried on the next startup.
        result.failedFiles += 1;
      }
    }
  }

  return result;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonlFiles(filePath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(filePath);
  }
  return files;
}

async function repairLegacyRolloutFile(filePath: string): Promise<number> {
  const firstRow = await readFirstJsonlRow(filePath);
  const firstPayload = record(firstRow?.payload);
  if (
    firstRow?.type !== "session_meta"
    || !AGENT_RECALL_ORIGINATORS.has(stringField(firstPayload, "originator"))
    || stringField(firstPayload, "cli_version") !== "migration"
  ) {
    return 0;
  }

  const sessionId = stringField(firstPayload, "id");
  if (!sessionId) return 0;

  const content = await fs.promises.readFile(filePath);
  const offsets = legacyItemIdUnderscoreOffsets(content, sessionId, Boolean(firstPayload?.source));
  if (offsets.length === 0) return 0;

  const handle = await fs.promises.open(filePath, "r+");
  let repaired = 0;
  try {
    // Keep every edit byte-for-byte the same length. Codex may already have the
    // rollout open for append, so replacing the file or shifting offsets could
    // detach subsequent turns from the path that the App resumes.
    const current = Buffer.allocUnsafe(1);
    const replacement = Buffer.from("-");
    for (const offset of offsets) {
      const read = await handle.read(current, 0, 1, offset);
      if (read.bytesRead !== 1 || current[0] !== 0x5f) continue;
      await handle.write(replacement, 0, 1, offset);
      repaired += 1;
    }
    if (repaired > 0) await handle.sync();
  } finally {
    await handle.close();
  }
  return repaired;
}

async function readFirstJsonlRow(filePath: string): Promise<Record<string, unknown> | null> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < FIRST_LINE_LIMIT) {
      const buffer = Buffer.allocUnsafe(Math.min(FIRST_LINE_CHUNK_SIZE, FIRST_LINE_LIMIT - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return null;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
      if (newline >= 0) {
        return record(JSON.parse(Buffer.concat(chunks).toString("utf8").trim()));
      }
      position += bytesRead;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function legacyItemIdUnderscoreOffsets(content: Buffer, sessionId: string, hasVsCodeEvents: boolean): number[] {
  const offsets: number[] = [];
  let lineStart = 0;
  let migrationEnded = false;
  let turnIndex = hasVsCodeEvents ? -1 : 0;
  let messageIndex = 0;

  while (lineStart < content.length) {
    const newline = content.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? content.length : newline;
    const line = content.subarray(lineStart, lineEnd);
    let row: Record<string, unknown> | null = null;
    try {
      row = record(JSON.parse(line.toString("utf8")));
    } catch {
      migrationEnded = true;
    }

    const payload = record(row?.payload);
    if (!migrationEnded && row?.type === "event_msg" && payload?.type === "task_started") {
      const nextTurnIndex = turnIndex + 1;
      if (stringField(payload, "turn_id") === deterministicCodexUuid(`${sessionId}:turn:${nextTurnIndex}`)) {
        turnIndex = nextTurnIndex;
      } else if (turnIndex >= 0) {
        migrationEnded = true;
      }
    }

    if (!migrationEnded && row?.type === "response_item" && payload?.type === "message") {
      if (!hasVsCodeEvents && messageIndex > 0 && payload.role === "user") turnIndex += 1;
      const id = stringField(payload, "id");
      const expectedId = `msg_${deterministicCodexUuid(`${sessionId}:turn:${Math.max(0, turnIndex)}:message:${messageIndex}`)}`;
      if (id === expectedId && LEGACY_MESSAGE_ID.test(id)) {
        const offset = idUnderscoreOffset(line, lineStart, id);
        if (offset !== null) offsets.push(offset);
        messageIndex += 1;
      } else {
        migrationEnded = true;
      }
    }

    if (!migrationEnded && row?.type === "response_item" && payload?.type === "function_call") {
      const id = stringField(payload, "id");
      if (
        payload.name === "spawn_agent"
        && payload.namespace === "collaboration"
        && LEGACY_FUNCTION_CALL_ID.test(id)
        && MIGRATED_CALL_ID.test(stringField(payload, "call_id"))
      ) {
        const offset = idUnderscoreOffset(line, lineStart, id);
        if (offset !== null) offsets.push(offset);
      }
    }

    if (!migrationEnded && row?.type === "response_item" && payload?.type === "function_call_output") {
      const id = stringField(payload, "id");
      if (LEGACY_FUNCTION_OUTPUT_ID.test(id) && MIGRATED_CALL_ID.test(stringField(payload, "call_id"))) {
        const offset = idUnderscoreOffset(line, lineStart, id);
        if (offset !== null) offsets.push(offset);
      }
    }

    if (newline < 0) break;
    lineStart = newline + 1;
  }

  return offsets;
}

function idUnderscoreOffset(line: Buffer, lineStart: number, id: string): number | null {
  const token = Buffer.from(`"id":${JSON.stringify(id)}`);
  const tokenOffset = line.indexOf(token);
  const underscoreOffset = token.indexOf(0x5f);
  if (tokenOffset < 0 || underscoreOffset < 0) return null;
  return lineStart + tokenOffset + underscoreOffset;
}

function deterministicCodexUuid(seed: string): string {
  const bytes = Buffer.from(crypto.createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string {
  return typeof value?.[key] === "string" ? value[key] : "";
}
