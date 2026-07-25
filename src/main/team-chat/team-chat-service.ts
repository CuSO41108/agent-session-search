import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ConfiguredAgent,
  RuntimeConversation,
  WorkflowAgentEvent,
} from "../../automation/contracts";
import { supportsConfiguredAgentConversation } from "../../automation/engine/main/platform/configured-agent-execution-service";
import type { AgentRecallMcpContext } from "../../automation/engine/shared/types";
import type {
  CreateTeamChatRoomRequest,
  ListTeamChatMessagesRequest,
  SendTeamChatMessageRequest,
  SendTeamChatMessageResult,
  TeamChatConnectionStatus,
  TeamChatDispatch,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomAgent,
  TeamChatRoomMemberInput,
  TeamChatRoomSummary,
  TeamChatWorkspaceReservation,
  UpdateTeamChatRoomRequest,
} from "../../shared/team-chat";
import {
  buildStudioDeveloperInstructions,
  buildTeamChatPrompt,
  resolveTeamChatTargets,
} from "./team-chat-routing";
import type {
  TeamChatAgentSession,
  TeamChatContextPage,
  TeamChatStore,
} from "./team-chat-store";

const CONTEXT_MESSAGE_LIMIT = 40;
const MAX_ROOT_DISPATCHES = 8;
const STUDIO_SCOPE_LIFETIME_MS = 60 * 60 * 1_000;
const WORKSPACE_RESERVATION_LIFETIME_MS = 10 * 60 * 1_000;

interface StudioExecutionScope {
  roomId: string;
  memberId: string;
  dispatchId: string;
  rootMessageId: string;
  sourceMessageId: string;
  hop: number;
  controller: AbortController;
  expiresAt: number;
}

interface TeamChatServiceDependencies {
  configuredAgents: () => ConfiguredAgent[];
  executeAgent: (
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      runtimeConversation?: RuntimeConversation;
      developerInstructions?: string;
      agentRecallMcp?: AgentRecallMcpContext;
    },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number; runtimeConversation?: RuntimeConversation }>;
  storeFactory: () => TeamChatStore;
  emit?: (event: TeamChatEvent) => void;
  idFactory?: () => string;
  now?: () => Date;
}

type TeamChatEventListener = (event: TeamChatEvent) => void;

export class TeamChatService {
  private readonly listeners = new Set<TeamChatEventListener>();
  private readonly rootControllers = new Map<string, AbortController>();
  private readonly rootActivityCounts = new Map<string, number>();
  private readonly rootDispatchCounts = new Map<string, number>();
  private readonly memberQueueTails = new Map<string, Promise<void>>();
  private readonly activeWorkPromises = new Set<Promise<void>>();
  private readonly studioScopes = new Map<string, StudioExecutionScope>();
  private store: TeamChatStore | undefined;
  private connectionQueue: Promise<void> = Promise.resolve();
  private pendingConnection: Promise<TeamChatConnectionStatus> | undefined;
  private status: TeamChatConnectionStatus;

  constructor(private readonly dependencies: TeamChatServiceDependencies) {
    this.status = {
      state: "unconfigured",
      mode: "local",
      databaseLabel: "AgentRecall database",
    };
  }

