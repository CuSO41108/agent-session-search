import { describe, expect, it, vi } from "vitest";
import type {
  ConfiguredAgent,
  RuntimeConversation,
  WorkflowAgentEvent,
} from "../../automation/contracts";
import type {
  ListTeamChatMessagesRequest,
  TeamChatDispatch,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomSummary,
  TeamChatWorkspaceReservation,
} from "../../shared/team-chat";
import { TeamChatService } from "./team-chat-service";
import type {
  TeamChatAgentSession,
  TeamChatDispatchUpdate,
  TeamChatStore,
} from "./team-chat-store";

class MemoryTeamChatStore implements TeamChatStore {
  readonly rooms: TeamChatRoom[] = [];
  readonly messages: TeamChatMessage[] = [];
  readonly dispatches: TeamChatDispatch[] = [];
  readonly sessions: TeamChatAgentSession[] = [];
  readonly reservations: TeamChatWorkspaceReservation[] = [];
  initialized = false;
  closed = false;

  async initialize(): Promise<void> { this.initialized = true; }
  async close(): Promise<void> { this.closed = true; }
  async listRooms(): Promise<TeamChatRoomSummary[]> {
    return this.rooms.filter((room) => !room.archived).map((room) => ({
      id: room.id,
      name: room.name,
      workDir: room.workDir,
      archived: room.archived,
      agentCount: room.agents.length,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    }));
  }
  async getRoom(roomId: string): Promise<TeamChatRoom | undefined> {
    return this.rooms.find((room) => room.id === roomId);
  }
  async createRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    this.rooms.push(structuredClone(room));
    return structuredClone(room);
  }
  async updateRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    const index = this.rooms.findIndex((item) => item.id === room.id);
    if (index >= 0) this.rooms[index] = structuredClone(room);
    return structuredClone(room);
  }
  async archiveRoom(roomId: string, updatedAt: string): Promise<void> {
    const room = this.rooms.find((item) => item.id === roomId);
    if (room) Object.assign(room, { archived: true, updatedAt });
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    const index = this.rooms.findIndex((room) => room.id === roomId);
    if (index < 0) return false;
    this.rooms.splice(index, 1);
    for (const collection of [
      this.messages,
      this.dispatches,
      this.sessions,
      this.reservations,
    ]) {
      for (let itemIndex = collection.length - 1; itemIndex >= 0; itemIndex -= 1) {
        if (collection[itemIndex]?.roomId === roomId) collection.splice(itemIndex, 1);
      }
    }
    return true;
  }
  async listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> {
    const limit = request.limit ?? 100;
    return {
      messages: this.messages
        .filter((message) => message.roomId === request.roomId)
        .slice(-limit)
        .map((message) => structuredClone(message)),
    };
  }
  async listMessagesAfter(roomId: string, afterMessageId: string, limit: number) {
    const roomMessages = this.messages.filter((message) => message.roomId === roomId);
    const marker = roomMessages.findIndex((message) => message.id === afterMessageId);
    const messages = marker >= 0 ? roomMessages.slice(marker + 1) : roomMessages;
    return {
      messages: messages.slice(-limit).map((message) => structuredClone(message)),
      truncated: messages.length > limit,
    };
  }
  async listDirectedContext(
    roomId: string,
    memberId: string,
    afterMessageId: string | undefined,
    limit: number,
  ) {
    const marker = afterMessageId
      ? this.messages.find((message) => message.roomId === roomId && message.id === afterMessageId)?.sequence
      : undefined;
    const messages = this.messages.filter((message) =>
      message.roomId === roomId &&
      (marker === undefined || message.sequence > marker) &&
      (
        message.senderAgentId === memberId ||
        message.recipientMemberId === memberId ||
        message.senderType === "system" ||
        message.deliveryType === "post"
      ));
    return {
      messages: messages.slice(-limit).map((message) => structuredClone(message)),
      truncated: messages.length > limit,
    };
  }
  async getMessages(roomId: string, messageIds: string[]): Promise<TeamChatMessage[]> {
    const ids = new Set(messageIds);
    return this.messages
      .filter((message) => message.roomId === roomId && ids.has(message.id))
      .map((message) => structuredClone(message));
  }
  async readMessageRange(
    roomId: string,
    range: { after?: number; before?: number; limit: number },
  ): Promise<TeamChatMessage[]> {
    return this.messages
      .filter((message) =>
        message.roomId === roomId &&
        (range.after === undefined || message.sequence > range.after) &&
        (range.before === undefined || message.sequence < range.before))
      .slice(0, range.limit)
      .map((message) => structuredClone(message));
  }
  async searchMessages(roomId: string, query: string, limit: number): Promise<TeamChatMessage[]> {
    return this.messages
      .filter((message) =>
        message.roomId === roomId &&
        message.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .slice(-limit)
      .map((message) => structuredClone(message));
  }
  async insertMessage(message: TeamChatMessage): Promise<TeamChatMessage> {
    const saved = {
      ...structuredClone(message),
      sequence: this.messages.filter((item) => item.roomId === message.roomId).length + 1,
    };
    this.messages.push(saved);
    return structuredClone(saved);
  }
  async insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch> {
    this.dispatches.push(structuredClone(dispatch));
    return structuredClone(dispatch);
  }
  async countRootDispatches(rootMessageId: string): Promise<number> {
    return this.dispatches.filter((dispatch) => dispatch.rootMessageId === rootMessageId).length;
  }
  async updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void> {
    const dispatch = this.dispatches.find((item) => item.id === dispatchId);
    if (dispatch) Object.assign(dispatch, patch);
  }
  async markRunningDispatchesInterrupted(updatedAt: string): Promise<void> {
    for (const dispatch of this.dispatches) {
      if (dispatch.status === "queued" || dispatch.status === "running") {
        Object.assign(dispatch, { status: "interrupted", finishedAt: updatedAt, updatedAt });
      }
    }
  }
  async listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]> {
    return this.sessions
      .filter((session) => session.roomId === roomId)
      .map((session) => structuredClone(session));
  }
  async upsertAgentSession(session: TeamChatAgentSession): Promise<void> {
    const index = this.sessions.findIndex((item) =>
      item.roomId === session.roomId && item.agentId === session.agentId);
    if (index >= 0) this.sessions[index] = structuredClone(session);
    else this.sessions.push(structuredClone(session));
  }
  async deleteAgentSession(roomId: string, agentId: string): Promise<void> {
    const index = this.sessions.findIndex((session) =>
      session.roomId === roomId && session.agentId === agentId);
    if (index >= 0) this.sessions.splice(index, 1);
  }
  async listWorkspaceReservations(
    roomId: string,
    relativePaths?: string[],
  ): Promise<TeamChatWorkspaceReservation[]> {
    const paths = relativePaths ? new Set(relativePaths) : undefined;
    return this.reservations
      .filter((reservation) =>
        reservation.roomId === roomId &&
        (!paths || paths.has(reservation.relativePath)))
      .map((reservation) => structuredClone(reservation));
  }
  async reserveWorkspacePaths(
    reservations: TeamChatWorkspaceReservation[],
  ): Promise<TeamChatWorkspaceReservation[]> {
    for (const reservation of reservations) {
      const index = this.reservations.findIndex((item) =>
        item.roomId === reservation.roomId && item.relativePath === reservation.relativePath);
      if (index >= 0) this.reservations[index] = structuredClone(reservation);
      else this.reservations.push(structuredClone(reservation));
    }
    return reservations.map((reservation) => structuredClone(reservation));
  }
  async releaseWorkspacePaths(
    roomId: string,
    memberId: string,
    relativePaths: string[],
  ): Promise<number> {
    const paths = new Set(relativePaths);
    let released = 0;
    for (let index = this.reservations.length - 1; index >= 0; index -= 1) {
      const reservation = this.reservations[index]!;
      if (
        reservation.roomId === roomId &&
        reservation.memberId === memberId &&
        paths.has(reservation.relativePath)
      ) {
        this.reservations.splice(index, 1);
        released += 1;
      }
    }
    return released;
  }
}

