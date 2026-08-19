// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AutomationApi } from "../../../../../../../preload/automation";
import type { AgentChannel, AppSnapshot } from "../../../../../shared/types";
import { DEFAULT_SNAPSHOT } from "../../../app/app-state";
import { useRuntimeConfigManager } from "./useRuntimeConfigManager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

describe("useRuntimeConfigManager local import", () => {
  test("persists a newly added DSH config before importing into its channel id", async () => {
    let savedSnapshot: AppSnapshot = structuredClone(DEFAULT_SNAPSHOT);
    const saveModelChannels = vi.fn(async (channels: AgentChannel[]) => {
      savedSnapshot = { ...savedSnapshot, channels: structuredClone(channels) };
      return savedSnapshot;
    });
    const importRuntimeLocalConfig = vi.fn(async (
      runtimeId: AgentChannel["agentId"],
      channelId?: string,
    ) => ({
      runtimeId,
      channelId: channelId ?? "dsh-default",
      source: "/tmp/dsh/settings.yaml",
      snapshot: savedSnapshot,
    }));
    const chatApi = {
      saveModelChannels,
      importRuntimeLocalConfig,
      onAgentTestEvent: () => () => undefined,
      queryRuntimeChannelBalance: vi.fn(async (channelId: string) => ({
        channelId,
        supported: false,
        status: "unsupported" as const,
        message: "Unsupported",
        items: [],
        queriedAt: Date.now(),
      })),
    } as unknown as AutomationApi;
    const ref = {
      current: undefined as unknown as ReturnType<typeof useRuntimeConfigManager>,
    };
    function Harness(): ReactElement | null {
      const [snapshot, setSnapshot] = useState(savedSnapshot);
      ref.current = useRuntimeConfigManager({ chatApi, snapshot, setSnapshot });
      return null;
    }
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    await act(async () => root.render(<Harness />));
    await act(async () => ref.current.addConfigChannel("dsh"));
    const channelId = ref.current.selectedConfigChannelId;

    await act(async () => ref.current.importLocalConfig("dsh", channelId));

    expect(channelId).toBe("dsh-default");
    expect(saveModelChannels).toHaveBeenCalledOnce();
    expect(saveModelChannels.mock.calls[0]?.[0]).toContainEqual(expect.objectContaining({
      id: "dsh-default",
      agentId: "dsh",
    }));
    expect(importRuntimeLocalConfig).toHaveBeenCalledWith("dsh", "dsh-default");
    expect(saveModelChannels.mock.invocationCallOrder[0])
      .toBeLessThan(importRuntimeLocalConfig.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  test("saves an edited DSH_HOME on an existing config before importing", async () => {
    const dshChannel: AgentChannel = {
      id: "dsh-default",
      agentId: "dsh",
      label: "DeepSeek Harness",
      presetId: "dsh-default",
      models: [{ id: "default", label: "Default" }],
      environment: { DSH_HOME: "/old/dsh-home" },
    };
    let savedSnapshot: AppSnapshot = {
      ...structuredClone(DEFAULT_SNAPSHOT),
      channels: [dshChannel],
    };
    const saveModelChannels = vi.fn(async (channels: AgentChannel[]) => {
      savedSnapshot = { ...savedSnapshot, channels: structuredClone(channels) };
      return savedSnapshot;
    });
    const importRuntimeLocalConfig = vi.fn(async () => ({
      runtimeId: "dsh" as const,
      channelId: "dsh-default",
      source: "/new/dsh-home/settings.yaml",
      snapshot: savedSnapshot,
    }));
    const chatApi = {
      saveModelChannels,
      importRuntimeLocalConfig,
      onAgentTestEvent: () => () => undefined,
      queryRuntimeChannelBalance: vi.fn(),
    } as unknown as AutomationApi;
    const ref = {
      current: undefined as unknown as ReturnType<typeof useRuntimeConfigManager>,
    };
    function Harness(): ReactElement | null {
      const [snapshot, setSnapshot] = useState(savedSnapshot);
      ref.current = useRuntimeConfigManager({ chatApi, snapshot, setSnapshot });
      return null;
    }
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    await act(async () => root.render(<Harness />));
    await act(async () => {
      ref.current.updateConfigChannel("dsh-default", (current) => ({
        ...current,
        environment: { DSH_HOME: "/new/dsh-home" },
      }));
    });

    await act(async () => ref.current.importLocalConfig("dsh", "dsh-default"));

    expect(window.confirm).toHaveBeenCalledWith(
      "Save the current DeepSeek Harness config before importing local defaults?",
    );
    expect(saveModelChannels).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "dsh-default",
        environment: { DSH_HOME: "/new/dsh-home" },
      }),
    ]);
    expect(importRuntimeLocalConfig).toHaveBeenCalledWith("dsh", "dsh-default");
    expect(saveModelChannels.mock.invocationCallOrder[0])
      .toBeLessThan(importRuntimeLocalConfig.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });
});
