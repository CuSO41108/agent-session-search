import { describe, expect, test } from "vitest";
import type { ConfiguredAgent } from "../../../../automation/contracts";
import { reconcileEditableAgentsAfterChannelSave } from "./runtime-feature-page";

function agent(id: string, managed = false): ConfiguredAgent {
  return {
    id,
    name: id,
    description: "",
    runtimeAgentId: "codex",
    channelId: id === "generated" ? "new-channel" : "codex-openai",
    modelId: "default",
    tags: [],
    ...(managed ? { managed: true } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("reconcileEditableAgentsAfterChannelSave", () => {
  test("keeps local edits and appends Agent generated for a new execution config", () => {
    const previous = [agent("default", true), agent("edited")];
    const edited = [{ ...agent("edited"), name: "Edited locally" }];

    expect(reconcileEditableAgentsAfterChannelSave(edited, previous, [...previous, agent("generated", true)]))
      .toEqual([...edited, agent("generated", true)]);
  });

  test("does not restore a previously known managed Agent deleted by the user", () => {
    const previous = [agent("default", true)];
    expect(reconcileEditableAgentsAfterChannelSave([], previous, previous)).toEqual([]);
  });
});
