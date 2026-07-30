import { describe, expect, test } from "vitest";
import { normalizeConfigChannelsForStorage } from "./config-channels";
import { FALLBACK_MODEL_OPTIONS } from "./models";
import { RUNTIME_DEFINITIONS } from "./runtime-catalog";
import type { AgentChannel } from "./types";

function legacyDefaultChannels(): AgentChannel[] {
  return RUNTIME_DEFINITIONS.map((definition) => ({
    ...definition.defaultChannel,
    agentId: definition.id,
    models: FALLBACK_MODEL_OPTIONS[definition.id].map((model) => ({ ...model })),
  }));
}

describe("config channels", () => {
  test("removes untouched legacy defaults for optional runtimes", () => {
    expect(normalizeConfigChannelsForStorage(legacyDefaultChannels()).map((channel) => channel.agentId)).toEqual([
      "codex",
      "claude",
    ]);
  });

  test("preserves an optional runtime config after the user changes it", () => {
    const channels = legacyDefaultChannels();
    const hermes = channels.find((channel) => channel.agentId === "hermes")!;
    hermes.label = "Team Hermes";

    expect(normalizeConfigChannelsForStorage(channels).map((channel) => channel.agentId)).toEqual([
      "codex",
      "claude",
      "hermes",
    ]);
  });
});