function configuredAgent(id = "codex-profile", name = "Codex"): ConfiguredAgent {
  return {
    id,
    name,
    description: "",
    runtimeAgentId: "codex",
    channelId: "codex-main",
    modelId: "gpt-5",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

type ExecuteInput = {
  configuredAgentId: string;
  prompt: string;
  workDir?: string;
  runtimeConversation?: RuntimeConversation;
  developerInstructions?: string;
  agentRecallMcp?: { studioToken?: string };
};

async function createFixture(options: {
  executeAgent?: (
    input: ExecuteInput,
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number; runtimeConversation?: RuntimeConversation }>;
  members?: Array<{ configuredAgentId: string; displayName: string }>;
} = {}) {
  const store = new MemoryTeamChatStore();
  const events: TeamChatEvent[] = [];
  let idSequence = 0;
  let timeSequence = 0;
  const profile = configuredAgent();
  const service = new TeamChatService({
    configuredAgents: () => [profile],
    executeAgent: options.executeAgent ?? (async () => ({ output: "done", durationMs: 1 })),
    storeFactory: () => store,
    emit: (event) => events.push(event),
    idFactory: () => `019c0000-0000-7000-8000-${String(++idSequence).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 6, 23, 8, 0, ++timeSequence)),
  });
  await service.connect();
  const room = await service.createRoom({
    name: "Release studio",
    workDir: "/synthetic/repo",
    members: options.members ?? [
      { configuredAgentId: profile.id, displayName: "Codex" },
      { configuredAgentId: profile.id, displayName: "Codex2" },
    ],
  });
  return { service, store, events, room };
}

function waitForRoot(events: TeamChatEvent[], rootMessageId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (events.some((event) =>
        event.type === "turn-finished" && event.rootMessageId === rootMessageId)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 2_000) {
        reject(new Error("Timed out waiting for studio dispatches"));
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

function conversation(threadId: string): RuntimeConversation {
  return {
    runtimeId: "codex",
    codecVersion: "1",
    payload: { native: { threadId } },
  };
}

describe("TeamChatService studio employees", () => {
  it("creates separate employee instances backed by the same configured Agent", async () => {
    const { room } = await createFixture();

    expect(room.agents).toHaveLength(2);
    expect(room.agents[0]?.agentId).not.toBe(room.agents[1]?.agentId);
    expect(room.agents.map((member) => member.configuredAgentId)).toEqual([
      "codex-profile",
      "codex-profile",
    ]);
    expect(room.agents.map((member) => member.displayName)).toEqual(["Codex", "Codex2"]);
  });

  it("permanently deletes a studio and removes it from the room list", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.deleteRoom(fixture.room.id)).resolves.toBeUndefined();

    await expect(fixture.service.getRoom(fixture.room.id)).resolves.toBeUndefined();
    await expect(fixture.service.listRooms()).resolves.toEqual([]);
    expect(fixture.events).toContainEqual({ type: "rooms-changed" });
  });

  it("requires explicit recipients and invokes only the selected employee", async () => {
    const calls: ExecuteInput[] = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        return { output: "@Codex2 is text only", durationMs: 1 };
      },
    });

    await expect(fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "no target",
      targetMemberIds: [],
    })).rejects.toThrow(/select.*employee/i);

    const target = fixture.room.agents[0]!;
    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "check auth",
      targetMemberIds: [target.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      configuredAgentId: "codex-profile",
      workDir: "/synthetic/repo",
    });
    expect(calls[0]?.prompt).toContain(`To: Codex (${target.agentId})`);
    expect(calls[0]?.developerInstructions).toContain(`Your employee identity: Codex (${target.agentId})`);
    expect(calls[0]?.agentRecallMcp?.studioToken).toEqual(expect.any(String));
    expect(fixture.store.dispatches[0]?.targetAgentId).toBe(target.agentId);
  });

  it("bounds one user message to the collaboration activation limit", async () => {
    const fixture = await createFixture({
      members: Array.from({ length: 9 }, (_, index) => ({
        configuredAgentId: "codex-profile",
        displayName: `Codex${index + 1}`,
      })),
    });

    await expect(fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "Run everywhere",
      targetMemberIds: fixture.room.agents.map((member) => member.agentId),
    })).rejects.toThrow(/up to 8/i);
    expect(fixture.store.messages).toEqual([]);
  });

  it("lets an employee explicitly message a coworker through its scoped Studio MCP", async () => {
    let studioService: TeamChatService;
    let coworkerId = "";
    const tokens: string[] = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        tokens.push(token);
        if (input.prompt.includes("To: Codex (")) {
          await studioService.handleMcpRequest(token, "studio/send-message", {
            toMemberId: coworkerId,
            content: "Please review src/auth.ts",
          });
        }
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;
    coworkerId = fixture.room.agents[1]!.agentId;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "Implement auth",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);
    await vi.waitFor(() => expect(fixture.store.dispatches).toHaveLength(2));
    await vi.waitFor(() => expect(tokens).toHaveLength(2));

    expect(fixture.store.messages).toContainEqual(expect.objectContaining({
      senderAgentId: fixture.room.agents[0]!.agentId,
      recipientMemberId: coworkerId,
      content: "Please review src/auth.ts",
      deliveryType: "message",
    }));
    await expect(fixture.service.handleMcpRequest(tokens[0], "studio/list-members", {}))
      .rejects.toThrow(/scope.*expired/i);
  });

  it("posts without activating coworkers and scopes message reads to the current studio", async () => {
    const toolResults: unknown[] = [];
    let studioService: TeamChatService;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        toolResults.push(await studioService.handleMcpRequest(token, "studio/list-members", {}));
        toolResults.push(await studioService.handleMcpRequest(token, "studio/post", {
          content: "Draft is in src/auth.ts",
        }));
        toolResults.push(await studioService.handleMcpRequest(token, "studio/search", {
          query: "Draft",
          limit: 10,
        }));
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "Create a draft",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      members: [
        expect.objectContaining({ memberId: fixture.room.agents[0]!.agentId }),
        expect.objectContaining({ memberId: fixture.room.agents[1]!.agentId }),
      ],
    });
    expect(toolResults[2]).toMatchObject({ messages: expect.any(Array) });
    expect((toolResults[2] as { messages: TeamChatMessage[] }).messages)
      .toContainEqual(expect.objectContaining({ content: "Draft is in src/auth.ts" }));
  });

  it("validates and coordinates shared workspace path reservations", async () => {
    const toolResults: Record<string, unknown> = {};
    let studioService: TeamChatService;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        await expect(studioService.handleMcpRequest(token, "workspace/reserve", {
          paths: ["/outside.ts"],
        })).rejects.toThrow(/relative/i);
        await expect(studioService.handleMcpRequest(token, "workspace/reserve", {
          paths: ["../outside.ts"],
        })).rejects.toThrow(/relative/i);
        toolResults.reserve = await studioService.handleMcpRequest(token, "workspace/reserve", {
          paths: ["src/auth.ts", "src/auth.ts"],
          reason: "editing",
        });
        toolResults.status = await studioService.handleMcpRequest(token, "workspace/status", {});
        toolResults.release = await studioService.handleMcpRequest(token, "workspace/release", {
          paths: ["src/auth.ts"],
        });
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "Edit auth",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(toolResults.reserve).toMatchObject({ ok: true, reservations: [{ relativePath: "src/auth.ts" }] });
    expect(toolResults.status).toMatchObject({ reservations: [{ relativePath: "src/auth.ts" }] });
    expect(toolResults.release).toEqual({ ok: true, released: 1 });
    expect(fixture.store.reservations).toEqual([]);
  });

  it("reports path reservations held by another employee without replacing them", async () => {
    let studioService: TeamChatService;
    let coworkerId = "";
    let conflict: unknown;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        if (input.prompt.includes("To: Codex (")) {
          await studioService.handleMcpRequest(token, "workspace/reserve", {
            paths: ["src/shared.ts"],
            reason: "editing",
          });
          await studioService.handleMcpRequest(token, "studio/send-message", {
            toMemberId: coworkerId,
            content: "Please take another look",
          });
        } else {
          conflict = await studioService.handleMcpRequest(token, "workspace/reserve", {
            paths: ["src/shared.ts"],
            reason: "reviewing",
          });
        }
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;
    coworkerId = fixture.room.agents[1]!.agentId;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "Coordinate this edit",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(conflict).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({
        memberId: fixture.room.agents[0]!.agentId,
        relativePath: "src/shared.ts",
      })],
    });
    expect(fixture.store.reservations[0]?.memberId).toBe(fixture.room.agents[0]!.agentId);
  });

  it("stops employee-to-employee activation after eight dispatches in one causal chain", async () => {
    let studioService: TeamChatService;
    let store: MemoryTeamChatStore;
    let coworkerId = "";
    let deliveryResult: unknown;
    let calls = 0;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls += 1;
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        const current = store.dispatches[0]!;
        for (let index = 1; index < 8; index += 1) {
          store.dispatches.push({
            ...current,
            id: `synthetic-${index}`,
            targetAgentId: `synthetic-member-${index}`,
          });
        }
        deliveryResult = await studioService.handleMcpRequest(token, "studio/send-message", {
          toMemberId: coworkerId,
          content: "This should not activate",
        });
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;
    store = fixture.store;
    coworkerId = fixture.room.agents[1]!.agentId;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "Start bounded collaboration",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(deliveryResult).toMatchObject({ ok: false, error: expect.stringMatching(/8-activation/i) });
    expect(calls).toBe(1);
    expect(fixture.store.messages).toContainEqual(expect.objectContaining({
      senderType: "system",
      content: expect.stringMatching(/stopped after 8/i),
    }));
  });

  it("keeps Runtime sessions isolated between two employees using one profile", async () => {
    const calls: ExecuteInput[] = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        const member = input.prompt.includes("To: Codex2 (") ? "two" : "one";
        return {
          output: `${member} done`,
          durationMs: 1,
          runtimeConversation: conversation(`${member}-thread-${calls.length}`),
        };
      },
    });
    const [one, two] = fixture.room.agents;

    for (const target of [one!, two!, one!, two!]) {
      const sent = await fixture.service.sendMessage({
        roomId: fixture.room.id,
        content: `message for ${target.displayName}`,
        targetMemberIds: [target.agentId],
      });
      await waitForRoot(fixture.events, sent.rootMessageId);
    }

    expect(calls[0]?.runtimeConversation).toBeUndefined();
    expect(calls[1]?.runtimeConversation).toBeUndefined();
    expect(calls[2]?.runtimeConversation).toEqual(conversation("one-thread-1"));
    expect(calls[3]?.runtimeConversation).toEqual(conversation("two-thread-2"));
    expect(fixture.store.sessions.map((session) => session.agentId).sort())
      .toEqual([one!.agentId, two!.agentId].sort());
  });

  it("serializes one employee while allowing different employees to run in parallel", async () => {
    const starts: string[] = [];
    const resolvers: Array<() => void> = [];
    const fixture = await createFixture({
      executeAgent: (input) => new Promise((resolve) => {
        starts.push(input.prompt.includes("To: Codex2 (") ? "two" : "one");
        resolvers.push(() => resolve({ output: "done", durationMs: 1 }));
      }),
    });
    const [one, two] = fixture.room.agents;

    const first = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "one-a",
      targetMemberIds: [one!.agentId],
    });
    const second = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "one-b",
      targetMemberIds: [one!.agentId],
    });
    const third = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "two-a",
      targetMemberIds: [two!.agentId],
    });
    await vi.waitFor(() => expect(starts).toEqual(["one", "two"]));

    resolvers.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(starts).toEqual(["one", "two", "one"]));
    resolvers.splice(0).forEach((resolve) => resolve());
    await Promise.all([
      waitForRoot(fixture.events, first.rootMessageId),
      waitForRoot(fixture.events, second.rootMessageId),
      waitForRoot(fixture.events, third.rootMessageId),
    ]);
  });

  it("resets one employee Session without affecting its coworker", async () => {
    const fixture = await createFixture({
      executeAgent: async (input) => ({
        output: "done",
        durationMs: 1,
        runtimeConversation: conversation(
          input.prompt.includes("To: Codex2 (") ? "two-thread" : "one-thread",
        ),
      }),
    });
    for (const target of fixture.room.agents) {
      const sent = await fixture.service.sendMessage({
        roomId: fixture.room.id,
        content: "remember",
        targetMemberIds: [target.agentId],
      });
      await waitForRoot(fixture.events, sent.rootMessageId);
    }

    await fixture.service.resetAgentSession(fixture.room.id, fixture.room.agents[0]!.agentId);

    expect(fixture.store.sessions).toHaveLength(1);
    expect(fixture.store.sessions[0]?.agentId).toBe(fixture.room.agents[1]!.agentId);
  });

  it("stops all active employee dispatches in one user root", async () => {
    const fixture = await createFixture({
      executeAgent: (_input, _onEvent, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    });
    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "wait",
      targetMemberIds: fixture.room.agents.map((member) => member.agentId),
    });
    await vi.waitFor(() => expect(fixture.store.dispatches).toHaveLength(2));

    await fixture.service.stopTurn(sent.rootMessageId);
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches.map((dispatch) => dispatch.status))
      .toEqual(["interrupted", "interrupted"]);
  });

  it("does not expose connection failure details", async () => {
    const store = new MemoryTeamChatStore();
    store.initialize = async () => {
      throw new Error("postgresql://user:top-secret@private.example/db");
    };
    const events: TeamChatEvent[] = [];
    const service = new TeamChatService({
      configuredAgents: () => [configuredAgent()],
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      storeFactory: () => store,
      emit: (event) => events.push(event),
    });

    await expect(service.connect()).rejects.toThrow("Unable to open Chat data");
    expect(JSON.stringify(service.getConnectionStatus())).not.toContain("top-secret");
    expect(JSON.stringify(events)).not.toContain("top-secret");
  });
});
