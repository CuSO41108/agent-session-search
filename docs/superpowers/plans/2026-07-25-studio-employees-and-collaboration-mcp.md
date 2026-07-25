# Studio Employees and Collaboration MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Team Chat rooms into studios containing independent employee instances with isolated Runtime sessions, a shared project directory, explicit message delivery, and visible employee-to-employee communication through one managed AgentRecall MCP endpoint.

**Architecture:** Keep the existing PostgreSQL-backed TeamChatService and Runtime execution chain, but separate studio member identity from Configured Agent identity and serialize work per member instead of per room. Generalize the existing Workflow MCP launch configuration into one built-in AgentRecall MCP entry whose single bridge port routes Workflow, Studio, and Workspace capabilities according to a short-lived execution token.

**Tech Stack:** TypeScript, Electron IPC/preload, React, PostgreSQL/PGlite, Vitest, Codex app-server Runtime, Claude Agent SDK, stdio MCP proxy over a localhost HTTP bridge.

---

## File map

- `src/shared/team-chat.ts`: public studio member, message recipient, dispatch, request, and event contracts.
- `src/core/postgres/schema.ts`: additive employee identity, directed-message, sequence, and workspace-reservation migration.
- `src/main/team-chat/team-chat-store.ts`: persistence boundary for employee sessions, directed context, causal execution counts, message search, and path reservations.
- `src/main/team-chat/postgres-team-chat-store.ts`: PostgreSQL implementation of the Team Chat store boundary.
- `src/main/team-chat/team-chat-routing.ts`: deterministic target validation and compact delivery Prompt.
- `src/main/team-chat/team-chat-service.ts`: employee lifecycle, per-member queues, Session isolation, scoped MCP authorization, and tool behavior.
- `src/automation/engine/shared/types.ts`: internal AgentRecall MCP execution context carried to Runtime drivers.
- `src/automation/engine/main/platform/configured-agent-execution-service.ts`: accepts and forwards studio MCP context and studio developer instructions.
- `src/automation/engine/main/hub/workflow/agent-hub-workflow-agent.ts`: preserves AgentRecall MCP context when resolving a Workflow Runtime request.
- `src/automation/engine/main/agents/runtime/runtime-driver.ts`: exposes AgentRecall MCP context to Workflow drivers.
- `src/automation/engine/main/hub/runtime/executor/workflow/workflow-mcp-launch.ts`: generalized single built-in MCP launch configuration.
- `src/automation/engine/main/hub/runtime/executor/{codex,claude}/*`: injects exactly one built-in MCP server into supported studio executions.
- `src/automation/engine/main/bridges/mcp-bridge.ts`: routes Studio and Workspace requests on the existing localhost bridge.
- `src/automation/engine/mcp/server.ts`: advertises scoped studio tools and forwards the execution token.
- `src/main/services/automation-service.ts`: wires TeamChatService into the existing bridge and keeps one bridge lifecycle.
- `src/main/ipc/team-chat.ts`, `src/preload/team-chat.ts`: validate and expose employee-based room and message operations.
- `src/renderer/src/features/team-chat/team-chat-page.tsx`: employee creation, recipient selection, independent running states, and visible directed messages.
- `src/renderer/src/styles/team-chat.css`: compact employee and recipient controls.
- Existing adjacent `*.test.ts` files: observable behavior tests.
- `.release-notes/feat-workflow-run-center-v1.md`: update the branch's existing single user-facing release note.

### Task 1: Add employee-instance and directed-message contracts

**Files:**
- Modify: `src/shared/team-chat.ts`
- Modify: `src/core/postgres/schema.ts`
- Test: `src/core/postgres/schema.test.ts`

- [ ] **Step 1: Write the failing schema and contract expectations**

Add schema assertions for `configured_agent_id`, `recipient_member_id`, `sequence`, and `chat_workspace_reservations`:

```ts
expect(sql).toContain("configured_agent_id");
expect(sql).toContain("recipient_member_id");
expect(sql).toContain("chat_workspace_reservations");
```

Update typed fixtures so `TeamChatRoomAgent` has a stable member ID plus a Configured Agent reference:

