import { describe, expect, it } from "vitest";

import type { AppSettingsUpdate } from "../../core/platform";
import { restartOpenVikingForExtractionSettings } from "./openviking-settings-lifecycle";

describe("restartOpenVikingForExtractionSettings", () => {
  it.each<AppSettingsUpdate>([
    { openVikingExtractionModel: "gpt-5.6-sol" },
    { openVikingExtractionReasoningEffort: "high" },
    { summarySource: "codex" },
    { summaryApiConfig: { customModel: "deepseek-chat" } },
  ])("stops a running service before starting it for extraction update %j", async (update) => {
    const calls: string[] = [];

    await restartOpenVikingForExtractionSettings({
      update,
      enabled: true,
      runtimeState: "running",
      stop: async () => { calls.push("stop"); },
      start: async () => { calls.push("start"); },
    });

    expect(calls).toEqual(["stop", "start"]);
  });

  it("starts a stopped service without stopping it first", async () => {
    const calls: string[] = [];

    await restartOpenVikingForExtractionSettings({
      update: { openVikingExtractionModel: "gpt-5.6-sol" },
      enabled: true,
      runtimeState: "stopped",
      stop: async () => { calls.push("stop"); },
      start: async () => { calls.push("start"); },
    });

    expect(calls).toEqual(["start"]);
  });

  it("does nothing for hook-only changes or when Memory is disabled", async () => {
    const calls: string[] = [];
    const run = (update: AppSettingsUpdate, enabled: boolean) =>
      restartOpenVikingForExtractionSettings({
        update,
        enabled,
        runtimeState: "running",
        stop: async () => { calls.push("stop"); },
        start: async () => { calls.push("start"); },
      });

    await run({ openVikingCodexEnabled: true }, true);
    await run({ openVikingExtractionModel: "gpt-5.6-sol" }, false);

    expect(calls).toEqual([]);
  });
});
