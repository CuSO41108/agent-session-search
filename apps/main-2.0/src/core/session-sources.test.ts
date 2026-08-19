import { describe, expect, it } from "vitest";
import { sessionSourceDescriptor } from "./session-sources";

describe("StepCode session source semantics", () => {
  it("keeps StepCode sources in their native Claude/Codex families", () => {
    expect(sessionSourceDescriptor("stepcode-claude")).toMatchObject({
      family: "claude",
      pendingKey: "stepcode",
    });
    expect(sessionSourceDescriptor("stepcode-codex")).toMatchObject({
      family: "codex",
      pendingKey: "stepcode",
    });
  });
});
