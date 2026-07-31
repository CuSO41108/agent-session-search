import { readFile } from "node:fs/promises";
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

describe("Studio room composer", () => {
  it("allows public room messages without selecting a Runtime", async () => {
    const source = await readFile(
      new URL("./features/team-chat/team-chat-page.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("return availableMembers[0] ? [availableMembers[0].agentId] : [];");
    expect(source).not.toContain("if (targetMemberIds.length === 0)");
    expect(source).not.toContain("sending || targetMemberIds.length === 0");
    expect(source).toContain("输入 @名称才会唤醒对应 Runtime");
  });

  it("derives recipients from the composed text instead of tracking them separately", async () => {
    const source = await readFile(
      new URL("./features/team-chat/team-chat-page.tsx", import.meta.url),
      "utf8",
    );

    // Recipients must stay a function of the text so deleting an "@name" also
    // withdraws that recipient.
    expect(source).not.toContain("setTargetMemberIds");
    expect(source).toContain("resolveMentionedMemberIds(composer, routable)");
  });
});