```ts
const member: TeamChatRoomAgent = {
  roomId: "room-1",
  agentId: "member-1",
  configuredAgentId: "codex-profile",
  displayName: "Codex2",
  runtimeId: "codex",
  channelId: "codex-default",
  modelId: "default",
  enabled: true,
  position: 0,
  joinedAt: now,
  continuationAvailable: true,
  hasActiveConversation: false,
};
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- src/core/postgres/schema.test.ts`

Expected: FAIL because the migration does not yet contain employee references, recipients, or reservations.

- [ ] **Step 3: Add public contracts and an additive migration**

Use `agentId` as the existing wire-compatible member-instance ID and add `configuredAgentId`:

```ts
export interface TeamChatRoomMemberInput {
  memberId?: string;
  configuredAgentId: string;
  displayName: string;
}

export interface TeamChatRoomAgent {
  roomId: string;
  agentId: string;
  configuredAgentId: string;
  displayName: string;
  runtimeId: string;
  channelId: string;
  modelId: string;
  enabled: boolean;
  position: number;
  joinedAt: string;
  continuationAvailable: boolean;
  hasActiveConversation: boolean;
  conversationUpdatedAt?: string;
}

export interface SendTeamChatMessageRequest {
  roomId: string;
  content: string;
  targetMemberIds: string[];
  replyToMessageId?: string;
}
```

Add `recipientMemberId?`, `sequence`, and `deliveryType: "reply" | "message" | "post"` to `TeamChatMessage`. Change room create/update inputs from unique Configured Agent IDs to member inputs so duplicate Configured Agent references are legal.

Add one migration that:

```sql
ALTER TABLE agent_recall.chat_room_agents
  ADD COLUMN configured_agent_id text;
UPDATE agent_recall.chat_room_agents
  SET configured_agent_id = agent_id
  WHERE configured_agent_id IS NULL;
ALTER TABLE agent_recall.chat_room_agents
  ALTER COLUMN configured_agent_id SET NOT NULL;

ALTER TABLE agent_recall.chat_messages
  ADD COLUMN recipient_member_id text,
  ADD COLUMN sequence bigint;
```

Backfill message sequence using `row_number() over (partition by room_id order by created_at, id)`, then make it non-null and add a unique `(room_id, sequence)` index. Create `chat_workspace_reservations(room_id, member_id, relative_path, reason, expires_at, created_at, updated_at)` with `(room_id, relative_path)` primary key.

- [ ] **Step 4: Run the focused test**

Run: `npm test -- src/core/postgres/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/team-chat.ts src/core/postgres/schema.ts src/core/postgres/schema.test.ts
git commit -m "feat(chat): add studio employee contracts"
```

### Task 2: Persist duplicate employees and directed studio data

**Files:**
- Modify: `src/main/team-chat/team-chat-store.ts`
- Modify: `src/main/team-chat/postgres-team-chat-store.ts`
- Test: `src/main/team-chat/postgres-team-chat-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Create a room with two members that both reference `configuredAgentId: "codex-profile"` but have `agentId: "member-1"` and `"member-2"`. Assert both survive close/reopen, keep separate sessions, and directed messages retain recipient and sequence:

```ts
expect(reopened.agents.map((member) => member.configuredAgentId)).toEqual([
  "codex-profile",
  "codex-profile",
]);
expect(await store.listAgentSessions(room.id)).toHaveLength(2);
expect(page.messages[0]).toMatchObject({
  recipientMemberId: "member-2",
  sequence: 1,
});
```

Add tests for bounded `searchMessages`, `countRootDispatches`, and reservation conflict/upsert/release behavior.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- src/main/team-chat/postgres-team-chat-store.test.ts`

Expected: FAIL on missing columns and store methods.

- [ ] **Step 3: Extend the store boundary**

Add these methods:

```ts
listDirectedContext(roomId: string, memberId: string, afterMessageId: string | undefined, limit: number): Promise<TeamChatContextPage>;
getMessages(roomId: string, messageIds: string[]): Promise<TeamChatMessage[]>;
readMessageRange(roomId: string, input: { after?: number; before?: number; limit: number }): Promise<TeamChatMessage[]>;
searchMessages(roomId: string, query: string, limit: number): Promise<TeamChatMessage[]>;
countRootDispatches(rootMessageId: string): Promise<number>;
listWorkspaceReservations(roomId: string, paths?: string[]): Promise<TeamChatWorkspaceReservation[]>;
reserveWorkspacePaths(reservations: TeamChatWorkspaceReservation[]): Promise<TeamChatWorkspaceReservation[]>;
releaseWorkspacePaths(roomId: string, memberId: string, paths: string[]): Promise<number>;
```

Map `chat_room_agents.agent_id` to member ID and `configured_agent_id` to the referenced profile. Assign message sequences transactionally with:

```sql
SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
FROM agent_recall.chat_messages
WHERE room_id = $1
FOR UPDATE
```

Filter directed context to messages sent by the employee, addressed to the employee, system messages, and posts. Order all range/search results deterministically and enforce caller-provided limits.

- [ ] **Step 4: Run the focused test**

Run: `npm test -- src/main/team-chat/postgres-team-chat-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/team-chat/team-chat-store.ts src/main/team-chat/postgres-team-chat-store.ts src/main/team-chat/postgres-team-chat-store.test.ts
git commit -m "feat(chat): persist directed employee messages"
```

### Task 3: Replace broadcast routing with explicit employee delivery

**Files:**
- Modify: `src/main/team-chat/team-chat-routing.ts`
- Test: `src/main/team-chat/team-chat-routing.test.ts`

- [ ] **Step 1: Write failing route and Prompt tests**

Assert no target does not broadcast, duplicate Runtime profiles remain distinct, and Prompt contains the original body once:

```ts
expect(resolveTeamChatTargets(["member-2"], members)).toEqual(["member-2"]);
expect(resolveTeamChatTargets([], members)).toEqual([]);
expect(prompt.match(/check auth/g)).toHaveLength(1);
expect(prompt).toContain("[AgentRecall Studio Delivery]");
expect(prompt).toContain("To: Codex2 (member-2)");
expect(prompt).toContain("Other unread studio messages: 3");
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- src/main/team-chat/team-chat-routing.test.ts`

Expected: FAIL because current routing parses text mentions and broadcasts human messages.

- [ ] **Step 3: Implement deterministic targeting and compact delivery**

Replace mention parsing with member-ID validation:

```ts
export function resolveTeamChatTargets(
  targetMemberIds: string[],
  members: TeamChatRoomAgent[],
): string[] {
  const enabled = new Set(members.filter((member) => member.enabled).map((member) => member.agentId));
  return [...new Set(targetMemberIds)].filter((memberId) => enabled.has(memberId));
}
```

Change `buildTeamChatPrompt` to accept `explicitContext`, `unreadCount`, and `unreadSequenceRange`. Put stable collaboration rules in a separate exported `buildStudioDeveloperInstructions(room, target)` string and keep the message body as one verbatim block.

- [ ] **Step 4: Run the focused test**

Run: `npm test -- src/main/team-chat/team-chat-routing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/team-chat/team-chat-routing.ts src/main/team-chat/team-chat-routing.test.ts
git commit -m "feat(chat): deliver messages to explicit employees"
```

### Task 4: Isolate employee sessions and serialize only each employee queue

