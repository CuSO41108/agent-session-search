// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteSessionListItem, RemoteSessionUploadResult } from "../../../../core/remote-session-sync";
import { useRemoteSessionsCache, type RemoteSessionsController } from "./use-remote-sessions-cache";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function uploadResult(sessionKey: string, id: string): RemoteSessionUploadResult {
  return {
    status: "uploaded",
    remoteSession: {
      id,
      sourceSessionKey: sessionKey,
      contentHash: `hash-${id}`,
      syncedAt: 1,
    } as RemoteSessionListItem,
  };
}

describe("useRemoteSessionsCache", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: RemoteSessionsController | null;

  function Harness({ visible = true }: { visible?: boolean }) {
    controller = useRemoteSessionsCache();
    if (!visible) return null;
    const first = controller.cache.uploadTasks["local:first"]?.state ?? "idle";
    const second = controller.cache.uploadTasks["local:second"]?.state ?? "idle";
    return createElement("span", null, `${first},${second},${controller.cache.uploadBatch?.running ?? false}`);
  }

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    controller = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "sessionSearch");
  });

  it("loads readiness and items through one snapshot request", async () => {
    const loadRemoteSessionSyncSnapshot = vi.fn(async () => ({
      status: { kind: "ready" as const, setupSql: "setup sql" },
      items: [],
    }));
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { loadRemoteSessionSyncSnapshot } as unknown as typeof window.sessionSearch,
    });
    await act(async () => root.render(createElement(Harness)));

    await act(async () => controller!.ensureLoaded());

    expect(loadRemoteSessionSyncSnapshot).toHaveBeenCalledOnce();
    expect(controller!.cache).toMatchObject({ initialized: true, loading: false, refreshing: false });
  });

  it("clears a stale setup error when remote sync configuration changes", async () => {
    const loadRemoteSessionSyncSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error("old Supabase project is unavailable"))
      .mockResolvedValueOnce({
        status: { kind: "ready" as const, setupSql: "setup sql" },
        items: [],
      });
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { loadRemoteSessionSyncSnapshot } as unknown as typeof window.sessionSearch,
    });
    await act(async () => root.render(createElement(Harness)));

    await act(async () => controller!.ensureLoaded());
    expect(controller!.cache).toMatchObject({ initialized: true, error: "old Supabase project is unavailable" });

    act(() => controller!.invalidate());
    expect(controller!.cache).toMatchObject({ initialized: false, status: null, items: [], error: null });

    await act(async () => controller!.ensureLoaded());
    expect(loadRemoteSessionSyncSnapshot).toHaveBeenCalledTimes(2);
    expect(controller!.cache).toMatchObject({ initialized: true, error: null, status: { kind: "ready" } });
  });

  it("keeps serial upload progress after the foreground view is hidden", async () => {
    const first = deferred<RemoteSessionUploadResult>();
    const second = deferred<RemoteSessionUploadResult>();
    const uploadRemoteSession = vi.fn((sessionKey: string) =>
      sessionKey === "local:first" ? first.promise : second.promise);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { uploadRemoteSession } as unknown as typeof window.sessionSearch,
    });
    await act(async () => root.render(createElement(Harness)));

    act(() => controller!.queueUploads([
      { itemId: "first", sessionKey: "local:first", title: "First" },
      { itemId: "second", sessionKey: "local:second", title: "Second" },
    ]));

    expect(uploadRemoteSession).toHaveBeenCalledTimes(1);
    expect(controller!.cache.uploadTasks["local:first"].state).toBe("running");
    expect(controller!.cache.uploadTasks["local:second"].state).toBe("queued");

    await act(async () => root.render(createElement(Harness, { visible: false })));
    await act(async () => {
      first.resolve(uploadResult("local:first", "remote-first"));
      await first.promise;
    });
    await vi.waitFor(() => expect(uploadRemoteSession).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(uploadResult("local:second", "remote-second"));
      await second.promise;
    });
    await vi.waitFor(() => expect(controller!.cache.uploadBatch?.running).toBe(false));

    await act(async () => root.render(createElement(Harness)));
    expect(container.textContent).toBe("succeeded,succeeded,false");
    expect(controller!.cache.uploadBatch).toMatchObject({ total: 2, completed: 2, succeeded: 2, failed: 0 });
  });
});
