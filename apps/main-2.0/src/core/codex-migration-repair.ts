import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGENT_RECALL_ORIGINATORS = new Set(["agent-recall", "agent-recall-v2"]);
const FIRST_LINE_LIMIT = 256 * 1024;
const FIRST_LINE_CHUNK_SIZE = 16 * 1024;
const FILE_SCAN_CHUNK_SIZE = 64 * 1024;
const CURRENT_WRITER_PROBE_LIMIT = FIRST_LINE_LIMIT + FIRST_LINE_CHUNK_SIZE;
const REPAIRED_CLI_VERSION = "repair-v1";
const LEGACY_MESSAGE_ID = /^msg_[0-9a-f-]{36}$/i;
const REPAIRED_MESSAGE_ID = /^msg-[0-9a-f-]{36}$/i;
const LEGACY_FUNCTION_CALL_ID = /^fc_[0-9a-f]{64}$/i;
const LEGACY_FUNCTION_OUTPUT_ID = /^fco_[0-9a-f]{64}$/i;
const REPAIRED_FUNCTION_CALL_ID = /^fc-[0-9a-f]{64}$/i;
const REPAIRED_FUNCTION_OUTPUT_ID = /^fco-[0-9a-f]{64}$/i;
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

  const handle = await fs.promises.open(filePath, "r+");
  let repaired = 0;
  try {
    const probe = await readFilePrefix(handle, CURRENT_WRITER_PROBE_LIMIT);
    const currentFirstRow = firstJsonlRow(probe);
    const currentFirstPayload = record(currentFirstRow?.payload);
    if (
      currentFirstRow?.type !== "session_meta"
      || !AGENT_RECALL_ORIGINATORS.has(stringField(currentFirstPayload, "originator"))
      || stringField(currentFirstPayload, "cli_version") !== "migration"
      || stringField(currentFirstPayload, "id") !== sessionId
    ) {
      return 0;
    }
    const probeMarkerOffset = cliVersionValueOffset(probe, 0);
    if (probeMarkerOffset === null) return 0;

    // The current writer never emits the legacy synthetic function rows. Its
    // deterministic first message ID is enough to mark the whole atomic file
    // without reading a potentially huge first message or the remaining turns.
    const currentFirstMessageId = deterministicCodexUuid(`response-item:${sessionId}:turn:0:message:0`);
    if (probe.includes(Buffer.from(`"id":${JSON.stringify(currentFirstMessageId)}`))) {
      await writeRepairMarker(handle, probeMarkerOffset);
      await handle.sync();
      return 0;
    }

    // Scan from the same file descriptor used for the edits. A rollout can be
    // replaced between discovery and repair; keeping discovery and positional
    // writes on one descriptor prevents patching an unrelated file.
    const scan = await scanLegacyItemIds(handle, sessionId);
    if (!scan) return 0;

    // Keep every edit byte-for-byte the same length. Codex may already have the
    // rollout open for append, so replacing the file or shifting offsets could
    // detach subsequent turns from the path that the App resumes.
    for (const rewrite of scan.messageRewrites) {
      const currentPrefix = await readBufferAt(handle, rewrite.original.length, rewrite.offset);
      if (currentPrefix.equals(rewrite.replacement)) continue;
      if (!currentPrefix.equals(rewrite.original)) {
        throw new Error("Legacy Codex rollout changed during repair.");
      }
      await writeBufferAt(handle, rewrite.replacement, rewrite.offset);
      repaired += 1;
    }
    const current = Buffer.allocUnsafe(1);
    const replacement = Buffer.from("-");
    for (const offset of scan.offsets) {
      const read = await handle.read(current, 0, 1, offset);
      if (read.bytesRead !== 1) throw new Error("Legacy Codex rollout changed during repair.");
      if (current[0] === 0x5f) {
        await handle.write(replacement, 0, 1, offset);
        repaired += 1;
      } else if (current[0] !== 0x2d) {
        throw new Error("Legacy Codex rollout changed during repair.");
      }
    }
    if (repaired > 0) await handle.sync();
    if (scan.complete) {
      await writeRepairMarker(handle, scan.cliVersionOffset);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  return repaired;
}

async function readFilePrefix(handle: fs.promises.FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const read = await handle.read(
      buffer,
      bytesRead,
      Math.min(FIRST_LINE_CHUNK_SIZE, buffer.length - bytesRead),
      bytesRead,
    );
    if (read.bytesRead === 0) break;
    bytesRead += read.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

function firstJsonlRow(content: Buffer): Record<string, unknown> | null {
  const newline = content.indexOf(0x0a);
  if (newline < 0 || newline > FIRST_LINE_LIMIT) return null;
  try {
    return record(JSON.parse(content.subarray(0, newline).toString("utf8").trim()));
  } catch {
    return null;
  }
}

async function writeRepairMarker(handle: fs.promises.FileHandle, offset: number): Promise<void> {
  const current = await readBufferAt(handle, REPAIRED_CLI_VERSION.length, offset);
  const value = current.toString("utf8");
  if (value === REPAIRED_CLI_VERSION) return;
  if (value !== "migration") throw new Error("Legacy Codex rollout changed during repair.");
  await writeBufferAt(handle, Buffer.from(REPAIRED_CLI_VERSION), offset);
}

async function readBufferAt(handle: fs.promises.FileHandle, length: number, offset: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let readBytes = 0;
  while (readBytes < buffer.length) {
    const read = await handle.read(buffer, readBytes, buffer.length - readBytes, offset + readBytes);
    if (read.bytesRead === 0) throw new Error("Legacy Codex rollout changed during repair.");
    readBytes += read.bytesRead;
  }
  return buffer;
}

async function writeBufferAt(handle: fs.promises.FileHandle, buffer: Buffer, offset: number): Promise<void> {
  let writtenBytes = 0;
  while (writtenBytes < buffer.length) {
    const write = await handle.write(buffer, writtenBytes, buffer.length - writtenBytes, offset + writtenBytes);
    if (write.bytesWritten === 0) throw new Error("Legacy Codex rollout could not be repaired.");
    writtenBytes += write.bytesWritten;
  }
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

interface LegacyItemIdScan {
  offsets: number[];
  messageRewrites: MessagePrefixRewrite[];
  cliVersionOffset: number;
  complete: boolean;
}

interface MessagePrefixRewrite {
  offset: number;
  original: Buffer;
  replacement: Buffer;
}

async function scanLegacyItemIds(
  handle: fs.promises.FileHandle,
  sessionId: string,
): Promise<LegacyItemIdScan | null> {
  const offsets: number[] = [];
  const messageRewrites: MessagePrefixRewrite[] = [];
  let cliVersionOffset: number | null = null;
  let complete = true;
  let firstLine = true;
  let hasVsCodeEvents = false;
  let turnIndex = 0;
  let messageIndex = 0;

  await visitJsonlLines(handle, (line, lineStart) => {
    let row: Record<string, unknown> | null = null;
    try {
      row = record(JSON.parse(line.toString("utf8")));
    } catch {
      complete = false;
      return true;
    }

    const payload = record(row?.payload);
    if (firstLine) {
      firstLine = false;
      if (
        row?.type !== "session_meta"
        || !AGENT_RECALL_ORIGINATORS.has(stringField(payload, "originator"))
        || stringField(payload, "cli_version") !== "migration"
        || stringField(payload, "id") !== sessionId
      ) {
        complete = false;
        return true;
      }
      cliVersionOffset = cliVersionValueOffset(line, lineStart);
      if (cliVersionOffset === null) {
        complete = false;
        return true;
      }
      hasVsCodeEvents = Boolean(payload?.source);
      turnIndex = hasVsCodeEvents ? -1 : 0;
      return false;
    }

    if (row?.type === "event_msg" && payload?.type === "task_started") {
      const nextTurnIndex = turnIndex + 1;
      if (hasVsCodeEvents && stringField(payload, "turn_id") === deterministicCodexUuid(`${sessionId}:turn:${nextTurnIndex}`)) {
        turnIndex = nextTurnIndex;
      } else {
        return true;
      }
      return false;
    }

    if (row?.type === "event_msg") return false;
    if (row?.type !== "response_item") return true;

    if (payload?.type === "message") {
      const id = stringField(payload, "id");
      if (LEGACY_MESSAGE_ID.test(id) || REPAIRED_MESSAGE_ID.test(id)) {
        // Terminal Codex rollouts have no task_started rows. Recover the
        // monotonic turn index from the writer's deterministic IDs instead of
        // assuming every user message starts a turn.
        const firstCandidate = Math.max(0, turnIndex);
        const lastCandidate = hasVsCodeEvents ? firstCandidate : messageIndex;
        let matchedTurnIndex = -1;
        for (let candidate = firstCandidate; candidate <= lastCandidate; candidate += 1) {
          const migratedUuid = deterministicCodexUuid(`${sessionId}:turn:${candidate}:message:${messageIndex}`);
          if (id === `msg_${migratedUuid}` || id === `msg-${migratedUuid}`) {
            matchedTurnIndex = candidate;
            break;
          }
        }
        if (matchedTurnIndex < 0) return true;
        turnIndex = matchedTurnIndex;
        if (LEGACY_MESSAGE_ID.test(id)) {
          const offset = idUnderscoreOffset(line, lineStart, id);
          if (offset !== null) offsets.push(offset);
        }
      } else if (!id) {
        const rewrite = missingMessageIdRewrite(line, lineStart, stringField(row, "timestamp"), messageIndex);
        if (!rewrite) throw new Error("Unsupported legacy Codex message layout.");
        messageRewrites.push(rewrite);
      } else if (id !== repairedMessageId(messageIndex)) {
        return true;
      }
      messageIndex += 1;
      return false;
    }

    if (payload?.type === "function_call") {
      const id = stringField(payload, "id");
      if (
        payload.name !== "spawn_agent"
        || payload.namespace !== "collaboration"
        || !MIGRATED_CALL_ID.test(stringField(payload, "call_id"))
      ) return true;
      if (LEGACY_FUNCTION_CALL_ID.test(id)) {
        const offset = idUnderscoreOffset(line, lineStart, id);
        if (offset !== null) offsets.push(offset);
      } else if (id && !REPAIRED_FUNCTION_CALL_ID.test(id)) return true;
      return false;
    }

    if (payload?.type === "function_call_output") {
      const id = stringField(payload, "id");
      if (!MIGRATED_CALL_ID.test(stringField(payload, "call_id"))) return true;
      if (LEGACY_FUNCTION_OUTPUT_ID.test(id)) {
        const offset = idUnderscoreOffset(line, lineStart, id);
        if (offset !== null) offsets.push(offset);
      } else if (id && !REPAIRED_FUNCTION_OUTPUT_ID.test(id)) return true;
      return false;
    }

    return true;
  });

  if (firstLine || cliVersionOffset === null) return null;
  return { offsets, messageRewrites, cliVersionOffset, complete };
}

function missingMessageIdRewrite(
  line: Buffer,
  lineStart: number,
  timestamp: string,
  messageIndex: number,
): MessagePrefixRewrite | null {
  const payloadPrefix = Buffer.from('"payload":{"type":"message",');
  const payloadOffset = line.indexOf(payloadPrefix);
  if (payloadOffset < 0 || !line.subarray(0, payloadOffset).includes(Buffer.from('"timestamp":'))) return null;
  const original = Buffer.from(line.subarray(0, payloadOffset + payloadPrefix.length));
  const itemId = repairedMessageId(messageIndex);
  // These older rows have no spare field for an ID. Keep the required
  // timestamp string (normally retaining its date), use the freed precision
  // for a short per-file ID, and pad the prefix so every later byte stays put.
  const availableTimestampLength = Buffer.byteLength(timestamp) - Buffer.byteLength(itemId) - 8;
  if (availableTimestampLength < 0) return null;
  const retainedTimestamp = availableTimestampLength >= 10 && /^\d{4}-\d{2}-\d{2}/.test(timestamp)
    ? timestamp.slice(0, 10)
    : availableTimestampLength >= 4 && /^\d{4}/.test(timestamp)
      ? timestamp.slice(0, 4)
      : "";
  const replacementText = Buffer.from(
    `{"type":"response_item","timestamp":${JSON.stringify(retainedTimestamp)},"payload":{"type":"message","id":"${itemId}",`,
  );
  if (replacementText.length > original.length) return null;
  const replacement = Buffer.alloc(original.length, 0x20);
  replacementText.copy(replacement);
  return { offset: lineStart, original, replacement };
}

function repairedMessageId(messageIndex: number): string {
  return messageIndex.toString(36);
}

async function visitJsonlLines(
  handle: fs.promises.FileHandle,
  visit: (line: Buffer, lineStart: number) => boolean,
): Promise<void> {
  const size = (await handle.stat()).size;
  let position = 0;
  let lineStart = 0;
  let fragments: Buffer[] = [];

  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(FILE_SCAN_CHUNK_SIZE, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline < 0) {
        fragments.push(chunk.subarray(cursor));
        break;
      }
      fragments.push(chunk.subarray(cursor, newline));
      const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
      if (visit(line, lineStart)) return;
      fragments = [];
      cursor = newline + 1;
      lineStart = position + cursor;
    }
    position += bytesRead;
  }

  if (fragments.length > 0) {
    const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
    visit(line, lineStart);
  }
}

function cliVersionValueOffset(lineOrPrefix: Buffer, lineStart: number): number | null {
  const newline = lineOrPrefix.indexOf(0x0a);
  const firstLine = newline < 0 ? lineOrPrefix : lineOrPrefix.subarray(0, newline);
  const prefix = Buffer.from('"cli_version":"');
  const token = Buffer.from('"cli_version":"migration"');
  const tokenOffset = firstLine.indexOf(token);
  return tokenOffset < 0 ? null : lineStart + tokenOffset + prefix.length;
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