**Files:**
- Modify: `src/main/team-chat/team-chat-service.ts`
- Test: `src/main/team-chat/team-chat-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover duplicate employees, fresh/resume isolation, same-member serialization, cross-member parallelism, and no-target rejection:

```ts
expect(executions[0].runtimeConversation).toBeUndefined();
expect(executions[1].runtimeConversation).toBeUndefined();
expect(executions[2].runtimeConversation).toEqual(memberOneConversation);
expect(executions[3].runtimeConversation).toEqual(memberTwoConversation);
expect(maxConcurrentByMember.get("member-1")).toBe(1);
expect(globalMaxConcurrent).toBe(2);
await expect(service.sendMessage({ roomId, content: "hello", targetMemberIds: [] }))
  .rejects.toThrow(/select.*employee/i);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- src/main/team-chat/team-chat-service.test.ts`

Expected: FAIL because room members are Configured Agent IDs and one root turn controls all execution.

- [ ] **Step 3: Create employee instances from room requests**

Resolve each member input independently:

```ts
function roomMemberSnapshot(
  roomId: string,
  input: TeamChatRoomMemberInput,
  configured: ConfiguredAgent,
  position: number,
  joinedAt: string,
): TeamChatRoomAgent {
  return {
    roomId,
    agentId: input.memberId ?? randomUUID(),
    configuredAgentId: configured.id,
    displayName: input.displayName.trim(),
    // runtime snapshot fields
  };
}
```

Validate case-insensitive display-name uniqueness per room but do not deduplicate `configuredAgentId`.

- [ ] **Step 4: Replace room turn state with per-member queues**

Use one Promise tail per `(roomId, memberId)`:

```ts
private readonly memberQueueTails = new Map<string, Promise<void>>();

private enqueueMember(key: string, work: () => Promise<void>): void {
  const prior = this.memberQueueTails.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(work);
  this.memberQueueTails.set(key, next);
  void next.finally(() => {
    if (this.memberQueueTails.get(key) === next) this.memberQueueTails.delete(key);
  });
}
```

Resolve Runtime configuration with `target.configuredAgentId`, but store/load `RuntimeConversation` with `target.agentId`. Use `listDirectedContext` for fresh/resume input. Create one dispatch per target and never parse agent output for the next target.

- [ ] **Step 5: Run the focused service test**

Run: `npm test -- src/main/team-chat/team-chat-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/team-chat/team-chat-service.ts src/main/team-chat/team-chat-service.test.ts
git commit -m "feat(chat): run independent employee sessions"
```

### Task 5: Generalize built-in MCP injection to one AgentRecall entry

**Files:**
- Modify: `src/automation/engine/shared/types.ts`
- Modify: `src/automation/engine/main/platform/configured-agent-execution-service.ts`
- Modify: `src/automation/engine/main/hub/workflow/agent-hub-workflow-agent.ts`
- Modify: `src/automation/engine/main/agents/runtime/runtime-driver.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/workflow/workflow-mcp-launch.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/codex/codex-workflow-mcp.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/claude/claude-workflow-mcp.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/codex/codex-workflow.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/claude/claude-workflow.ts`
- Test: `src/automation/engine/main/platform/configured-agent-execution-service.test.ts`
- Test: `src/automation/engine/main/hub/runtime/executor/codex/codex-workflow-mcp.test.ts`
- Test: `src/automation/engine/main/hub/agent-hub.test.ts`

- [ ] **Step 1: Write failing single-entry MCP tests**

Pass both Workflow and Studio context and assert Codex receives one `mcp_servers.agent_recall.command`, while its environment contains both scopes:

```ts
expect(argv.filter((value) => value.includes("mcp_servers.agent_recall.command"))).toHaveLength(1);
expect(argv.join("\n")).toContain("AGENT_RECALL_WORKFLOW_ID");
expect(argv.join("\n")).toContain("AGENT_RECALL_STUDIO_TOKEN");
```

Assert `ConfiguredAgentExecutionService.runConversation` forwards the scope and studio developer instructions.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/automation/engine/main/platform/configured-agent-execution-service.test.ts src/automation/engine/main/hub/runtime/executor/codex/codex-workflow-mcp.test.ts`

Expected: FAIL because Runtime requests cannot carry a studio token.

- [ ] **Step 3: Add the internal execution context**

```ts
export interface AgentRecallMcpContext {
  studioToken?: string;
}

export interface RuntimeRequest {
  runtimeId: AgentId;
  executionMode: RuntimeExecutionMode;
  continuationPolicy: RuntimeContinuationPolicy;
  runtimeConfig: RuntimeConfig;
  runtimeConversation?: RuntimeConversation;
  planningWorkflowId?: string;
  workflowRunId?: string;
  workflowNodeId?: string;
  agentRecallMcp?: AgentRecallMcpContext;
}
```

