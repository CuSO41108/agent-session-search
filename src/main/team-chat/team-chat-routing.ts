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
    "Every public message in this studio is readable by every studio Runtime.",
    "Your normal final response is visible to the user but does not activate another employee.",
    "You cannot activate another studio Runtime. Ask the user to mention that Runtime when it must act.",
    "Use studio_post for visible status or shared information that must not activate another employee.",
    "Before your final response, call studio_task_finish with completed, blocked, or waiting_input and a truthful summary. A normal Runtime response does not finish the Task.",
    "Do not invent another employee's messages, progress, or results.",
  ].join(" ");
}

export function buildTeamChatPrompt(input: {
  room: TeamChatRoom;
  target: TeamChatRoomAgent;
  roomUpdates: TeamChatMessage[];
  triggerMessage: TeamChatMessage;
  previousContextSequence: number;
  snapshotSequence: number;
  continuing: boolean;
  contextTruncated: boolean;
  omittedSequenceRange?: { from: number; to: number };
}): string {
  const context = contextWithinBudget(
    input.roomUpdates.filter((message) => message.id !== input.triggerMessage.id),
  );
  return [
    "[AgentRecall Studio Delivery]",
    `Studio: ${input.room.name}`,
    `Runtime: ${input.target.displayName} (${input.target.agentId})`,
    `Session: ${input.continuing ? "resumed" : "new"}`,
    `Room snapshot: sequence ${input.snapshotSequence}`,
    `Previous snapshot: sequence ${input.previousContextSequence}`,
    "",
    ...(context.length > 0
      ? [
          "Room updates:",
          ...context.map(formatContextMessage),
          "",
        ]
      : []),
    ...(input.contextTruncated && input.omittedSequenceRange
      ? [
          `Earlier room updates omitted: sequence ${input.omittedSequenceRange.from}-${input.omittedSequenceRange.to}`,
          "",
        ]
      : []),
    "Trigger:",
    formatContextMessage(input.triggerMessage),
    "",
    "Treat only Trigger as the task for this Turn. Room updates are background information.",
    "Older room history remains queryable through Studio MCP.",
  ].join("\n");
}
