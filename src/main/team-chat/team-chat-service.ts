import { randomUUID } from "node:crypto";
import type {
  ConfiguredAgent,
  RuntimeConversation,
  WorkflowAgentEvent,
} from "../../automation/contracts";
import { supportsConfiguredAgentConversation } from "../../automation/engine/main/platform/configured-agent-execution-service";
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
  UpdateTeamChatRoomRequest,
} from "../../shared/team-chat";
import {
  buildTeamChatPrompt,
  resolveTeamChatTargets,
} from "./team-chat-routing";
import type {
  TeamChatAgentSession,
  TeamChatContextPage,
  TeamChatStore,
} from "./team-chat-store";

const CONTEXT_MESSAGE_LIMIT = 40;

interface TeamChatServiceDependencies {
  configuredAgents: () => ConfiguredAgent[];
  executeAgent: (
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      runtimeConversation?: RuntimeConversation;
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
  private readonly memberQueueTails = new Map<string, Promise<void>>();
  private readonly activeWorkPromises = new Set<Promise<void>>();
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
    const work = Promise.allSettled(targets.map((targetAgentId) => this.enqueueMemberExecution({
      room,
      targetAgentId,
      sourceMessage: message,
      rootMessage: message,
      hop: 0,
      controller,
    }))).then(() => undefined).finally(() => {
      if (this.rootControllers.get(messageId) === controller) this.rootControllers.delete(messageId);
      this.emit({ type: "turn-finished", roomId: room.id, rootMessageId: messageId });
    });
    this.trackWork(work);
    return { message, rootMessageId: messageId };
  }

  async stopTurn(rootMessageId: string): Promise<boolean> {
    const controller = this.rootControllers.get(rootMessageId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private enqueueMemberExecution(input: {
    room: TeamChatRoom;
    targetAgentId: string;
    sourceMessage: TeamChatMessage;
    rootMessage: TeamChatMessage;
    hop: number;
    controller: AbortController;
  }): Promise<void> {
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
    }
  }

  private async loadAgentContext(
    roomId: string,
    memberId: string,
    triggerMessage: TeamChatMessage,
    agentSession?: TeamChatAgentSession,
  ): Promise<TeamChatContextPage> {
    const store = this.requireStore();
    const page = agentSession?.lastContextMessageId
      ? await store.listMessagesAfter(roomId, agentSession.lastContextMessageId, CONTEXT_MESSAGE_LIMIT)
      : await store.listMessages({ roomId, limit: CONTEXT_MESSAGE_LIMIT }).then((result) => ({
          messages: result.messages,
          truncated: Boolean(result.nextBefore),
        }));
    const messages = page.messages.filter((message) =>
      message.id === triggerMessage.id ||
      message.senderAgentId === memberId ||
      message.recipientMemberId === memberId ||
      message.senderType === "system" ||
      message.deliveryType === "post");

    if (
      triggerMessage.sourceMessageId &&
      !messages.some((message) => message.id === triggerMessage.sourceMessageId)
    ) {
      const recent = await store.listMessages({ roomId, limit: 100 });
      const parent = recent.messages.find((message) => message.id === triggerMessage.sourceMessageId);
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
    this.memberQueueTails.clear();
    const current = this.store;
    this.store = undefined;
    if (current) await current.close();
  }

  private trackWork(work: Promise<void>): void {
    this.activeWorkPromises.add(work);
    void work.finally(() => this.activeWorkPromises.delete(work));
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
