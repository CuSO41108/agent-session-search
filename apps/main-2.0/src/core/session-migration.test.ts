import { describe, expect, it } from "vitest";
import { portableSessionFrom, sshMigrationTarget } from "./session-migration";
import type { SessionMessage, SessionSearchResult, SessionSource } from "./types";

function session(source: SessionSource): SessionSearchResult {
  return {
    sessionKey: `${source}:remote:1`,
    rawId: "1",
    source,
    projectPath: "/srv/repo",
    filePath: "/home/remote/session.jsonl",
    originalTitle: "Original",
    firstQuestion: "Question",
    displayTitle: "Display",
    timestamp: Date.parse("2026-08-08T00:00:00Z"),
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    environmentId: "ssh-1",
    environmentKind: "ssh",
    environmentLabel: "Server",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    customTitle: null,
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 0,
    messageCount: 1,
    aiSummary: null,
    aiSummaryStale: false,
  };
}

const messages: SessionMessage[] = [
  { role: "user", content: "hello", timestamp: "2026-08-08T00:00:00Z", index: 0 },
];

describe("SSH session migration policy", () => {
  it.each([
    ["claude-cli", "codex"],
    ["codex-cli", "claude"],
    ["claude-app", null],
    ["codex-app", null],
    ["tclaude-cli", null],
    ["tcodex-cli", null],
    ["hermes", null],
  ] as const)("maps SSH source %s to the supported remote target %s", (source, expected) => {
    expect(sshMigrationTarget(source)).toBe(expected);
  });

  it("rejects SSH portable conversion unless the desktop flow opts in", () => {
    expect(() => portableSessionFrom(session("claude-cli"), messages)).toThrow(
      "SSH session migration is not supported yet.",
    );
  });

  it("allows a guarded SSH source to become a portable session", () => {
    expect(portableSessionFrom(session("claude-cli"), messages, { allowSsh: true })).toMatchObject({
      sourceAgent: "claude",
      projectPath: "/srv/repo",
    });
  });
});
