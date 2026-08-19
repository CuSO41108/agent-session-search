import { describe, expect, it } from "vitest";
import type { SessionSearchResult } from "../../core/types";
import { nativeResumeSession } from "./session-command-service";

function session(source: SessionSearchResult["source"]): SessionSearchResult {
  return {
    sessionKey: `${source}:session`,
    rawId: "session",
    source,
  } as SessionSearchResult;
}

describe("nativeResumeSession", () => {
  it("maps StepCode sessions back to their native resume sources", () => {
    expect(nativeResumeSession(session("stepcode-claude")).source).toBe("claude-cli");
    expect(nativeResumeSession(session("stepcode-codex")).source).toBe("codex-cli");
  });

  it("keeps native and unrelated sources unchanged", () => {
    expect(nativeResumeSession(session("claude-app"))).toMatchObject({ source: "claude-app" });
    expect(nativeResumeSession(session("tcodex-cli"))).toMatchObject({ source: "tcodex-cli" });
  });
});
