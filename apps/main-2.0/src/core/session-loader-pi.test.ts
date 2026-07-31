import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDefaultSessions, loadDefaultSessionsAsyncIterator } from "./session-loader";
import type { LoadedSession } from "./types";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-pi-v2-"));
  temporaryHomes.push(homeDir);
  return homeDir;
}

function piSessionPath(homeDir: string, fileName: string): string {
  return path.join(homeDir, ".pi", "agent", "sessions", "--work-pi--", fileName);
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));
}

afterEach(() => {
  for (const homeDir of temporaryHomes.splice(0)) {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

describe("Pi session loading", () => {
  it("loads the active v3 parent chain while retaining complete token usage", async () => {
    const homeDir = temporaryHome();
    const filePath = path.join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--work-pi--",
      "2026-07-31T02-39-01-167Z_pi-session.jsonl",
    );
    writeJsonl(filePath, [
      { type: "session", version: 3, id: "pi-session", timestamp: "2026-07-31T02:39:01.167Z", cwd: "/work/pi" },
      { type: "session_info", id: "info-1", parentId: null, timestamp: "2026-07-31T02:39:01.167Z", name: "Initial name" },
      { type: "model_change", id: "model-1", parentId: "info-1", timestamp: "2026-07-31T02:39:01.179Z", provider: "openai", modelId: "gpt-test" },
      {
        type: "message",
        id: "user-1",
        parentId: "model-1",
        timestamp: "2026-07-31T02:39:01.181Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Searchable Pi question" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-07-31T02:39:01.208Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the file." },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/app.ts" } },
          ],
          usage: { input: 10, output: 6, cacheRead: 2, cacheWrite: 3, reasoning: 2, totalTokens: 21 },
        },
      },
      {
        type: "message",
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-07-31T02:39:01.220Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "export const value = 1;" }],
          isError: false,
        },
      },
      { type: "session_info", id: "info-2", parentId: "tool-1", timestamp: "2026-07-31T02:39:01.230Z", name: "Real Pi title" },
      {
        type: "message",
        id: "abandoned-user",
        parentId: "info-2",
        timestamp: "2026-07-31T02:40:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Abandoned branch" }] },
      },
      {
        type: "message",
        id: "abandoned-assistant",
        parentId: "abandoned-user",
        timestamp: "2026-07-31T02:40:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Abandoned answer" }],
          usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 6 },
        },
      },
      {
        type: "message",
        id: "active-user",
        parentId: "info-2",
        timestamp: "2026-07-31T02:41:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Active branch" }] },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        timestamp: "2026-07-31T02:41:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Active answer" }],
          usage: { input: 5, output: 3, cacheRead: 1, cacheWrite: 0, reasoning: 1, totalTokens: 9 },
        },
      },
    ]);

    expect(loadDefaultSessions({ homeDir })).not.toContainEqual(
      expect.objectContaining({ session: expect.objectContaining({ source: "pi-cli" }) }),
    );
    const [loaded] = loadDefaultSessions({ homeDir, includePi: true })
      .filter((item) => item.session.source === "pi-cli");
    expect(loaded.session).toMatchObject({
      sessionKey: "pi:pi-session",
      source: "pi-cli",
      projectPath: "/work/pi",
      originalTitle: "Real Pi title",
      firstQuestion: "Searchable Pi question",
      timestamp: Date.parse("2026-07-31T02:39:01.167Z"),
      tokenUsage: {
        inputTokens: 19,
        outputTokens: 8,
        cachedInputTokens: 6,
        reasoningOutputTokens: 3,
        totalTokens: 36,
      },
    });
    expect(loaded.messages.map(({ content }) => content)).toEqual([
      "Searchable Pi question",
      "Reading the file.",
      "Active branch",
      "Active answer",
    ]);
    expect(loaded.messages[0]?.attachments?.[0]).toMatchObject({
      mimeType: "image/png",
      source: { kind: "inline", value: "aGVsbG8=" },
    });
    expect(loaded.traceEvents).toEqual([
      expect.objectContaining({ kind: "tool_call", source: "pi", callId: "call-1", title: "read · src/app.ts" }),
      expect.objectContaining({ kind: "tool_result", source: "pi", callId: "call-1", status: "success" }),
    ]);

    const asyncLoaded: LoadedSession[] = [];
    for await (const item of loadDefaultSessionsAsyncIterator({ homeDir, includePi: true })) {
      if (item.session.source === "pi-cli") asyncLoaded.push(item);
    }
    expect(asyncLoaded.map((item) => item.session.sessionKey)).toEqual(["pi:pi-session"]);
  });

  it("loads v1 sessions as a linear transcript without message IDs", () => {
    const homeDir = temporaryHome();
    writeJsonl(piSessionPath(homeDir, "v1-linear.jsonl"), [
      { type: "session", version: 1, id: "pi-v1", timestamp: "2026-07-31T03:00:00.000Z", cwd: "/work/pi-v1" },
      {
        type: "message",
        timestamp: "2026-07-31T03:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Linear Pi question" }] },
      },
      {
        type: "message",
        timestamp: "2026-07-31T03:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Linear Pi answer" }] },
      },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir, includePi: true })
      .filter((item) => item.session.source === "pi-cli");

    expect(loaded.session).toMatchObject({
      sessionKey: "pi:pi-v1",
      projectPath: "/work/pi-v1",
      originalTitle: "Linear Pi question",
      firstQuestion: "Linear Pi question",
    });
    expect(loaded.messages.map(({ content }) => content)).toEqual(["Linear Pi question", "Linear Pi answer"]);
  });

  it("uses the first user message when the latest Pi session name is empty", () => {
    const homeDir = temporaryHome();
    writeJsonl(piSessionPath(homeDir, "empty-name.jsonl"), [
      { type: "session", version: 3, id: "pi-empty-name", timestamp: "2026-07-31T04:00:00.000Z", cwd: "/work/pi-empty" },
      { type: "session_info", id: "info-1", parentId: null, timestamp: "2026-07-31T04:00:01.000Z", name: "Old title" },
      {
        type: "message",
        id: "user-1",
        parentId: "info-1",
        timestamp: "2026-07-31T04:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "Question title fallback" }] },
      },
      { type: "session_info", id: "info-2", parentId: "user-1", timestamp: "2026-07-31T04:00:03.000Z", name: "   " },
    ]);

    const [loaded] = loadDefaultSessions({ homeDir, includePi: true })
      .filter((item) => item.session.source === "pi-cli");

    expect(loaded.session).toMatchObject({
      originalTitle: "Question title fallback",
      firstQuestion: "Question title fallback",
    });
  });

  it("keeps parsing after unknown rows and malformed JSON lines", () => {
    const homeDir = temporaryHome();
    const filePath = piSessionPath(homeDir, "malformed-line.jsonl");
    const rows = [
      { type: "session", version: 1, id: "pi-malformed", timestamp: "2026-07-31T05:00:00.000Z", cwd: "/work/pi-malformed" },
      {
        type: "message",
        timestamp: "2026-07-31T05:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Before malformed line" }] },
      },
      { type: "future_pi_event", payload: { ignored: true } },
      {
        type: "message",
        timestamp: "2026-07-31T05:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "After malformed line" }] },
      },
    ];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      [JSON.stringify(rows[0]), JSON.stringify(rows[1]), JSON.stringify(rows[2]), "{malformed", JSON.stringify(rows[3])].join("\n"),
    );

    const [loaded] = loadDefaultSessions({ homeDir, includePi: true })
      .filter((item) => item.session.source === "pi-cli");

    expect(loaded.messages.map(({ content }) => content)).toEqual(["Before malformed line", "After malformed line"]);
  });

  it("skips cyclic and missing-parent v3 files without blocking a valid sibling", () => {
    const homeDir = temporaryHome();
    writeJsonl(piSessionPath(homeDir, "cycle.jsonl"), [
      { type: "session", version: 3, id: "pi-cycle", timestamp: "2026-07-31T06:00:00.000Z", cwd: "/work/pi-cycle" },
      {
        type: "message",
        id: "cycle-user",
        parentId: "cycle-assistant",
        timestamp: "2026-07-31T06:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Cycle question" }] },
      },
      {
        type: "message",
        id: "cycle-assistant",
        parentId: "cycle-user",
        timestamp: "2026-07-31T06:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Cycle answer" }] },
      },
    ]);
    writeJsonl(piSessionPath(homeDir, "missing-parent.jsonl"), [
      { type: "session", version: 3, id: "pi-missing", timestamp: "2026-07-31T06:01:00.000Z", cwd: "/work/pi-missing" },
      {
        type: "message",
        id: "missing-user",
        parentId: "does-not-exist",
        timestamp: "2026-07-31T06:01:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Missing parent question" }] },
      },
    ]);
    writeJsonl(piSessionPath(homeDir, "valid-sibling.jsonl"), [
      { type: "session", version: 1, id: "pi-valid", timestamp: "2026-07-31T06:02:00.000Z", cwd: "/work/pi-valid" },
      {
        type: "message",
        timestamp: "2026-07-31T06:02:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Valid sibling question" }] },
      },
    ]);

    const loaded = loadDefaultSessions({ homeDir, includePi: true })
      .filter((item) => item.session.source === "pi-cli");

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.sessionKey).toBe("pi:pi-valid");
    expect(loaded[0].messages.map(({ content }) => content)).toEqual(["Valid sibling question"]);
  });
});
