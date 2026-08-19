import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID } from "./models";
import { AGENT_PROVIDER_PRESETS, DSH_DEFAULT_PRESET_ID } from "./provider-presets";

describe("DeepSeek Harness provider preset", () => {
  it("keeps model selection owned by DSH", () => {
    const preset = AGENT_PROVIDER_PRESETS.find((item) => item.id === DSH_DEFAULT_PRESET_ID);

    expect(preset).toMatchObject({
      id: "dsh-default",
      label: "Default",
      runtimeAgentId: "dsh",
    });
    expect(preset?.models).toEqual([
      expect.objectContaining({ id: DEFAULT_MODEL_ID }),
    ]);
    expect(preset?.models).toHaveLength(1);
    expect(preset?.configurableModelId).not.toBe(true);
  });
});
