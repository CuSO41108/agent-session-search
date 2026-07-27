# Studio Room Runtime Queue Implementation Plan

> Execute task-by-task with `executing-plans` and write each behavior test before production code.

**Goal:** Turn Studio into a room-wide information system where only user mentions wake a Runtime, repeated mentions queue durably, every Turn has a fixed trigger snapshot, and same-room Runtimes can inspect sanitized execution history through MCP.

**Architecture:** Keep `TeamChatRoomAgent` as the room Runtime and `chat_dispatches` as the persisted logical Turn. Add Mention and Task records above dispatch, Attempt and sanitized event records below it, and a per-room-Runtime context cursor beside the existing native `RuntimeConversation`. A dispatch snapshot is the triggering message sequence, never the latest sequence when execution eventually begins.

## Task 1: Persist activation lineage and fixed snapshots

**Files:**

- `src/core/postgres/schema.ts`
- `src/shared/team-chat.ts`
- `src/main/team-chat/team-chat-store.ts`
- `src/main/team-chat/postgres-team-chat-store.ts`
- `src/main/team-chat/postgres-team-chat-store.test.ts`

1. Write a failing PGlite test that atomically inserts one human message plus Mention, Task, and queued dispatch. Assert the dispatch snapshot equals the inserted trigger sequence.
2. In the same test, persist two Attempts and sanitized events; assert ordering and room scoping.
3. Extend the Session test with `roomContextSequence` and message provenance with `basedOnSequence`.
4. Run `npx vitest run src/main/team-chat/postgres-team-chat-store.test.ts` and confirm the missing contracts cause the failure.
5. Add migration 10:
   - `chat_agent_sessions.room_context_sequence`
   - `chat_messages.based_on_sequence`
   - `chat_message_mentions`
   - `chat_tasks`
   - dispatch `mention_id`, `task_id`, and `room_snapshot_sequence`
   - `chat_dispatch_attempts`
   - `chat_attempt_events`
6. Add atomic `insertMessageWithActivations`, room-context range queries, queued-dispatch listing, Task completion, Attempt/event lifecycle, derived Inbox, and Turn query store contracts.
7. Keep `initialize()` from discarding queued work: mark only stale `running` dispatches/Attempts interrupted and leave `queued` dispatches recoverable.
8. Run the focused store test until green, then run `src/core/postgres/schema.test.ts`.

## Task 2: Make user mentions a durable FIFO queue

**Files:**

- `src/main/ipc/team-chat.ts`
- `src/main/team-chat-ipc.test.ts`
- `src/main/team-chat/team-chat-service.ts`
- `src/main/team-chat/team-chat-service.test.ts`

1. Write failing tests proving:
   - an empty target list saves a public message and executes nobody;
   - one mention creates persisted activation records before execution starts;
   - two rapid mentions of the same member execute in FIFO order;
   - the first Turn snapshot is its trigger sequence and cannot include the second trigger;
   - different members may still execute concurrently;
   - connecting drains persisted queued dispatches but does not replay interrupted work.
2. Run `npx vitest run src/main/team-chat-ipc.test.ts src/main/team-chat/team-chat-service.test.ts` and confirm expected failures.
3. Allow zero to eight unique structured targets and return rejected stale target IDs.
4. Insert the public message and all valid activations in one transaction. Do not set `recipientMemberId` on new public human messages.
5. Queue the already-persisted dispatch. Serialize by `(roomId, memberId)` and use the dispatch trigger sequence as the immutable context boundary.
6. On connect, reconstruct and enqueue persisted `queued` dispatches in sequence order.
7. Keep in-memory promise tails only as the live mutual-exclusion mechanism; persisted dispatch state remains the source of recovery.
8. Run the focused tests until green.

## Task 3: Deliver bounded room deltas and trace native Turns

**Files:**

