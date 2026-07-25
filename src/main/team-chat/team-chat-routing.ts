import type { TeamChatMessage, TeamChatRoom, TeamChatRoomAgent } from "../../shared/team-chat";

const MAX_EXPLICIT_CONTEXT_MESSAGES = 20;
const MAX_EXPLICIT_CONTEXT_CHARACTERS = 24_000;

export function resolveTeamChatTargets(
  targetMemberIds: string[],
  members: TeamChatRoomAgent[],
): string[] {
  const enabled = new Set(
    members.filter((member) => member.enabled).map((member) => member.agentId),
  );
  return [...new Set(targetMemberIds)].filter((memberId) => enabled.has(memberId));
}

function contextWithinBudget(messages: TeamChatMessage[]): TeamChatMessage[] {
  const recent = messages.slice(-MAX_EXPLICIT_CONTEXT_MESSAGES);
  const selected: TeamChatMessage[] = [];
  let characters = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const length = message.senderName.length + message.content.length + 32;
    if (selected.length > 0 && characters + length > MAX_EXPLICIT_CONTEXT_CHARACTERS) break;
    selected.push(message);
    characters += length;
  }
  return selected.reverse();
}

function formatContextMessage(message: TeamChatMessage): string {
  const recipient = message.recipientMemberId ? ` -> ${message.recipientMemberId}` : "";
  return `[${message.sequence}] ${message.senderName}${recipient}: ${message.content}`;
}

export function buildStudioDeveloperInstructions(
  room: TeamChatRoom,
  target: TeamChatRoomAgent,
): string {
  const members = room.agents
    .filter((member) => member.enabled)
    .sort((left, right) => left.position - right.position)
    .map((member) => `${member.displayName} (${member.agentId})`)
    .join(", ");
  return [
    "You are one employee instance in an AgentRecall studio. You are not the manager of the other employees.",
    `Studio: ${room.name}.`,
    `Your employee identity: ${target.displayName} (${target.agentId}).`,
    `Studio employees: ${members || "none"}.`,
    `The shared project directory is ${room.workDir || "(not selected)"}.`,
    "Your normal final response is visible to the user but does not activate another employee.",
    "When another employee must act, call studio_send_message with that employee's member ID.",
    "Use studio_post for visible status or shared information that must not activate another employee.",
    "Do not invent another employee's messages, progress, or results.",
  ].join(" ");
}

export function buildTeamChatPrompt(input: {
  room: TeamChatRoom;
  target: TeamChatRoomAgent;
  explicitContext: TeamChatMessage[];
  triggerMessage: TeamChatMessage;
  unreadCount: number;
  unreadSequenceRange?: { from: number; to: number };
  continuing: boolean;
  contextTruncated: boolean;
}): string {
  const context = contextWithinBudget(
    input.explicitContext.filter((message) => message.id !== input.triggerMessage.id),
  );
  const from = input.triggerMessage.senderType === "human"
    ? input.triggerMessage.senderName
    : `${input.triggerMessage.senderName} (${input.triggerMessage.senderAgentId ?? "unknown"})`;
  const replyTo = input.triggerMessage.sourceMessageId
    ? `Reply to: ${input.triggerMessage.sourceMessageId}`
    : undefined;
  const unreadRange = input.unreadSequenceRange
    ? ` (sequence ${input.unreadSequenceRange.from}-${input.unreadSequenceRange.to})`
    : "";
  return [
    "[AgentRecall Studio Delivery]",
    `Studio: ${input.room.name}`,
    `To: ${input.target.displayName} (${input.target.agentId})`,
    `From: ${from}`,
    `Message: ${input.triggerMessage.id}`,
    ...(replyTo ? [replyTo] : []),
    `Root: ${input.triggerMessage.rootMessageId}`,
    `Session: ${input.continuing ? "resumed" : "new"}`,
    "",
    ...(context.length > 0
      ? [
          "Explicit context:",
          ...(input.contextTruncated ? ["Some earlier directed context was omitted."] : []),
          ...context.map(formatContextMessage),
          "",
        ]
      : []),
    input.triggerMessage.content,
    "",
    `Other unread studio messages: ${input.unreadCount}${unreadRange}`,
    "Use studio_read_messages or studio_read_range only when needed.",
  ].join("\n");
}
