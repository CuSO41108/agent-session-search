// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateTeamChatRoomRequest,
  TeamChatRoom,
  TeamChatRoomSummary,
} from "../../../../shared/team-chat";

const automationFixture = vi.hoisted(() => ({
  api: {
    pickDirectory: vi.fn(async () => undefined),
  },
  snapshot: {
    workDir: "/workspace/project",
    configuredAgents: [{
      id: "builder-profile",
      name: "Builder",
      description: "Builds the project",
      runtimeAgentId: "codex",
      channelId: "codex",
      modelId: "gpt-5",
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    }],
  },
}));

vi.mock("../automation/automation-provider", () => ({
  useAutomationDetails: () => automationFixture,
}));

import { TeamChatPage } from "./team-chat-page";

describe("TeamChatPage rooms", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fixture: ReturnType<typeof createTeamChatFixture>;
  let teamChat: ReturnType<typeof createTeamChatFixture>;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fixture = createTeamChatFixture();
    teamChat = fixture;
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { teamChat },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("lets a newly created room be permanently deleted from the room list", async () => {
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(teamChat.listRooms).toHaveBeenCalled());

    const openCreate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create room");
    expect(openCreate).toBeDefined();
    await act(async () => openCreate?.click());

    const roomName = container.querySelector<HTMLInputElement>('input[placeholder="Release review"]');
    expect(roomName).not.toBeNull();
    await typeInto(roomName!, "Launch room");

    const create = [...container.querySelectorAll<HTMLButtonElement>(".team-chat-dialog footer button")]
      .find((button) => button.textContent?.includes("Create room"));
    expect(create?.disabled).toBe(false);
    await act(async () => create?.click());

    await vi.waitFor(() => {
      expect(teamChat.createRoom).toHaveBeenCalledWith({
        name: "Launch room",
        workDir: "/workspace/project",
        members: [{ configuredAgentId: "builder-profile", displayName: "Builder" }],
      });
      expect(container.querySelector(".team-chat-room-item.active")).not.toBeNull();
    });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Launch room”"]',
    );
    expect(deleteButton).not.toBeNull();
    await act(async () => deleteButton?.click());

    await vi.waitFor(() => {
      expect(window.confirm).toHaveBeenCalledWith(
        "Permanently delete “Launch room” and all of its messages? This cannot be undone.",
      );
      expect(teamChat.deleteRoom).toHaveBeenCalledWith("room-new");
      expect(container.querySelector(".team-chat-room-item")).toBeNull();
    });
  });

  it("keeps the active room open when a different room is deleted", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const deleteBeta = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Beta”"]',
    );
    expect(deleteBeta).not.toBeNull();
    await act(async () => deleteBeta?.click());

    await vi.waitFor(() => {
      expect(teamChat.deleteRoom).toHaveBeenCalledWith("room-beta");
      expect(container.querySelector('button[aria-label="Delete room “Beta”"]')).toBeNull();
      expect(container.querySelector(".team-chat-room-title strong")?.textContent).toBe("Alpha");
    });
  });

  it("clears deleted room details after switching rooms during a pending delete", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    const deletion = deferred<void>();
    teamChat.deleteRoom.mockImplementationOnce(async (roomId: string) => {
      await deletion.promise;
      fixture.removeRoom(roomId);
    });
    teamChat.getRoom.mockImplementation(async (roomId: string) => {
      if (roomId === "room-beta") throw new Error("Beta failed to load.");
      return fixture.findRoom(roomId);
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const deleteAlpha = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Alpha”"]',
    );
    expect(deleteAlpha).not.toBeNull();
    await act(async () => deleteAlpha?.click());
    await vi.waitFor(() => {
      expect(teamChat.deleteRoom).toHaveBeenCalledTimes(1);
      expect(deleteAlpha?.disabled).toBe(true);
    });

    await act(async () => deleteAlpha?.click());
    expect(teamChat.deleteRoom).toHaveBeenCalledTimes(1);

    const selectBeta = [...container.querySelectorAll<HTMLButtonElement>(".team-chat-room-select")]
      .find((button) => button.querySelector("strong")?.textContent === "Beta");
    expect(selectBeta).toBeDefined();
    await act(async () => selectBeta?.click());
    await vi.waitFor(() => expect(teamChat.getRoom).toHaveBeenCalledWith("room-beta"));

    await act(async () => {
      deletion.resolve();
      await deletion.promise;
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".team-chat-room-title")).toBeNull();
      expect(container.querySelector(".team-chat-room-item.active strong")?.textContent).toBe("Beta");
    });
  });

  it("keeps a newly loaded room when its load and the previous room deletion finish together", async () => {
    const alpha = roomFixture("room-alpha", "Alpha");
    const beta = roomFixture("room-beta", "Beta");
    fixture.setRooms([alpha, beta]);
    const deletion = deferred<void>();
    const betaLoad = deferred<TeamChatRoom | undefined>();
    teamChat.deleteRoom.mockImplementationOnce(async (roomId: string) => {
      await deletion.promise;
      fixture.removeRoom(roomId);
    });
    teamChat.getRoom.mockImplementation(async (roomId: string) => {
      if (roomId === beta.id) return betaLoad.promise;
      return fixture.findRoom(roomId);
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const deleteAlpha = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Alpha”"]',
    );
    await act(async () => deleteAlpha?.click());
    await vi.waitFor(() => expect(teamChat.deleteRoom).toHaveBeenCalledWith(alpha.id));

    const selectBeta = [...container.querySelectorAll<HTMLButtonElement>(".team-chat-room-select")]
      .find((button) => button.querySelector("strong")?.textContent === "Beta");
    await act(async () => selectBeta?.click());
    await vi.waitFor(() => expect(teamChat.getRoom).toHaveBeenCalledWith(beta.id));

    await act(async () => {
      betaLoad.resolve(beta);
      deletion.resolve();
      await Promise.all([betaLoad.promise, deletion.promise]);
    });
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));
  });
});

