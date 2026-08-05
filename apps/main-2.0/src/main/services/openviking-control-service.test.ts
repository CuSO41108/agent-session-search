import { describe, expect, it, vi } from "vitest";

import type { OpenVikingRuntimeStatus, OpenVikingWorkspace } from "../../core/openviking-memory";
import { defaultSettings } from "../../core/platform";
import type { OpenVikingMemoryService } from "./openviking-memory-service";
import type { OpenVikingRuntimeManifest } from "./openviking-runtime-service";
import { OpenVikingControlService } from "./openviking-control-service";

const runtimeManifest: OpenVikingRuntimeManifest = {
  version: "0.4.11",
  platform: "darwin",
  arch: "arm64",
  url: "https://downloads.example/runtime.tar.gz",
  sha256: "a".repeat(64),
  executablePath: "bin/openviking-server",
  archiveType: "tar.gz",
};

function workspace(overrides: Partial<OpenVikingWorkspace> = {}): OpenVikingWorkspace {
  return {
    id: "workspace-1",
    userId: "workspace_abcd",
    rootPath: "/repo",
    identity: "path:one",
    displayName: "repo",
    managed: true,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function harness(
  enabled = true,
  manifest: OpenVikingRuntimeManifest | null = runtimeManifest,
  resolveRuntimeManifest: (...args: unknown[]) => Promise<OpenVikingRuntimeManifest | null> = async () => manifest,
) {
  const onStateChanged = vi.fn(async () => undefined);
  const workspaces: OpenVikingWorkspace[] = [workspace()];
  const runtime = {
    getStatus: vi.fn(async (): Promise<OpenVikingRuntimeStatus> => ({ state: "not-installed" })),
    getDiagnostics: vi.fn(async () => ({
      status: { state: "stopped" as const, version: "0.4.11" },
      health: "not-running" as const,
      events: [],
    })),
    install: vi.fn(async () => ({ state: "stopped" as const, version: "0.4.11" })),
    start: vi.fn(async () => ({ state: "running" as const, version: "0.4.11", port: 21933 })),
    startFromPersistedConfig: vi.fn(async () => ({
      state: "running" as const,
      version: "0.4.11",
      port: 21933,
    })),
    stop: vi.fn(async () => ({ state: "stopped" as const, version: "0.4.11" })),
    clearData: vi.fn(async () => undefined),
  };
  const model = {
    getStatus: vi.fn(async () => ({
      model: "BAAI/bge-small-zh-v1.5" as const,
      installed: true,
    })),
    install: vi.fn(async () => ({
      model: "BAAI/bge-small-zh-v1.5" as const,
      installed: true,
    })),
  };
  const memory = {
    listWorkspaces: vi.fn(async () => [...workspaces]),
    previewDirectory: vi.fn(async (rootPath: string) => ({
      rootPath,
      displayName: "repo",
      identity: "path:one",
      existingWorkspaceId: null,
      relinkWorkspaceId: null,
    })),
    addWorkspace: vi.fn(async () => workspaces[0]),
    searchMemories: vi.fn(async () => []),
    readMemory: vi.fn(async () => ""),
    saveMemory: vi.fn(async () => ({
      id: "viking://user/memories/manual/note.md",
      workspaceId: "workspace-1",
      title: "Note",
      content: "content",
    })),
    memoryDetails: vi.fn(async () => ({
      control: {
        workspaceId: "workspace-1",
        uri: "viking://user/memories/manual/note.md",
        memoryType: "manual",
        authority: "user" as const,
        lifecycle: "active" as const,
        locked: true,
        evidenceStatus: "verified" as const,
        source: "manual" as const,
        evidenceCount: 0,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
      evidence: [],
      feedback: [],
    })),
    feedback: vi.fn(async () => ({
      workspaceId: "workspace-1",
      uri: "viking://user/memories/manual/note.md",
      memoryType: "manual",
      authority: "user" as const,
      lifecycle: "active" as const,
      locked: true,
      evidenceStatus: "verified" as const,
      source: "manual" as const,
      evidenceCount: 0,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    })),
    deleteMemory: vi.fn(async () => undefined),
    stopManaging: vi.fn(async (workspaceId: string) => {
      const current = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0];
      current.managed = false;
      return { ...current };
    }),
    deleteWorkspace: vi.fn(async (workspaceId: string) => {
      const index = workspaces.findIndex((item) => item.id === workspaceId);
      if (index >= 0) workspaces.splice(index, 1);
    }),
  } as unknown as OpenVikingMemoryService;
  const control = {
    getOpenVikingControlDiagnostics: vi.fn(async () => ({
      recentEvents: [],
      recentRecallTraces: [],
      recentCommits: [],
    })),
  };
  const service = new OpenVikingControlService({
    runtime,
    model,
    memory,
    control,
    getSettings: () => ({
      ...defaultSettings,
      openVikingMemoryEnabled: enabled,
    }),
    chooseDirectory: async () => "/repo",
    resolveRuntimeManifest,
    serverConfig: async () => ({
      embedding: {
        dense: {
          provider: "local",
          model: "bge-small-zh-v1.5-f16",
          dimension: 512,
          model_path: "/models/bge-small-zh-v1.5-f16.gguf",
        },
      },
      vlm: {
        provider: "openai-codex",
        model: "gpt-5.4",
        api_base: "https://chatgpt.com/backend-api/codex",
      },
    }),
    onStateChanged,
  });
  return { service, runtime, model, memory, control, onStateChanged, workspaces };
}

describe("OpenVikingControlService", () => {
  it("exposes status while disabled but blocks data access", async () => {
    const { service, memory } = harness(false);

    await expect(service.snapshot()).resolves.toMatchObject({
      runtime: { state: "not-installed" },
      model: { installed: true },
      workspaces: expect.any(Array),
    });
    await expect(service.chooseDirectory()).rejects.toThrow("disabled");
    await expect(service.search("workspace-1", "query")).rejects.toThrow("disabled");
    expect(memory.previewDirectory).not.toHaveBeenCalled();
  });

  it("installs the selected platform artifact and starts with the managed model config", async () => {
    const { service, runtime, model } = harness();

    await service.installRuntime();
    await service.installModel("BAAI/bge-small-zh-v1.5");
    await service.startRuntime();

    expect(runtime.install).toHaveBeenCalledWith(runtimeManifest, expect.any(Function));
    expect(model.install).toHaveBeenCalledWith("BAAI/bge-small-zh-v1.5");
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      embedding: {
        dense: expect.objectContaining({
          model: "bge-small-zh-v1.5-f16",
          model_path: "/models/bge-small-zh-v1.5-f16.gguf",
          dimension: 512,
        }),
      },
    }));
  });

  it("returns directory diagnostics without starting a stopped runtime or reading import tasks", async () => {
    const { service, runtime, control } = harness();

    await expect(service.diagnostics()).resolves.toMatchObject({
      runtime: { health: "not-running", status: { state: "stopped" } },
      model: { installed: true },
      workspaces: [{ id: "workspace-1", managed: true }],
      control: {
        recentEvents: [],
        recentRecallTraces: [],
        recentCommits: [],
      },
    });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(control.getOpenVikingControlDiagnostics).toHaveBeenCalledOnce();
  });

  it("adds a directory and returns immediately without a historical import phase", async () => {
    const { service, memory } = harness();

    await expect(service.chooseDirectory()).resolves.toMatchObject({ rootPath: "/repo" });
    await expect(service.addWorkspace("/repo")).resolves.toMatchObject({ id: "workspace-1" });

    expect(memory.addWorkspace).toHaveBeenCalledWith("/repo");
    expect(Object.hasOwn(memory, "importWorkspace")).toBe(false);
  });

  it("restarts the runtime through one serialized stop and start lifecycle", async () => {
    const { service, runtime } = harness();

    await service.restartRuntime();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.stop.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.start.mock.invocationCallOrder[0]);
  });

  it("waits for an in-flight read before stopping directory tracking", async () => {
    const { service, memory } = harness();
    let finishSearch: (items: never[]) => void = () => undefined;
    const searchPending = new Promise<never[]>((resolve) => {
      finishSearch = resolve;
    });
    vi.mocked(memory.searchMemories).mockImplementation(async () => searchPending);

    const searching = service.search("workspace-1", "", 200);
    await vi.waitFor(() => expect(memory.searchMemories).toHaveBeenCalledOnce());
    const stopping = service.stopManaging("workspace-1");

    await expect(service.search("workspace-1", "next")).rejects.toThrow("being updated");
    expect(memory.stopManaging).not.toHaveBeenCalled();

    finishSearch([]);
    await searching;
    await stopping;

    expect(memory.stopManaging).toHaveBeenCalledWith("workspace-1");
  });

  it("blocks only the directory being deleted while another directory stays usable", async () => {
    const { service, memory, workspaces } = harness();
    workspaces.push(workspace({
      id: "workspace-2",
      userId: "workspace_efgh",
      rootPath: "/repo-2",
      identity: "path:two",
      displayName: "repo-2",
    }));
    let finishDelete: () => void = () => undefined;
    vi.mocked(memory.deleteWorkspace).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishDelete = resolve;
      });
      workspaces.splice(workspaces.findIndex((item) => item.id === "workspace-1"), 1);
    });
    const deleting = service.deleteWorkspace("workspace-1");
    await vi.waitFor(() => expect(memory.deleteWorkspace).toHaveBeenCalledOnce());

    await expect(service.search("workspace-1", "query")).rejects.toThrow("being updated");
    await expect(service.search("workspace-2", "query")).resolves.toEqual([]);

    finishDelete();
    await deleting;
  });

  it("starts from persisted config to delete while stopped, then restores the stopped state", async () => {
    const { service, runtime, memory } = harness();
    vi.mocked(runtime.getStatus).mockResolvedValue({ state: "stopped", version: "0.4.11" });

    await service.deleteWorkspace("workspace-1");

    expect(runtime.startFromPersistedConfig).toHaveBeenCalledOnce();
    expect(memory.deleteWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.clearData).toHaveBeenCalledOnce();
  });

  it("stops an already-running backend and clears shared data after deleting the last directory", async () => {
    const { service, runtime, memory } = harness();
    vi.mocked(runtime.getStatus).mockResolvedValue({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });

    await service.deleteWorkspace("workspace-1");

    expect(runtime.startFromPersistedConfig).not.toHaveBeenCalled();
    expect(memory.deleteWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.clearData).toHaveBeenCalledOnce();
  });

  it("preserves a running backend and shared data when another directory remains", async () => {
    const { service, runtime, workspaces } = harness();
    workspaces.push(workspace({
      id: "workspace-2",
      userId: "workspace_efgh",
      rootPath: "/repo-2",
      identity: "path:two",
      displayName: "repo-2",
    }));
    vi.mocked(runtime.getStatus).mockResolvedValue({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });

    await service.deleteWorkspace("workspace-1");

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.clearData).not.toHaveBeenCalled();
    await expect(service.search("workspace-2", "query")).resolves.toEqual([]);
  });

  it("reports builds that do not publish a matching runtime artifact", async () => {
    const { service: unavailable } = harness(true, null);

    await expect(unavailable.installRuntime()).rejects.toThrow("not available for this build");
  });

  it("exposes runtime preparation progress through snapshots while installation is pending", async () => {
    let finishResolution: () => void = () => undefined;
    const resolutionGate = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const resolveRuntimeManifest = vi.fn(async (...args: unknown[]) => {
      const report = args[0] as undefined | ((progress: {
        phase: string;
        downloadedBytes?: number;
        totalBytes?: number;
      }) => void);
      report?.({
        phase: "downloading-python",
        downloadedBytes: 50,
        totalBytes: 100,
      });
      await resolutionGate;
      return runtimeManifest;
    });
    const { service } = harness(true, runtimeManifest, resolveRuntimeManifest);
    const installation = service.installRuntime();

    try {
      await expect(service.snapshot()).resolves.toMatchObject({
        runtime: {
          state: "installing",
          progress: {
            phase: "downloading-python",
            downloadedBytes: 50,
            totalBytes: 100,
          },
        },
      });
    } finally {
      finishResolution();
      await installation;
    }
  });

  it("coalesces concurrent runtime install requests into one operation", async () => {
    let finishResolution: () => void = () => undefined;
    const resolutionGate = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const resolveRuntimeManifest = vi.fn(async () => {
      await resolutionGate;
      return runtimeManifest;
    });
    const { service, runtime } = harness(true, runtimeManifest, resolveRuntimeManifest);
    const first = service.installRuntime();
    const second = service.installRuntime();

    finishResolution();
    await Promise.all([first, second]);

    expect(resolveRuntimeManifest).toHaveBeenCalledOnce();
    expect(runtime.install).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent runtime start requests into one operation", async () => {
    let finishStart: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const { service, runtime } = harness();
    vi.mocked(runtime.start).mockImplementation(async () => {
      await startGate;
      return { state: "running", version: "0.4.11", port: 21933 };
    });

    const first = service.startRuntime();
    const second = service.startRuntime();
    finishStart();
    await Promise.all([first, second]);

    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it("refreshes external hook state after workspace and runtime lifecycle changes", async () => {
    const { service, onStateChanged } = harness();

    await service.addWorkspace("/repo");
    await service.startRuntime();
    await service.stopManaging("workspace-1");
    await service.stopRuntime();

    expect(onStateChanged).toHaveBeenCalledTimes(4);
  });
});