  subscribe(listener: TeamChatEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getConnectionStatus(): TeamChatConnectionStatus {
    return { ...this.status };
  }

  async connect(_connectionUrl?: string): Promise<TeamChatConnectionStatus> {
    if (this.store && this.status.state === "ready") return this.getConnectionStatus();
    if (this.pendingConnection) return this.pendingConnection;

    const promise = this.enqueueConnection(async () => {
      if (this.store && this.status.state === "ready") return this.getConnectionStatus();
      await this.closeCurrentStore();
      this.setStatus({
        state: "connecting",
        mode: "local",
        databaseLabel: "AgentRecall database",
      });
      let nextStore: TeamChatStore | undefined;
      try {
        nextStore = this.dependencies.storeFactory();
        await nextStore.initialize();
        this.store = nextStore;
        this.setStatus({
          state: "ready",
          mode: "local",
          databaseLabel: "AgentRecall database",
        });
        return this.getConnectionStatus();
      } catch (error) {
        await nextStore?.close().catch(() => undefined);
        this.store = undefined;
        const message = "Unable to open Chat data. Restart AgentRecall or retry.";
        this.setStatus({
          state: "error",
          mode: "local",
          databaseLabel: "AgentRecall database",
          error: message,
        });
        throw new Error(message, { cause: error });
      }
    });
    this.pendingConnection = promise;
    void promise.finally(() => {
      if (this.pendingConnection === promise) this.pendingConnection = undefined;
    }).catch(() => undefined);
    return promise;
  }

  async useLocalDatabase(): Promise<TeamChatConnectionStatus> {
    return this.connect();
  }

  async disconnect(): Promise<TeamChatConnectionStatus> {
    return this.enqueueConnection(async () => {
      await this.closeCurrentStore();
      this.setStatus({
        state: "unconfigured",
        mode: "local",
        databaseLabel: "AgentRecall database",
      });
      return this.getConnectionStatus();
    });
  }

  async close(): Promise<void> {
    await this.enqueueConnection(async () => {
      await this.closeCurrentStore();
      return this.getConnectionStatus();
    });
    this.listeners.clear();
  }

  async listRooms(): Promise<TeamChatRoomSummary[]> {
    return this.requireStore().listRooms();
  }

  async getRoom(roomId: string): Promise<TeamChatRoom | undefined> {
    const room = await this.requireStore().getRoom(roomId);
    return room ? this.decorateRoom(room) : undefined;
  }

  async createRoom(request: CreateTeamChatRoomRequest): Promise<TeamChatRoom> {
    const createdAt = this.timestamp();
    const roomId = this.id();
    const agents = this.resolveRoomMembers(roomId, request.members, [], createdAt);
    const room: TeamChatRoom = {
      id: roomId,
      name: request.name.trim(),
      workDir: request.workDir.trim(),
      archived: false,
      agents,
      createdAt,
      updatedAt: createdAt,
    };
    const created = await this.requireStore().createRoom(room);
    this.emit({ type: "rooms-changed" });
    return this.decorateRoom(created);
  }

  async updateRoom(request: UpdateTeamChatRoomRequest): Promise<TeamChatRoom> {
    const store = this.requireStore();
    const current = await store.getRoom(request.roomId);
    if (!current) throw new Error("Team Chat room was not found.");
    const updatedAt = this.timestamp();
    const agents = request.members
      ? this.resolveRoomMembers(current.id, request.members, current.agents, updatedAt)
      : current.agents;
    const updated: TeamChatRoom = {
      ...current,
      name: request.name === undefined ? current.name : request.name.trim(),
      workDir: request.workDir === undefined ? current.workDir : request.workDir.trim(),
      agents,
      updatedAt,
    };
    const saved = await store.updateRoom(updated);
    this.emit({ type: "rooms-changed" });
    return this.decorateRoom(saved);
  }

  async archiveRoom(roomId: string): Promise<void> {
    await this.requireStore().archiveRoom(roomId, this.timestamp());
    this.emit({ type: "rooms-changed" });
  }

  async listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> {
    return this.requireStore().listMessages(request);
  }

  async resetAgentSession(roomId: string, agentId: string): Promise<TeamChatRoom> {
    const store = this.requireStore();
    const room = await store.getRoom(roomId);
    if (!room || room.archived) throw new Error("Team Chat room is unavailable.");
    if (!room.agents.some((agent) => agent.agentId === agentId)) {
      throw new Error("Studio employee was not found.");
    }
    await store.deleteAgentSession(roomId, agentId);
    this.emit({ type: "agent-session-changed", roomId, agentId });
    return this.decorateRoom(room);
  }

  async sendMessage(request: SendTeamChatMessageRequest): Promise<SendTeamChatMessageResult> {
    const store = this.requireStore();
    const room = await store.getRoom(request.roomId);
    if (!room || room.archived) throw new Error("Team Chat room is unavailable.");
    const content = request.content.trim();
    if (!content) throw new Error("Enter a message before sending.");
    const targets = resolveTeamChatTargets(request.targetMemberIds, this.routableRoomMembers(room));
    if (targets.length === 0) throw new Error("Select at least one available employee.");
    if (targets.length > MAX_ROOT_DISPATCHES) {
      throw new Error(`Select up to ${MAX_ROOT_DISPATCHES} employees for one message.`);
    }

    const messageId = this.id();
    const createdAt = this.timestamp();
    const message = await store.insertMessage({
      id: messageId,
      roomId: room.id,
      sequence: 0,
      senderType: "human",
      senderName: "You",
      content,
      ...(targets.length === 1 ? { recipientMemberId: targets[0] } : {}),
      deliveryType: request.replyToMessageId ? "reply" : "message",
      rootMessageId: messageId,
      ...(request.replyToMessageId ? { sourceMessageId: request.replyToMessageId } : {}),
      hop: 0,
      status: "final",
      createdAt,
      updatedAt: createdAt,
    });
    this.emit({ type: "message-created", roomId: room.id, rootMessageId: messageId, message });
    this.emit({ type: "rooms-changed" });

    const controller = new AbortController();
    this.rootControllers.set(messageId, controller);
    this.rootDispatchCounts.set(messageId, targets.length);
    for (const targetAgentId of targets) {
      void this.enqueueMemberExecution({
        room,
        targetAgentId,
        sourceMessage: message,
        rootMessage: message,
        hop: 0,
        controller,
      });
    }
    return { message, rootMessageId: messageId };
  }

  async stopTurn(rootMessageId: string): Promise<boolean> {
    const controller = this.rootControllers.get(rootMessageId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async handleMcpRequest(
    token: string | undefined,
    route: string,
    body: unknown,
  ): Promise<unknown> {
    const scope = this.requireStudioScope(token);
    const normalizedRoute = route.replace(/^\/?mcp\//u, "").replace(/^\/+/u, "");
    const input = asRecord(body);
    switch (normalizedRoute) {
      case "studio/list-members":
        return this.listStudioMembers(scope);
      case "studio/send-message":
        return this.sendStudioMessage(scope, input);
      case "studio/post":
        return this.postStudioMessage(scope, input);
      case "studio/read-messages":
        return this.readStudioMessages(scope, input);
      case "studio/read-range":
        return this.readStudioRange(scope, input);
      case "studio/search":
        return this.searchStudioMessages(scope, input);
      case "workspace/reserve":
        return this.reserveWorkspace(scope, input);
      case "workspace/release":
        return this.releaseWorkspace(scope, input);
      case "workspace/status":
        return this.workspaceStatus(scope, input);
      default:
        throw new Error("Unknown Studio collaboration tool.");
    }
  }

  private async listStudioMembers(scope: StudioExecutionScope): Promise<unknown> {
    const room = await this.requireStudioRoom(scope);
    return {
      studio: { id: room.id, name: room.name, workDir: room.workDir },
      currentMemberId: scope.memberId,
      members: this.routableRoomMembers(room)
        .sort((left, right) => left.position - right.position)
        .map((member) => ({
          memberId: member.agentId,
          displayName: member.displayName,
          configuredAgentId: member.configuredAgentId,
          enabled: member.enabled,
          state: this.memberQueueTails.has(`${room.id}:${member.agentId}`) ? "busy" : "idle",
          self: member.agentId === scope.memberId,
        })),
    };
  }

  private async sendStudioMessage(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const room = await this.requireStudioRoom(scope);
    const sender = room.agents.find((member) => member.agentId === scope.memberId);
    const toMemberId = requiredString(input.toMemberId, "toMemberId");
    const content = requiredString(input.content, "content");
    if (toMemberId === scope.memberId) {
      throw new Error("studio_send_message must target another studio employee.");
    }
    const target = this.routableRoomMembers(room)
      .find((member) => member.agentId === toMemberId && member.enabled);
    if (!target) throw new Error("The target studio employee is unavailable.");
    const replyTo = optionalString(input.replyTo);
    if (replyTo) await this.requireRoomMessage(room.id, replyTo);

    const persistedDispatchCount = await this.requireStore().countRootDispatches(scope.rootMessageId);
    const dispatchCount = Math.max(
      persistedDispatchCount,
      this.rootDispatchCounts.get(scope.rootMessageId) ?? 0,
    );
    if (dispatchCount >= MAX_ROOT_DISPATCHES) {
      await this.insertSystemMessage(
        room.id,
        scope.rootMessageId,
        scope.sourceMessageId,
        scope.hop + 1,
        `Studio collaboration stopped after ${MAX_ROOT_DISPATCHES} employee activations.`,
      );
      return {
        ok: false,
        error: `This collaboration chain reached its ${MAX_ROOT_DISPATCHES}-activation limit.`,
      };
    }

    const createdAt = this.timestamp();
    const message = await this.requireStore().insertMessage({
      id: this.id(),
      roomId: room.id,
      sequence: 0,
      senderType: "agent",
      senderAgentId: scope.memberId,
      recipientMemberId: target.agentId,
      senderName: sender?.displayName ?? "Studio employee",
      content,
      deliveryType: "message",
      rootMessageId: scope.rootMessageId,
      sourceMessageId: replyTo ?? scope.sourceMessageId,
      hop: scope.hop + 1,
      status: "final",
      createdAt,
      updatedAt: createdAt,
    });
    this.emit({ type: "message-created", roomId: room.id, rootMessageId: scope.rootMessageId, message });
    this.emit({ type: "rooms-changed" });

    const rootMessage = await this.requireRoomMessage(room.id, scope.rootMessageId);
    this.rootDispatchCounts.set(scope.rootMessageId, dispatchCount + 1);
    void this.enqueueMemberExecution({
      room,
      targetAgentId: target.agentId,
      sourceMessage: message,
      rootMessage,
      hop: scope.hop + 1,
      controller: scope.controller,
    });
    return {
      ok: true,
      message,
      activatedMemberId: target.agentId,
    };
  }

  private async postStudioMessage(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const room = await this.requireStudioRoom(scope);
    const sender = room.agents.find((member) => member.agentId === scope.memberId);
    const content = requiredString(input.content, "content");
    const replyTo = optionalString(input.replyTo);
    if (replyTo) await this.requireRoomMessage(room.id, replyTo);
    const createdAt = this.timestamp();
    const message = await this.requireStore().insertMessage({
      id: this.id(),
      roomId: room.id,
      sequence: 0,
      senderType: "agent",
      senderAgentId: scope.memberId,
      senderName: sender?.displayName ?? "Studio employee",
      content,
      deliveryType: "post",
      rootMessageId: scope.rootMessageId,
      sourceMessageId: replyTo ?? scope.sourceMessageId,
      hop: scope.hop + 1,
      status: "final",
      createdAt,
      updatedAt: createdAt,
    });
    this.emit({ type: "message-created", roomId: room.id, rootMessageId: scope.rootMessageId, message });
    this.emit({ type: "rooms-changed" });
    return { ok: true, message };
  }

  private async readStudioMessages(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    await this.requireStudioRoom(scope);
    const messageIds = stringArray(input.messageIds, "messageIds", 1, 50);
    return { messages: await this.requireStore().getMessages(scope.roomId, messageIds) };
  }

  private async readStudioRange(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    await this.requireStudioRoom(scope);
    const after = optionalBoundedInteger(input.after, "after", 0, Number.MAX_SAFE_INTEGER);
    const before = optionalBoundedInteger(input.before, "before", 1, Number.MAX_SAFE_INTEGER);
    const limit = optionalBoundedInteger(input.limit, "limit", 1, 100) ?? 50;
    return {
      messages: await this.requireStore().readMessageRange(scope.roomId, {
        ...(after === undefined ? {} : { after }),
        ...(before === undefined ? {} : { before }),
        limit,
      }),
    };
  }

  private async searchStudioMessages(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    await this.requireStudioRoom(scope);
    const query = requiredString(input.query, "query");
    const limit = optionalBoundedInteger(input.limit, "limit", 1, 50) ?? 20;
    return {
      messages: await this.requireStore().searchMessages(scope.roomId, query, limit),
    };
  }

  private async reserveWorkspace(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    await this.requireStudioRoom(scope);
    const paths = normalizeWorkspacePaths(input.paths, 1);
    const reason = optionalString(input.reason);
    const store = this.requireStore();
    const existing = await store.listWorkspaceReservations(scope.roomId, paths);
    const conflicts = existing.filter((reservation) => reservation.memberId !== scope.memberId);
    if (conflicts.length > 0) return { ok: false, conflicts };

    const updatedAt = this.timestamp();
    const expiresAt = new Date(
      new Date(updatedAt).getTime() + WORKSPACE_RESERVATION_LIFETIME_MS,
    ).toISOString();
    const existingByPath = new Map(existing.map((reservation) => [reservation.relativePath, reservation]));
    const reservations: TeamChatWorkspaceReservation[] = paths.map((relativePath) => ({
      roomId: scope.roomId,
      memberId: scope.memberId,
      relativePath,
      ...(reason ? { reason } : {}),
      expiresAt,
      createdAt: existingByPath.get(relativePath)?.createdAt ?? updatedAt,
      updatedAt,
    }));
    await store.reserveWorkspacePaths(reservations);
    return { ok: true, reservations };
  }

  private async releaseWorkspace(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    await this.requireStudioRoom(scope);
    const paths = normalizeWorkspacePaths(input.paths, 1);
    const released = await this.requireStore().releaseWorkspacePaths(
      scope.roomId,
      scope.memberId,
      paths,
    );
    return { ok: true, released };
  }

  private async workspaceStatus(
    scope: StudioExecutionScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    await this.requireStudioRoom(scope);
    const paths = input.paths === undefined ? undefined : normalizeWorkspacePaths(input.paths, 0);
    return {
      reservations: await this.requireStore().listWorkspaceReservations(scope.roomId, paths),
    };
  }

  private requireStudioScope(token: string | undefined): StudioExecutionScope {
    const scope = token ? this.studioScopes.get(token) : undefined;
    if (!scope || scope.expiresAt <= Date.now()) {
      if (token) this.studioScopes.delete(token);
      throw new Error("The Studio execution scope is invalid or expired.");
    }
    return scope;
  }

  private async requireStudioRoom(scope: StudioExecutionScope): Promise<TeamChatRoom> {
    const room = await this.requireStore().getRoom(scope.roomId);
    if (!room || room.archived) throw new Error("The scoped Studio is unavailable.");
    if (!room.agents.some((member) => member.agentId === scope.memberId && member.enabled)) {
      throw new Error("The scoped Studio employee is unavailable.");
    }
    return room;
  }

  private async requireRoomMessage(roomId: string, messageId: string): Promise<TeamChatMessage> {
    const message = (await this.requireStore().getMessages(roomId, [messageId]))[0];
    if (!message) throw new Error("The referenced Studio message was not found.");
    return message;
  }

  private enqueueMemberExecution(input: {
    room: TeamChatRoom;
    targetAgentId: string;
    sourceMessage: TeamChatMessage;
    rootMessage: TeamChatMessage;
    hop: number;
    controller: AbortController;
  }): Promise<void> {
    this.retainRootActivity(input.rootMessage.id);
    const key = `${input.room.id}:${input.targetAgentId}`;
    const prior = this.memberQueueTails.get(key) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        if (!input.controller.signal.aborted) await this.runAgent(input);
      });
    this.memberQueueTails.set(key, next);
    void next.finally(() => {
      if (this.memberQueueTails.get(key) === next) this.memberQueueTails.delete(key);
      this.releaseRootActivity(input.room.id, input.rootMessage.id, input.controller);
    });
    this.trackWork(next);
    return next;
  }

  private async runAgent(input: {
    room: TeamChatRoom;
    targetAgentId: string;
    sourceMessage: TeamChatMessage;
    rootMessage: TeamChatMessage;
    hop: number;
    controller: AbortController;
  }): Promise<void> {
    const target = input.room.agents.find(
      (agent) => agent.agentId === input.targetAgentId && agent.enabled,
    );
    if (!target) return;
    const configured = this.dependencies.configuredAgents()
      .find((agent) => agent.id === target.configuredAgentId);
    if (!configured) {
      await this.insertSystemMessage(
        input.room.id,
        input.rootMessage.id,
        input.sourceMessage.id,
        input.hop + 1,
        `${target.displayName} is no longer connected to an available Agent configuration.`,
        "error",
      );
      return;
    }

    const store = this.requireStore();
    const continuationAvailable = supportsConfiguredAgentConversation(configured.runtimeAgentId);
    let agentSession = (await store.listAgentSessions(input.room.id))
      .find((session) => session.agentId === target.agentId);
    if (agentSession && (!continuationAvailable || !agentSessionMatches(agentSession, configured))) {
      await store.deleteAgentSession(input.room.id, target.agentId);
      this.emit({ type: "agent-session-changed", roomId: input.room.id, agentId: target.agentId });
      agentSession = undefined;
    }
    let context = await this.loadAgentContext(
      input.room.id,
      target.agentId,
      input.sourceMessage,
      agentSession,
    );

    const dispatchId = this.id();
    const createdAt = this.timestamp();
    const dispatch: TeamChatDispatch = {
      id: dispatchId,
      roomId: input.room.id,
      rootMessageId: input.rootMessage.id,
      sourceMessageId: input.sourceMessage.id,
      targetAgentId: target.agentId,
      hop: input.hop,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
    };
    await store.insertDispatch(dispatch);
    const startedAt = this.timestamp();
    await store.updateDispatch(dispatchId, { status: "running", startedAt, updatedAt: startedAt });
    this.emit({
      type: "dispatch-started",
      roomId: input.room.id,
      rootMessageId: input.rootMessage.id,
      dispatchId,
      agentId: target.agentId,
      agentName: target.displayName,
    });

    const studioToken = randomUUID();
    this.studioScopes.set(studioToken, {
      roomId: input.room.id,
      memberId: target.agentId,
      dispatchId,
      rootMessageId: input.rootMessage.id,
      sourceMessageId: input.sourceMessage.id,
      hop: input.hop,
      controller: input.controller,
      expiresAt: Date.now() + STUDIO_SCOPE_LIFETIME_MS,
    });
    try {
      let attemptSawDelta = false;
      const executeAttempt = (
        currentContext: TeamChatContextPage,
        currentSession?: TeamChatAgentSession,
      ) => {
        attemptSawDelta = false;
        const range = messageSequenceRange(currentContext.messages);
        return this.dependencies.executeAgent(
          {
            configuredAgentId: target.configuredAgentId,
            prompt: buildTeamChatPrompt({
              room: input.room,
              target,
              explicitContext: currentContext.messages,
              triggerMessage: input.sourceMessage,
              unreadCount: currentContext.messages.length,
              ...(range ? { unreadSequenceRange: range } : {}),
              continuing: Boolean(currentSession),
              contextTruncated: currentContext.truncated,
            }),
            workDir: input.room.workDir || undefined,
            ...(currentSession ? { runtimeConversation: currentSession.runtimeConversation } : {}),
            developerInstructions: buildStudioDeveloperInstructions(input.room, target),
            agentRecallMcp: { studioToken },
          },
          (event) => {
            if (event.type !== "delta" || input.controller.signal.aborted) return;
            attemptSawDelta = true;
            this.emit({
              type: "dispatch-delta",
              roomId: input.room.id,
              rootMessageId: input.rootMessage.id,
              dispatchId,
              agentId: target.agentId,
              content: event.content,
            });
          },
          input.controller.signal,
        );
      };

      let result: Awaited<ReturnType<typeof executeAttempt>>;
      try {
        result = await executeAttempt(context, agentSession);
      } catch (error) {
        const canRetryFresh =
          Boolean(agentSession) &&
          !attemptSawDelta &&
          !input.controller.signal.aborted &&
          isNativeConversationUnavailable(error);
        if (!canRetryFresh) throw error;
        await store.deleteAgentSession(input.room.id, target.agentId);
        this.emit({ type: "agent-session-changed", roomId: input.room.id, agentId: target.agentId });
        agentSession = undefined;
        context = await this.loadAgentContext(
          input.room.id,
          target.agentId,
          input.sourceMessage,
        );
        result = await executeAttempt(context);
      }
      if (input.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const content = result.output.trim() || "Employee completed without a text response.";
      const messageAt = this.timestamp();
      const message = await store.insertMessage({
        id: this.id(),
        roomId: input.room.id,
        sequence: 0,
        senderType: "agent",
        senderAgentId: target.agentId,
        senderName: target.displayName,
        content,
        deliveryType: "reply",
        rootMessageId: input.rootMessage.id,
        sourceMessageId: input.sourceMessage.id,
        hop: input.hop + 1,
        status: "final",
        createdAt: messageAt,
        updatedAt: messageAt,
      });

      const nextConversation =
        result.runtimeConversation?.runtimeId === configured.runtimeAgentId
          ? result.runtimeConversation
          : agentSession?.runtimeConversation;
      if (continuationAvailable && nextConversation) {
        await store.upsertAgentSession({
          roomId: input.room.id,
          agentId: target.agentId,
          runtimeId: configured.runtimeAgentId,
          channelId: configured.channelId,
          modelId: configured.modelId,
          runtimeConversation: nextConversation,
          lastContextMessageId: input.sourceMessage.id,
          updatedAt: messageAt,
        });
        this.emit({ type: "agent-session-changed", roomId: input.room.id, agentId: target.agentId });
      }

      const finishedAt = this.timestamp();
      await store.updateDispatch(dispatchId, {
        status: "completed",
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
      });
      this.emit({ type: "message-created", roomId: input.room.id, rootMessageId: input.rootMessage.id, message });
      this.emit({ type: "rooms-changed" });
      this.emit({
        type: "dispatch-finished",
        roomId: input.room.id,
        rootMessageId: input.rootMessage.id,
        dispatchId,
        agentId: target.agentId,
        status: "completed",
      });
    } catch (error) {
      const interrupted = input.controller.signal.aborted || isAbortError(error);
      const status = interrupted ? "interrupted" : "failed";
      const safeError = interrupted ? "Stopped" : sanitizeTeamChatError(error);
      const finishedAt = this.timestamp();
      await store.updateDispatch(dispatchId, {
        status,
        error: safeError,
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
      });
      if (!interrupted) {
        await this.insertSystemMessage(
          input.room.id,
          input.rootMessage.id,
          input.sourceMessage.id,
          input.hop + 1,
          `${target.displayName} failed: ${safeError}`,
          "error",
        );
      }
      this.emit({
        type: "dispatch-finished",
        roomId: input.room.id,
        rootMessageId: input.rootMessage.id,
        dispatchId,
        agentId: target.agentId,
        status,
        ...(interrupted ? {} : { error: safeError }),
      });
    } finally {
      this.studioScopes.delete(studioToken);
    }
  }

  private async loadAgentContext(
    roomId: string,
    memberId: string,
    triggerMessage: TeamChatMessage,
    agentSession?: TeamChatAgentSession,
  ): Promise<TeamChatContextPage> {
    const store = this.requireStore();
    const page = await store.listDirectedContext(
      roomId,
      memberId,
      agentSession?.lastContextMessageId,
      CONTEXT_MESSAGE_LIMIT,
    );
    const messages = page.messages;

    if (
      triggerMessage.sourceMessageId &&
      !messages.some((message) => message.id === triggerMessage.sourceMessageId)
    ) {
      const parent = (await store.getMessages(roomId, [triggerMessage.sourceMessageId]))[0];
      if (parent) messages.unshift(parent);
    }
    return { messages, truncated: page.truncated };
  }

  private async insertSystemMessage(
    roomId: string,
    rootMessageId: string,
    sourceMessageId: string,
    hop: number,
    content: string,
    status: TeamChatMessage["status"] = "final",
  ): Promise<TeamChatMessage> {
    const createdAt = this.timestamp();
    const message = await this.requireStore().insertMessage({
      id: this.id(),
      roomId,
      sequence: 0,
      senderType: "system",
      senderName: "AgentRecall",
      content,
      deliveryType: "post",
      rootMessageId,
      sourceMessageId,
      hop,
      status,
      createdAt,
      updatedAt: createdAt,
    });
    this.emit({ type: "message-created", roomId, rootMessageId, message });
    this.emit({ type: "rooms-changed" });
    return message;
  }

  private resolveRoomMembers(
    roomId: string,
    inputs: TeamChatRoomMemberInput[],
    current: TeamChatRoomAgent[],
    joinedAt: string,
  ): TeamChatRoomAgent[] {
    if (inputs.length === 0) throw new Error("Select at least one employee for the studio.");
    const configuredById = new Map(
      this.dependencies.configuredAgents().map((agent) => [agent.id, agent]),
    );
    const memberIds = new Set<string>();
    const displayNames = new Set<string>();
    return inputs.map((input, position) => {
      const configured = configuredById.get(input.configuredAgentId);
      if (!configured) {
        throw new Error(`Configured Agent is unavailable: ${input.configuredAgentId}`);
      }
      const displayName = input.displayName.trim();
      if (!displayName) throw new Error("Employee name is required.");
      const normalizedName = displayName.toLocaleLowerCase();
      if (displayNames.has(normalizedName)) {
        throw new Error(`Employee names must be unique in a studio: ${displayName}`);
      }
      displayNames.add(normalizedName);
      const existing = input.memberId
        ? current.find((member) => member.agentId === input.memberId)
        : undefined;
      if (input.memberId && !existing) {
        throw new Error(`Studio employee was not found: ${input.memberId}`);
      }
      const memberId = existing?.agentId ?? this.id();
      if (memberIds.has(memberId)) throw new Error("Studio employees must be unique.");
      memberIds.add(memberId);
      return roomAgentSnapshot(
        roomId,
        memberId,
        displayName,
        configured,
        position,
        existing?.joinedAt ?? joinedAt,
      );
    });
  }

  private routableRoomMembers(room: TeamChatRoom): TeamChatRoomAgent[] {
    const availableAgentIds = new Set(this.dependencies.configuredAgents().map((agent) => agent.id));
    return room.agents.map((member) => availableAgentIds.has(member.configuredAgentId)
      ? member
      : { ...member, enabled: false });
  }

  private async decorateRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    const store = this.requireStore();
    const configuredById = new Map(
      this.dependencies.configuredAgents().map((agent) => [agent.id, agent]),
    );
    const sessionsByAgentId = new Map(
      (await store.listAgentSessions(room.id)).map((session) => [session.agentId, session]),
    );
    const agents = await Promise.all(room.agents.map(async (member): Promise<TeamChatRoomAgent> => {
      const configured = configuredById.get(member.configuredAgentId);
      const continuationAvailable = Boolean(
        configured && supportsConfiguredAgentConversation(configured.runtimeAgentId),
      );
      const storedSession = sessionsByAgentId.get(member.agentId);
      const compatibleSession =
        configured &&
        continuationAvailable &&
        storedSession &&
        agentSessionMatches(storedSession, configured)
          ? storedSession
          : undefined;
      if (storedSession && configured && !compatibleSession) {
        await store.deleteAgentSession(room.id, member.agentId);
      }
      return {
        ...member,
        continuationAvailable,
        hasActiveConversation: Boolean(compatibleSession),
        ...(compatibleSession ? { conversationUpdatedAt: compatibleSession.updatedAt } : {}),
      };
    }));
    return { ...room, agents };
  }

  private requireStore(): TeamChatStore {
    if (!this.store || this.status.state !== "ready") {
      throw new Error("The Chat database is not ready yet.");
    }
    return this.store;
  }

  private async closeCurrentStore(): Promise<void> {
    for (const controller of this.rootControllers.values()) controller.abort();
    if (this.activeWorkPromises.size > 0) {
      await Promise.allSettled([...this.activeWorkPromises]);
    }
    this.rootControllers.clear();
    this.rootActivityCounts.clear();
    this.rootDispatchCounts.clear();
    this.memberQueueTails.clear();
    this.studioScopes.clear();
    const current = this.store;
    this.store = undefined;
    if (current) await current.close();
  }

  private trackWork(work: Promise<void>): void {
    this.activeWorkPromises.add(work);
    void work.finally(() => this.activeWorkPromises.delete(work));
  }

  private retainRootActivity(rootMessageId: string): void {
    this.rootActivityCounts.set(
      rootMessageId,
      (this.rootActivityCounts.get(rootMessageId) ?? 0) + 1,
    );
  }

  private releaseRootActivity(
    roomId: string,
    rootMessageId: string,
    controller: AbortController,
  ): void {
    const remaining = (this.rootActivityCounts.get(rootMessageId) ?? 1) - 1;
    if (remaining > 0) {
      this.rootActivityCounts.set(rootMessageId, remaining);
      return;
    }
    this.rootActivityCounts.delete(rootMessageId);
    this.rootDispatchCounts.delete(rootMessageId);
    if (this.rootControllers.get(rootMessageId) === controller) {
      this.rootControllers.delete(rootMessageId);
    }
    this.emit({ type: "turn-finished", roomId, rootMessageId });
  }

  private enqueueConnection(
    operation: () => Promise<TeamChatConnectionStatus>,
  ): Promise<TeamChatConnectionStatus> {
    const promise = this.connectionQueue.then(operation, operation);
    this.connectionQueue = promise.then(() => undefined, () => undefined);
    return promise;
  }

  private emit(event: TeamChatEvent): void {
    this.dependencies.emit?.(event);
    for (const listener of this.listeners) listener(event);
  }

  private setStatus(status: TeamChatConnectionStatus): void {
    this.status = status;
    this.emit({ type: "connection-changed", status: this.getConnectionStatus() });
  }

  private id(): string {
    return (this.dependencies.idFactory ?? randomUUID)();
  }

  private timestamp(): string {
    return (this.dependencies.now ?? (() => new Date()))().toISOString();
  }
}

function roomAgentSnapshot(
  roomId: string,
  memberId: string,
  displayName: string,
  agent: ConfiguredAgent,
  position: number,
  joinedAt: string,
): TeamChatRoomAgent {
  return {
    roomId,
    agentId: memberId,
    configuredAgentId: agent.id,
    displayName,
    runtimeId: agent.runtimeAgentId,
    channelId: agent.channelId,
    modelId: agent.modelId,
    enabled: true,
    position,
    joinedAt,
    continuationAvailable: supportsConfiguredAgentConversation(agent.runtimeAgentId),
    hasActiveConversation: false,
  };
}

function messageSequenceRange(
  messages: TeamChatMessage[],
): { from: number; to: number } | undefined {
  if (messages.length === 0) return undefined;
  return {
    from: Math.min(...messages.map((message) => message.sequence)),
    to: Math.max(...messages.map((message) => message.sequence)),
  };
}

function agentSessionMatches(session: TeamChatAgentSession, agent: ConfiguredAgent): boolean {
  return (
    session.runtimeId === agent.runtimeAgentId &&
    session.channelId === agent.channelId &&
    session.modelId === agent.modelId &&
    session.runtimeConversation.runtimeId === agent.runtimeAgentId
  );
}

function sanitizeTeamChatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(?:postgres|postgresql|https?):\/\/\S+/giu, "[redacted URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "Unknown Agent error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isNativeConversationUnavailable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  const conversation = "(?:conversation|session|thread|rollout)";
  const unavailable = "(?:not found|does not exist|missing|expired|invalid|unavailable)";
  return (
    new RegExp(`${conversation}.{0,80}${unavailable}`, "u").test(message) ||
    new RegExp(`${unavailable}.{0,80}${conversation}`, "u").test(message) ||
    /no rollout found/u.test(message)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const strings = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field} must contain non-empty strings.`);
    }
    return item.trim();
  });
  if (strings.length < minimum || strings.length > maximum) {
    throw new Error(`${field} must contain between ${minimum} and ${maximum} items.`);
  }
  return [...new Set(strings)];
}

function optionalBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function normalizeWorkspacePaths(value: unknown, minimum: number): string[] {
  const paths = stringArray(value, "paths", minimum, 50).map((rawPath) => {
    if (
      rawPath.includes("\0") ||
      path.posix.isAbsolute(rawPath) ||
      path.win32.isAbsolute(rawPath)
    ) {
      throw new Error("Workspace reservations require project-relative paths.");
    }
    const slashPath = rawPath.replaceAll("\\", "/");
    const segments = slashPath.split("/");
    if (segments.includes("..")) {
      throw new Error("Workspace reservations require project-relative paths without '..'.");
    }
    const normalized = path.posix.normalize(slashPath).replace(/^\.\//u, "");
    if (!normalized || normalized === ".") {
      throw new Error("Workspace reservations require non-empty project-relative paths.");
    }
    return normalized;
  });
  return [...new Set(paths)];
}