Extend `runConversation` input with `developerInstructions?: string` and `agentRecallMcp?: AgentRecallMcpContext`. Preserve both through `buildWorkflowAgentExecution` into `RuntimeWorkflowRequestContext`.

- [ ] **Step 4: Generate one managed MCP launch configuration**

Generalize `workflowMcpLaunchConfig` so one config may include Workflow and Studio environment:

```ts
export function agentRecallMcpLaunchConfig(
  discoveryPath: string | undefined,
  context: {
    workflowId?: string;
    runId?: string;
    nodeId?: string;
    studioToken?: string;
  },
): WorkflowMcpLaunchConfig | undefined {
  if (!discoveryPath || (!context.workflowId && !context.studioToken)) return undefined;
  return {
    command: process.execPath,
    args: [compiledServer],
    env: {
      AGENT_RECALL_MCP_BRIDGE: discoveryPath,
      ...(context.workflowId ? { AGENT_RECALL_WORKFLOW_ID: context.workflowId } : {}),
      ...(context.studioToken ? { AGENT_RECALL_STUDIO_TOKEN: context.studioToken } : {}),
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}
```

Keep `workflowMcpLaunchConfig` as a compatibility call into this function while Runtime drivers switch to the generalized configuration. Codex builds one TOML server block; Claude builds one `agent_recall` SDK server object.

- [ ] **Step 5: Run focused Runtime tests**

Run: `npm test -- src/automation/engine/main/platform/configured-agent-execution-service.test.ts src/automation/engine/main/hub/runtime/executor/codex/codex-workflow-mcp.test.ts src/automation/engine/main/hub/agent-hub.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/automation/engine/shared/types.ts src/automation/engine/main/platform/configured-agent-execution-service.ts src/automation/engine/main/hub/workflow/agent-hub-workflow-agent.ts src/automation/engine/main/agents/runtime/runtime-driver.ts src/automation/engine/main/hub/runtime/executor/workflow/workflow-mcp-launch.ts src/automation/engine/main/hub/runtime/executor/codex src/automation/engine/main/hub/runtime/executor/claude src/automation/engine/main/hub/agent-hub.test.ts
git commit -m "feat(mcp): unify managed runtime capabilities"
```

### Task 6: Expose scoped Studio and Workspace tools on the existing bridge

**Files:**
- Modify: `src/automation/engine/mcp/server.ts`
- Modify: `src/automation/engine/main/bridges/mcp-bridge.ts`
- Modify: `src/main/team-chat/team-chat-service.ts`
- Modify: `src/main/services/automation-service.ts`
- Test: `src/automation/engine/main/bridges/mcp-bridge.test.ts`
- Test: `src/main/team-chat/team-chat-service.test.ts`
- Test: `src/main/services/automation-service.test.ts`

- [ ] **Step 1: Write failing bridge and authorization tests**

Start one bridge, call a Workflow route and a Studio route on the same `port`, then verify:

```ts
expect(workflowResponse.ok).toBe(true);
expect(studioResponse).toMatchObject({ ok: true });
expect(bridge.port).toBe(theOnlyObservedPort);
```

