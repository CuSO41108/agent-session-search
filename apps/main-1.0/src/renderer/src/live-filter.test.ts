import { describe, expect, it } from "vitest";
import { liveSessionKeyForSession } from "./live-filter";

describe("live session filtering", () => {
  it("treats an unknown persisted source as non-live", () => {
    expect(liveSessionKeyForSession({
      source: "legacy-source" as never,
      rawId: "session-1",
      lastActivityAt: Date.now(),
    })).toBeNull();
  });
});
