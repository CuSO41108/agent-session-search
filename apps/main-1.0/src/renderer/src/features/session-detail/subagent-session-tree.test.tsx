import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionFamily } from "../../../../core/session-family";
import { SubagentSessionTree } from "./subagent-session-tree";

describe("SubagentSessionTree", () => {
  it("renders one-based parent launch Turn labels", () => {
    const family: SessionFamily = {
      parent: {
        sessionKey: "codex:parent",
        rawId: "parent",
        title: "Parent",
        source: "codex-cli",
        environmentId: "local",
        environmentLabel: "Local",
        messageCount: 10,
        lastActivityAt: Date.parse("2026-08-12T09:20:00.000Z"),
        aiSummary: null,
      },
      parentOriginTurnIndex: 62,
      children: [{
        sessionKey: "codex:child",
        rawId: "child",
        title: "Child",
        source: "codex-cli",
        environmentId: "local",
        environmentLabel: "Local",
        messageCount: 4,
        lastActivityAt: Date.parse("2026-08-12T09:10:00.000Z"),
        aiSummary: null,
        originTurnIndex: 2,
        children: [],
      }],
      truncated: false,
    };

    const markup = renderToStaticMarkup(
      <SubagentSessionTree family={family} language="zh" onOpen={() => undefined} />,
    );

    expect(markup).toContain("父会话 · 由第 63 轮发起");
    expect(markup).toContain("由父会话第 3 轮发起");
  });
});