- `src/main/team-chat/team-chat-routing.ts`
- `src/main/team-chat/team-chat-routing.test.ts`
- `src/automation/engine/shared/types.ts`
- `src/automation/engine/main/hub/runtime/executor/codex/codex-workflow.ts`
- `src/automation/engine/main/hub/runtime/executor/claude/claude-workflow.ts`
- `src/automation/engine/main/platform/configured-agent-execution-service.ts`
- corresponding tests
- `src/main/team-chat/team-chat-service.ts`
- `src/main/team-chat/team-chat-service.test.ts`

1. Write failing routing tests for `(roomContextSequence, dispatch.roomSnapshotSequence]`, trigger deduplication, omitted-range metadata, and the no-agent-wakeup developer rule.
2. Write failing Runtime tests that Codex returns the existing `turn/start` ID, Claude returns its native Session reference, and configured-Agent execution preserves the reference.
3. Write failing service tests for one successful Attempt, safe fresh retry with two Attempts, failed delta without retry, reply provenance, and cursor advance only on success.
4. Write a failing service test that tool calls/results become sanitized, bounded Attempt events.
5. Run all focused tests and confirm feature-missing failures.
6. Replace directed context with bounded room sequence queries through the immutable dispatch snapshot.
7. Forward tool call/result events in Codex and Claude workflows; preserve native execution references in `WorkflowAgentResponse`.
8. Record each Attempt and event, return only one final reply, save `basedOnSequence`, and advance the cursor to the trigger snapshot after success.
9. Run all focused tests until green.

## Task 4: Add Task completion and same-room MCP inspection

**Files:**

- `src/automation/engine/shared/workflow-mcp-policy.ts`
- `src/automation/engine/mcp/server.ts`
- `src/automation/engine/mcp/server.test.ts`
- `src/main/team-chat/team-chat-service.ts`
- `src/main/team-chat/team-chat-service.test.ts`

1. Write failing definition and service-scope tests for:
   - `studio_get_context`
   - `studio_get_room_state`
   - `studio_inbox_list`
   - `studio_task_finish`
   - `studio_turn_list`
   - `studio_turn_get`
   - `studio_turn_events`
   - `studio_read_thread`
2. Assert `studio_send_message` is absent and all cross-room IDs return no data or an error.
3. Assert a Runtime cannot finish another member's Task, and repeated identical finish calls are idempotent.
4. Assert Turn inspection exposes Studio IDs, Task/dispatch/Attempt state and sanitized events, but not `runtimeSessionRef` or native Session payload.
5. Run the focused tests and confirm failures.
6. Add MCP definitions, routes, allow-list entries, and scoped service handlers.
7. Remove Runtime-to-Runtime activation and its developer instruction.
8. Run MCP bridge, server, routing, and Team Chat service tests until green.

## Task 5: Remove accidental default wakeups in the UI

**Files:**

- `src/renderer/src/features/team-chat/team-chat-page.tsx`
- `src/renderer/src/team-chat-page.test.ts`
- `src/preload/team-chat.test.ts`

1. Write a failing renderer test showing non-empty content can send with no selected target.
2. Run the renderer test and confirm the current disabled send behavior fails it.
3. Retain only still-valid selections; do not default to the first member.
4. Remove the no-target error and disable Send only for empty content or an active send.
5. Explain in the placeholder that `@name` wakes a Runtime.
6. Update preload fixtures for `rejectedTargetMemberIds`.
7. Run renderer, IPC, and preload tests until green.

## Task 6: Release note and full verification

**Files:**

- `.release-notes/studio-room-runtime-context.md`

1. Add exactly one Bug 修复 note describing shared room context, explicit wakeups, durable per-employee ordering, and inspectable execution history in user language.
2. Read and follow `verification-before-completion`.
3. Run separately:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `npm run release-note:check`
   - `git diff --check`
4. Inspect `git status --short` and confirm only intended files changed.
5. Read and follow `finishing-a-development-branch` before handing off.
