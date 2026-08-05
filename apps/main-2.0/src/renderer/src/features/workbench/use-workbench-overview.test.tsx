// @vitest-environment happy-dom

import { StrictMode, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStats, UsageQuotaSnapshot } from "../../../../core/types";
import { useWorkbenchOverview } from "./use-workbench-overview";

const STATS: SessionStats = {
  total: {
    sessionCount: 7,
    messageCount: 14,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  },
  bySource: [],
  dailyTokenUsage: [],
  previousTotal: null,
  range: { period: "today", since: null, until: 1 },
};

const QUOTAS: UsageQuotaSnapshot = {
  generatedAt: "ready",
  providers: [],
};

function OverviewObserver(): ReactElement {
  const overview = useWorkbenchOverview("zh");
  return (
    <div
      data-session-count={String(overview.stats.total.sessionCount)}
      data-quota-generated-at={overview.quotas.generatedAt}
      data-quota-loading={String(overview.quotaLoading)}
    />
  );
}

describe("workbench overview startup", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
  });

  it("loads stats and quotas once in StrictMode even when live-session detection never finishes", async () => {
    const api = {
      searchSessionPage: vi.fn(async () => ({ sessions: [], totalCount: 0, hasMore: false })),
      getStats: vi.fn(async () => STATS),
      getQuotas: vi.fn(async () => QUOTAS),
      getLiveSessions: vi.fn(() => new Promise(() => undefined)),
      onQuotaUpdated: vi.fn(() => () => undefined),
    };
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: api,
    });

    await act(async () => {
      root.render(<StrictMode><OverviewObserver /></StrictMode>);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    expect(api.getStats).toHaveBeenCalledOnce();
    expect(api.getQuotas).toHaveBeenCalledOnce();
    expect(api.getLiveSessions).toHaveBeenCalledOnce();
    expect(container.firstElementChild?.getAttribute("data-session-count")).toBe("7");
    expect(container.firstElementChild?.getAttribute("data-quota-generated-at")).toBe("ready");
    expect(container.firstElementChild?.getAttribute("data-quota-loading")).toBe("false");
  });
});
