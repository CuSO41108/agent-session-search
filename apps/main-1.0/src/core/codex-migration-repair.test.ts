import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repairLegacyAgentRecallCodexRollouts } from "./codex-migration-repair";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";

describe("repairLegacyAgentRecallCodexRollouts", () => {
  it("repairs only the deterministic legacy item ids in AgentRecall migration rollouts", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-migration-repair-"));
    try {
      const v1Path = writeLegacyRollout(homeDir, ".codex", "v1", "agent-recall", true);
      const v2Path = writeLegacyRollout(homeDir, ".codex", "v2", "agent-recall-v2", true);
      const tcodexPath = writeLegacyRollout(homeDir, ".tcodex", "tcodex", "agent-recall-v2", false, "legacy-nondeterministic");
      const partialPath = writeLegacyRollout(homeDir, ".codex", "partial", "agent-recall", true, "repaired");
      const missingMessageIdPath = writeLegacyRollout(homeDir, ".codex", "missing-id", "agent-recall", true, "missing");
      const legacySingleTurnPath = writeLegacyRollout(
        homeDir,
        ".codex",
        "legacy-single-turn",
        "agent-recall",
        true,
        "missing-legacy-turn",
      );
      const currentWriterPath = writeLegacyRollout(homeDir, ".codex", "current", "agent-recall", true, "current");
      const nativePath = path.join(homeDir, ".codex", "sessions", "native.jsonl");
      const nativeContent = `${JSON.stringify({
        type: "session_meta",
        payload: { id: "native", originator: "codex", cli_version: "0.147.0" },
      })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", id: "msg_native" } })}\n`;
      fs.writeFileSync(nativePath, nativeContent);
      const originalSize = fs.statSync(v1Path).size;
      const originalMissingMessageIdSize = fs.statSync(missingMessageIdPath).size;
      const nativeSuffix = `${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "native-turn" } })}\n${JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-10T06:24:27.000Z",
        payload: { type: "message", id: `msg_${"f".repeat(8)}-ffff-4fff-8fff-${"f".repeat(12)}`, role: "user", content: [] },
      })}\n`;
      expect(fs.readFileSync(missingMessageIdPath, "utf8")).toContain(nativeSuffix);

      const result = await repairLegacyAgentRecallCodexRollouts(homeDir);

      expect(result).toEqual({ scannedFiles: 8, repairedFiles: 5, repairedItemIds: 12, failedFiles: 0 });
      for (const filePath of [v1Path, v2Path, partialPath]) {
        const repaired = fs.readFileSync(filePath, "utf8");
        expect(repaired).toContain(`"id":"msg-${legacyMessageUuid()}"`);
      }
      for (const filePath of [v1Path, v2Path, partialPath]) {
        const repaired = fs.readFileSync(filePath, "utf8");
        expect(repaired).toContain(`"id":"fc-${"a".repeat(64)}"`);
        expect(repaired).toContain(`"id":"fco-${"b".repeat(64)}"`);
        expect(repaired).toContain(`"id":"msg_${"f".repeat(8)}-ffff-4fff-8fff-${"f".repeat(12)}"`);
        expect(repaired).toContain("content keeps msg_ text unchanged");
        expect(repaired).toContain('"cli_version":"migrati0n"');
      }
      const repairedMissingMessageId = fs.readFileSync(missingMessageIdPath, "utf8");
      expect(repairedMissingMessageId).toContain('"timestamp":"2026-08-10T06:22:27.000Z","payload":{"type":"message","role":"user"');
      expect(repairedMissingMessageId).toContain(`"id":"fc-${"a".repeat(64)}"`);
      expect(repairedMissingMessageId).toContain(`"id":"fco-${"b".repeat(64)}"`);
      expect(repairedMissingMessageId).toContain('"cli_version":"migrati0n"');
      expect(repairedMissingMessageId).toContain(nativeSuffix);
      const legacySingleTurn = fs.readFileSync(legacySingleTurnPath, "utf8");
      expect(legacySingleTurn).toContain('"cli_version":"migrati0n"');
      expect(legacySingleTurn).toContain('"timestamp":"2026-08-10T06:22:27.000Z","payload":{"type":"message","role":"user"');
      const repairedTcodex = fs.readFileSync(tcodexPath, "utf8");
      expect(repairedTcodex).toContain(`"id":"msg-${legacyMessageUuid()}"`);
      expect(repairedTcodex).toContain(`"id":"msg-${deterministicUuid(`${SESSION_ID}:turn:0:message:1`)}"`);
      expect(repairedTcodex).toContain(`"id":"msg_${"f".repeat(8)}-ffff-4fff-8fff-${"f".repeat(12)}"`);
      expect(repairedTcodex).toContain('"cli_version":"migrati0n"');
      const currentWriter = fs.readFileSync(currentWriterPath, "utf8");
      expect(currentWriter).toContain(`"id":"${currentMessageUuid()}"`);
      expect(currentWriter).toContain('"cli_version":"migrati0n"');
      expect(fs.statSync(v1Path).size).toBe(originalSize);
      expect(fs.statSync(missingMessageIdPath).size).toBe(originalMissingMessageIdSize);
      expect(fs.readFileSync(nativePath, "utf8")).toBe(nativeContent);
      expect(await repairLegacyAgentRecallCodexRollouts(homeDir)).toMatchObject({ repairedFiles: 0, repairedItemIds: 0 });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

function writeLegacyRollout(
  homeDir: string,
  root: string,
  name: string,
  originator: string,
  includeVsCodeEvents: boolean,
  messageId: "legacy" | "legacy-nondeterministic" | "repaired" | "missing" | "missing-legacy-turn" | "current" = "legacy",
): string {
  const filePath = path.join(homeDir, root, "sessions", `${name}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const callId = `call_migrated_${"c".repeat(24)}`;
  const rows = [
    { type: "session_meta", payload: { id: SESSION_ID, originator, cli_version: "migration", ...(includeVsCodeEvents ? { source: "vscode" } : {}) } },
    ...(includeVsCodeEvents
      ? [{
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: messageId === "missing-legacy-turn" ? SESSION_ID : deterministicUuid(`${SESSION_ID}:turn:0`),
          },
        }]
      : []),
    {
      type: "response_item",
      timestamp: "2026-08-10T06:22:27.000Z",
      payload: {
        type: "message",
        ...(messageId === "missing" || messageId === "missing-legacy-turn"
          ? {}
          : {
              id: messageId === "current"
                ? currentMessageUuid()
                : `${messageId === "repaired" ? "msg-" : "msg_"}${legacyMessageUuid()}`,
            }),
        role: "user",
        content: [{ type: "input_text", text: "content keeps msg_ text unchanged" }],
      },
    },
    ...(messageId === "legacy-nondeterministic"
      ? [{
          type: "response_item",
          timestamp: "2026-08-10T06:23:27.000Z",
          payload: {
            type: "message",
            id: `msg_${deterministicUuid(`${SESSION_ID}:turn:0:message:1`)}`,
            role: "user",
            content: [{ type: "input_text", text: "same turn second user message" }],
          },
        }]
      : []),
    ...(includeVsCodeEvents && messageId !== "current" && messageId !== "missing-legacy-turn"
      ? [
          { type: "response_item", payload: { type: "function_call", id: `fc_${"a".repeat(64)}`, name: "spawn_agent", namespace: "collaboration", call_id: callId } },
          { type: "event_msg", payload: { type: "sub_agent_activity", event_id: callId, agent_thread_id: "20000000-0000-4000-8000-000000000002" } },
          { type: "response_item", payload: { type: "function_call_output", id: `fco_${"b".repeat(64)}`, call_id: callId } },
          { type: "event_msg", payload: { type: "task_started", turn_id: "native-turn" } },
        ]
      : []),
    {
      type: "response_item",
      timestamp: "2026-08-10T06:24:27.000Z",
      payload: { type: "message", id: `msg_${"f".repeat(8)}-ffff-4fff-8fff-${"f".repeat(12)}`, role: "user", content: [] },
    },
  ];
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return filePath;
}

function legacyMessageUuid(): string {
  return deterministicUuid(`${SESSION_ID}:turn:0:message:0`);
}

function currentMessageUuid(): string {
  return deterministicUuid(`response-item:${SESSION_ID}:turn:0:message:0`);
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(crypto.createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
