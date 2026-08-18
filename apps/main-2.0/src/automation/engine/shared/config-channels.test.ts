import { describe, expect, test } from "vitest";
import { normalizeConfigChannelsForStorage } from "./config-channels";
import { FALLBACK_MODEL_OPTIONS } from "./models";
import type { AgentChannel } from "./types";

const codexChannel: AgentChannel = {
  id: "codex-openai",
  agentId: "codex",
  label: "Codex OpenAI",
  models: FALLBACK_MODEL_OPTIONS.codex,
};

describe("config channel storage", () => {
  test("persists an explicitly created default DeepSeek Harness config", () => {
    const dshChannel: AgentChannel = {
      id: "dsh-default",
      agentId: "dsh",
      label: "DeepSeek Harness",
      presetId: "dsh-default",
      models: FALLBACK_MODEL_OPTIONS.dsh,
    };

    expect(normalizeConfigChannelsForStorage([codexChannel, dshChannel])).toEqual([
      codexChannel,
      dshChannel,
    ]);
  });
});
