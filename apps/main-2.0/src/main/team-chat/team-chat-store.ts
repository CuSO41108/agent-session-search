import type { RuntimeConversation } from "../../automation/contracts";
import type {
  ListTeamChatMessagesRequest,
  TeamChatDispatch,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomSummary,
  TeamChatWorkspaceReservation,
} from "../../shared/team-chat";

export interface TeamChatDispatchUpdate {
  status: TeamChatDispatch["status"];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface TeamChatAgentSession {
  roomId: string;
  agentId: string;
  runtimeId: string;
  channelId: string;
  modelId: string;
  runtimeConversation: RuntimeConversation;
  lastContextMessageId?: string;
  roomContextSequence: number;
  updatedAt: string;
}

export interface TeamChatContextPage {
  messages: TeamChatMessage[];
  truncated: boolean;
  snapshotSequence?: number;
  omittedSequenceRange?: { from: number; to: number };
}

export interface TeamChatMessageRange {
  after?: number;
  before?: number;
  limit: number;
}

export type TeamChatTaskStatus =
  | "in_progress"
  | "completed"
  | "blocked"
  | "waiting_input";

export interface TeamChatMention {
  id: string;
  roomId: string;
  messageId: string;
  memberId: string;
  createdAt: string;
}

export interface TeamChatTask {
  id: string;
  roomId: string;
  memberId: string;
  rootMessageId: string;
  status: TeamChatTaskStatus;
  summary?: string;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type TeamChatExecutionAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface TeamChatExecutionAttempt {
  id: string;
  dispatchId: string;
  attemptNumber: number;
  runtimeId: string;
  runtimeSessionRef?: string;
  nativeTurnId?: string;
  roomSnapshotSequence: number;
  roomSequenceAtFinish?: number;
  status: TeamChatExecutionAttemptStatus;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type TeamChatAttemptEventType =
  | "delta"
  | "tool_call"
  | "tool_result"
  | "approval_request"
  | "approval_response"
  | "completed"
  | "error";

export interface TeamChatAttemptEvent {
  id: string;
  attemptId: string;
  sequence: number;
  type: TeamChatAttemptEventType;
  name?: string;
  content: string;
  createdAt: string;
}

export interface TeamChatPendingActivation {
  mention: TeamChatMention;
  task: TeamChatTask;
  dispatch: TeamChatDispatch;
}

export interface TeamChatPersistedActivations {
  message: TeamChatMessage;
  activations: TeamChatPendingActivation[];
}

export interface TeamChatInboxItem {
  mentionId: string;
  messageId: string;
  taskId: string;
  turnId: string;
  memberId: string;
  sequence: number;
  content: string;
  status: TeamChatDispatch["status"];
  createdAt: string;
  updatedAt: string;
}

export interface TeamChatExecutionAttemptUpdate {
  status: TeamChatExecutionAttemptStatus;
  runtimeSessionRef?: string;
  nativeTurnId?: string;
  roomSequenceAtFinish?: number;
  error?: string;
  finishedAt?: string;
}

export interface TeamChatTaskFinish {
  status: Exclude<TeamChatTaskStatus, "in_progress">;
  summary: string;
  evidence: string[];
  finishedAt: string;
}

export interface TeamChatRoomTurn {
  dispatch: TeamChatDispatch;
  task?: TeamChatTask;
  triggerMessage: TeamChatMessage;
  replyMessage?: TeamChatMessage;
}

export interface TeamChatStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listRooms(): Promise<TeamChatRoomSummary[]>;
  getRoom(roomId: string): Promise<TeamChatRoom | undefined>;
  createRoom(room: TeamChatRoom): Promise<TeamChatRoom>;
  updateRoom(room: TeamChatRoom): Promise<TeamChatRoom>;
  archiveRoom(roomId: string, updatedAt: string): Promise<void>;
  deleteRoom(roomId: string): Promise<boolean>;
  listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage>;
  getLatestMessageSequence(roomId: string): Promise<number>;
  listRoomContext(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ): Promise<TeamChatContextPage>;
  getMessages(roomId: string, messageIds: string[]): Promise<TeamChatMessage[]>;
  readMessageRange(roomId: string, range: TeamChatMessageRange): Promise<TeamChatMessage[]>;
  searchMessages(roomId: string, query: string, limit: number): Promise<TeamChatMessage[]>;
  insertMessage(message: TeamChatMessage): Promise<TeamChatMessage>;
  insertMessageWithActivations(
    message: TeamChatMessage,
    activations: TeamChatPendingActivation[],
  ): Promise<TeamChatPersistedActivations>;
  insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch>;
  listQueuedDispatches(): Promise<TeamChatDispatch[]>;
  listInbox(
    roomId: string,
    memberId: string,
    status: TeamChatDispatch["status"] | undefined,
    limit: number,
  ): Promise<TeamChatInboxItem[]>;
  insertExecutionAttempt(attempt: TeamChatExecutionAttempt): Promise<void>;
  updateExecutionAttempt(
    attemptId: string,
    patch: TeamChatExecutionAttemptUpdate,
  ): Promise<void>;
  listExecutionAttempts(dispatchId: string): Promise<TeamChatExecutionAttempt[]>;
  insertAttemptEvent(event: TeamChatAttemptEvent): Promise<void>;
  listTurnEvents(
    roomId: string,
    dispatchId: string,
    limit: number,
  ): Promise<TeamChatAttemptEvent[]>;
  listRoomTurns(roomId: string, limit: number): Promise<TeamChatRoomTurn[]>;
  getRoomTurn(roomId: string, dispatchId: string): Promise<TeamChatRoomTurn | undefined>;
  listThreadMessages(
    roomId: string,
    rootMessageId: string,
    limit: number,
  ): Promise<TeamChatMessage[]>;
  finishTask(
    roomId: string,
    memberId: string,
    taskId: string,
    finish: TeamChatTaskFinish,
  ): Promise<TeamChatTask | undefined>;
  updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void>;
  markRunningDispatchesInterrupted(updatedAt: string): Promise<void>;
  listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]>;
  upsertAgentSession(session: TeamChatAgentSession): Promise<void>;
  deleteAgentSession(roomId: string, agentId: string): Promise<void>;
  listWorkspaceReservations(
    roomId: string,
    relativePaths?: string[],
  ): Promise<TeamChatWorkspaceReservation[]>;
  reserveWorkspacePaths(
    reservations: TeamChatWorkspaceReservation[],
  ): Promise<TeamChatWorkspaceReservation[]>;
  releaseWorkspacePaths(roomId: string, memberId: string, relativePaths: string[]): Promise<number>;
}