function createTeamChatFixture() {
  let rooms: TeamChatRoom[] = [];
  const fixture = {
    getConnectionStatus: vi.fn(async () => ({
      state: "ready" as const,
      mode: "local" as const,
      databaseLabel: "Local data",
    })),
    connect: vi.fn(),
    listRooms: vi.fn(async () => rooms.map(roomSummary)),
    getRoom: vi.fn(async (roomId: string) => rooms.find((room) => room.id === roomId)),
    createRoom: vi.fn(async (request: CreateTeamChatRoomRequest) => {
      const created = roomFixture("room-new", request.name, request);
      rooms = [...rooms, created];
      return created;
    }),
    deleteRoom: vi.fn(async (roomId: string) => {
      rooms = rooms.filter((room) => room.id !== roomId);
    }),
    listMessages: vi.fn(async () => ({ messages: [] })),
    sendMessage: vi.fn(),
    updateRoom: vi.fn(),
    removeRoomMember: vi.fn(),
    archiveRoom: vi.fn(),
    stopTurn: vi.fn(),
    resetAgentSession: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    setRooms(nextRooms: TeamChatRoom[]) {
      rooms = [...nextRooms];
    },
    removeRoom(roomId: string) {
      rooms = rooms.filter((room) => room.id !== roomId);
    },
    findRoom(roomId: string) {
      return rooms.find((room) => room.id === roomId);
    },
  };
  return fixture;
}

function roomSummary(room: TeamChatRoom): TeamChatRoomSummary {
  return {
    id: room.id,
    name: room.name,
    workDir: room.workDir,
    archived: room.archived,
    agentCount: room.agents.length,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function roomFixture(
  id: string,
  name: string,
  request?: CreateTeamChatRoomRequest,
): TeamChatRoom {
  const members = request?.members ?? [{ configuredAgentId: "builder-profile", displayName: "Builder" }];
  return {
    id,
    name,
    workDir: request?.workDir ?? "/workspace/project",
    archived: false,
    agents: members.map((member, position) => ({
      roomId: id,
      agentId: `member-${position + 1}`,
      configuredAgentId: member.configuredAgentId,
      displayName: member.displayName,
      runtimeId: "codex",
      channelId: "codex",
      modelId: "gpt-5",
      enabled: true,
      position,
      joinedAt: "2026-08-18T00:00:00.000Z",
      continuationAvailable: false,
      hasActiveConversation: false,
    })),
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
}
