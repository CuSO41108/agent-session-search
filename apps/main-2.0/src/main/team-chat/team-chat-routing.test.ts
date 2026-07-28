import { describe, expect, it } from "vitest";
import type { TeamChatMessage, TeamChatRoom, TeamChatRoomAgent } from "../../shared/team-chat";
import {
  buildStudioDeveloperInstructions,
  buildTeamChatPrompt,
  resolveTeamChatTargets,
} from "./team-chat-routing";

const joinedAt = "2026-07-23T08:00:00.000Z";

function member(agentId: string, displayName: string, position: number): TeamChatRoomAgent {
  return {
    roomId: "room-1",
    agentId,
    configuredAgentId: "codex-profile",
    displayName,
    runtimeId: "codex",
    channelId: "codex-main",
    modelId: "gpt-5",
    enabled: true,
    position,
    joinedAt,
    continuationAvailable: true,
    hasActiveConversation: false,
  };
}

const members = [member("member-1", "Codex", 0), member("member-2", "Codex2", 1)];
const room: TeamChatRoom = {
  id: "room-1",
  name: "Release studio",
  workDir: "/synthetic/repo",
  archived: false,
  agents: members,
  createdAt: joinedAt,
  updatedAt: joinedAt,
};

function message(input: Partial<TeamChatMessage> & Pick<TeamChatMessage, "id" | "content">): TeamChatMessage {
  return {
    roomId: room.id,
    sequence: 1,
    senderType: "human",
    senderName: "You",
    deliveryType: "message",
    rootMessageId: input.id,
    hop: 0,
    status: "final",
    createdAt: joinedAt,
    updatedAt: joinedAt,
    ...input,
  };
}

describe("resolveTeamChatTargets", () => {
  it("uses explicit employee IDs without broadcasting an empty target list", () => {
    expect(resolveTeamChatTargets(["member-2"], members)).toEqual(["member-2"]);
    expect(resolveTeamChatTargets([], members)).toEqual([]);
  });

  it("deduplicates targets and skips disabled or unknown employees", () => {
    const disabled = { ...members[1]!, enabled: false };

    expect(resolveTeamChatTargets(
      ["member-1", "member-1", "member-2", "unknown"],
      [members[0]!, disabled],
    )).toEqual(["member-1"]);
  });
});

describe("studio Prompt contract", () => {
  it("delivers bounded room updates once through the immutable trigger snapshot", () => {
    const trigger = message({
      id: "message-current",
      sequence: 9,
      recipientMemberId: "member-2",
      content: "check auth",
    });
    const roomUpdates = [
      message({
        id: "message-parent",
        sequence: 8,
        senderType: "agent",
        senderAgentId: "member-1",
        senderName: "Codex",
        recipientMemberId: "member-2",
        content: "I changed src/auth.ts",
      }),
      trigger,
    ];

    const prompt = buildTeamChatPrompt({
      room,
      target: members[1]!,
      roomUpdates,
      triggerMessage: trigger,
      previousContextSequence: 7,
      snapshotSequence: 9,
      continuing: false,
      contextTruncated: false,
    });

    expect(prompt).toContain("[AgentRecall Studio Delivery]");
    expect(prompt).toContain("Runtime: Codex2 (member-2)");
    expect(prompt).toContain("Room snapshot: sequence 9");
    expect(prompt).toContain("Previous snapshot: sequence 7");
    expect(prompt).toContain("Room updates:");
    expect(prompt).toContain("I changed src/auth.ts");
    expect(prompt).toContain("Trigger:");
    expect(prompt.match(/check auth/g)).toHaveLength(1);
  });

  it("puts stable collaboration rules in developer instructions", () => {
    const instructions = buildStudioDeveloperInstructions(room, members[1]!);

    expect(instructions).toContain("Codex2");
    expect(instructions).toContain("member-2");
    expect(instructions).toContain("/synthetic/repo");
    expect(instructions).toContain("Every public message");
    expect(instructions).toContain("cannot activate another studio Runtime");
    expect(instructions).not.toContain("studio_send_message");
    expect(instructions).not.toContain("check auth");
  });
});
