import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TeamChatRoom } from "../../shared/team-chat";
import * as teamChatPage from "./features/team-chat/team-chat-page";

const ROOM: TeamChatRoom = {
  id: "room-1",
  name: "Release room",
  workDir: "/repo",
  archived: false,
  agents: [],
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

describe("Team Chat room title", () => {
  it("renders the current title with an explicit rename action", () => {
    const component = Reflect.get(teamChatPage, "TeamChatRoomTitle");
    expect(component).toBeTypeOf("function");

    const html = renderToStaticMarkup(createElement(component as ComponentType<{
      room: TeamChatRoom;
      language: "zh";
      onRename(name: string): Promise<void>;
      onError(error: unknown): void;
    }>, {
      room: ROOM,
      language: "zh",
      onRename: async () => undefined,
      onError: () => undefined,
    }));

    expect(html).toContain("Release room");
    expect(html).toContain("修改房间标题");
  });
});

describe("Studio employee names", () => {
  it("creates distinct employee names while allowing one Runtime configuration to be reused", () => {
    expect(teamChatPage.nextStudioEmployeeName("Codex", [])).toBe("Codex");
    expect(teamChatPage.nextStudioEmployeeName("Codex", ["Codex"])).toBe("Codex2");
    expect(teamChatPage.nextStudioEmployeeName("Codex", ["codex", "Codex2"])).toBe("Codex3");
  });
});