Test missing, expired, cross-room, and revoked studio tokens return 401/`ok: false` without invoking a store write.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/automation/engine/main/bridges/mcp-bridge.test.ts src/main/services/automation-service.test.ts`

Expected: FAIL because the bridge has no Team Chat route dependency.

- [ ] **Step 3: Advertise tools only inside studio executions**

When `AGENT_RECALL_STUDIO_TOKEN` exists, append definitions:

```ts
studio_list_members
studio_send_message
studio_post
studio_read_messages
studio_read_range
studio_search
workspace_reserve
workspace_release
workspace_status
```

Map each name to `/mcp/studio/*` or `/mcp/workspace/*`. Forward `x-agent-recall-studio-token` from the stdio process; never place room or sender identity in the JSON body.

- [ ] **Step 4: Add short-lived scope handling to TeamChatService**

Create and revoke opaque tokens around each employee execution:

```ts
const scope = this.createStudioScope({
  roomId: input.room.id,
  memberId: target.agentId,
  dispatchId,
  rootMessageId: input.rootMessage.id,
});
try {
  return await executeAgent({
    // existing input
    agentRecallMcp: { studioToken: scope.token },
    developerInstructions: buildStudioDeveloperInstructions(input.room, target),
  });
} finally {
  this.revokeStudioScope(scope.token);
}
```

Expose `handleMcpRequest(token, route, body)` on TeamChatService. It validates scope, dispatch status, room membership, bounds, and path normalization before delegating to the store.

- [ ] **Step 5: Route Studio and Workspace paths in the existing bridge**

Extend bridge options with:

```ts
studio?: {
  handleMcpRequest(token: string | undefined, route: string, body: unknown): Promise<unknown>;
};
```

Routes beginning `/mcp/studio/` or `/mcp/workspace/` call that dependency. `NativeAutomationService` passes its one `teamChat` instance into `startMcpBridge`; it does not start another server.

- [ ] **Step 6: Implement visible asynchronous employee messaging**

`studio_send_message` inserts an agent message with `recipientMemberId`, checks `countRootDispatches < 8`, and enqueues the recipient without awaiting it. `studio_post` inserts a visible `deliveryType: "post"` message and does not enqueue. Read/search tools return public message fields only.

Normalize workspace paths using both slash styles:

```ts
const normalized = path.normalize(candidate);
if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
  throw new Error("Workspace paths must stay inside the studio directory.");
}
```

- [ ] **Step 7: Run focused MCP and service tests**

Run: `npm test -- src/automation/engine/main/bridges/mcp-bridge.test.ts src/main/team-chat/team-chat-service.test.ts src/main/services/automation-service.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/automation/engine/mcp/server.ts src/automation/engine/main/bridges/mcp-bridge.ts src/main/team-chat/team-chat-service.ts src/main/services/automation-service.ts src/automation/engine/main/bridges/mcp-bridge.test.ts src/main/team-chat/team-chat-service.test.ts src/main/services/automation-service.test.ts
git commit -m "feat(chat): add scoped studio collaboration tools"
```

### Task 7: Update IPC and preload for employees and explicit recipients

**Files:**
- Modify: `src/main/ipc/team-chat.ts`
- Modify: `src/preload/team-chat.ts`
- Test: `src/main/team-chat-ipc.test.ts`
- Test: `src/preload/team-chat.test.ts`

- [ ] **Step 1: Write failing validation tests**

Verify duplicate Configured Agent references are accepted, duplicate member IDs/display names are rejected, target IDs are bounded, and hidden scope fields are rejected:

```ts
await expect(invoke(roomsCreate, {
  name: "Studio",
  workDir: "",
  members: [
    { configuredAgentId: "codex", displayName: "Codex" },
    { configuredAgentId: "codex", displayName: "Codex2" },
  ],
})).resolves.toBeDefined();

await expect(invoke(messagesSend, {
  roomId: "room-1",
  content: "hello",
  targetMemberIds: ["member-2"],
  studioToken: "forbidden",
})).rejects.toThrow();
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/main/team-chat-ipc.test.ts src/preload/team-chat.test.ts`

Expected: FAIL on the old `agentIds` and message schemas.

- [ ] **Step 3: Implement strict employee schemas**

Use:

```ts
const memberSchema = z.object({
  memberId: idSchema.optional(),
  configuredAgentId: idSchema,
  displayName: z.string().trim().min(1).max(120),
}).strict();

const messageSendSchema = z.object({
  roomId: idSchema,
  content: z.string().trim().min(1).max(100_000),
  targetMemberIds: z.array(idSchema).min(1).max(24),
  replyToMessageId: idSchema.optional(),
}).strict();
```

Keep native Session IDs, RuntimeConversation, bridge tokens, and filesystem internals outside Renderer contracts.

- [ ] **Step 4: Run focused IPC tests**

Run: `npm test -- src/main/team-chat-ipc.test.ts src/preload/team-chat.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/team-chat.ts src/preload/team-chat.ts src/main/team-chat-ipc.test.ts src/preload/team-chat.test.ts
git commit -m "feat(chat): expose studio employee messaging"
```

### Task 8: Build the employee and recipient UI

**Files:**
- Modify: `src/renderer/src/features/team-chat/team-chat-page.tsx`
- Modify: `src/renderer/src/styles/team-chat.css`
- Modify: `src/renderer/src/team-chat-page.test.ts`

- [ ] **Step 1: Write failing UI contract tests**

Render exported recipient and employee controls and assert:

```ts
expect(html).toContain("发送给");
expect(html).toContain("Codex2");
expect(html).toContain("添加员工");
expect(html).not.toContain("直接发消息给所有成员");
```

Add a reducer/helper test proving dispatch events track running state by `agentId` and do not create a room-global input lock.

- [ ] **Step 2: Run the focused UI test and verify failure**

Run: `npm test -- src/renderer/src/team-chat-page.test.ts`

Expected: FAIL because the current composer is room-turn based.

- [ ] **Step 3: Add employee creation and current recipients**

Change the room form to maintain:

```ts
type MemberDraft = {
  key: string;
  configuredAgentId: string;
  displayName: string;
};
```

Allow the same Configured Agent to be selected more than once. Generate the next available display name by suffixing `2`, `3`, and so on. Persist `selectedMemberIdsByRoom` in component state, defaulting to the first enabled employee.

- [ ] **Step 4: Remove the global turn lock**

Replace `activeRootMessageId` gating with:

```ts
const runningMemberIds = useMemo(
  () => new Set(Object.values(streams).map((stream) => stream.agentId)),
  [streams],
);
```

The send button is disabled only for empty content, no recipient, or the brief IPC send operation. Show per-employee queued/running indicators and retain per-dispatch stop controls.

- [ ] **Step 5: Render directed messages**

Human messages show selected recipients; employee communication shows `@Sender → @Recipient`. Keep posts visually passive. Rename user-facing “Agent” copy inside this page to “员工” where it refers to a studio instance, while Runtime configuration pages continue using Agent terminology.

- [ ] **Step 6: Run focused UI tests**

Run: `npm test -- src/renderer/src/team-chat-page.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/features/team-chat/team-chat-page.tsx src/renderer/src/styles/team-chat.css src/renderer/src/team-chat-page.test.ts
git commit -m "feat(chat): add studio employee controls"
```

### Task 9: Release copy and full verification

**Files:**
- Modify: `.release-notes/feat-workflow-run-center-v1.md`

- [ ] **Step 1: Update the branch's one release note**

Keep its existing title and user-visible entries, and add one plain-language feature bullet:

```markdown
- Chat 工作室现在可以基于同一运行配置创建多个独立员工；每名员工会持续复用自己的会话、共享项目目录，并能在用户可见的消息中相互协作。
```

Do not add a second release-note file.

- [ ] **Step 2: Run focused Team Chat and MCP tests**

Run:

```bash
npm test -- \
  src/main/team-chat/team-chat-routing.test.ts \
  src/main/team-chat/team-chat-service.test.ts \
  src/main/team-chat/postgres-team-chat-store.test.ts \
  src/automation/engine/main/bridges/mcp-bridge.test.ts \
  src/main/team-chat-ipc.test.ts \
  src/preload/team-chat.test.ts \
  src/renderer/src/team-chat-page.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type checking and release-note validation**

Run:

```bash
npm run typecheck
npm run release-note:check
```

Expected: both commands exit 0.

- [ ] **Step 4: Run the complete Vitest suite**

Run: `npm test`

Expected: PASS. If unrelated pre-existing failures remain, record the exact tests and prove all changed-area tests pass.

- [ ] **Step 5: Build the application**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 6: Check the final diff without touching unrelated user changes**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: no whitespace errors; unrelated pre-existing modifications remain unstaged and unchanged.

- [ ] **Step 7: Commit the release copy**

```bash
git add .release-notes/feat-workflow-run-center-v1.md
git commit -m "docs(release): describe studio employees"
```
