import { createHash, randomUUID } from "node:crypto";

import {
  defaultOpenVikingMemoryControl,
  inferOpenVikingMemoryType,
  type OpenVikingApplyCommitInput,
  type OpenVikingCommitRun,
  type OpenVikingControlDiagnostics,
  type OpenVikingLockedMemoryConflict,
  type OpenVikingMemoryAuthority,
  type OpenVikingMemoryControl,
  type OpenVikingMemoryEvidence,
  type OpenVikingMemoryEvidenceStatus,
  type OpenVikingMemoryFeedback,
  type OpenVikingMemoryFeedbackKind,
  type OpenVikingMemoryLifecycle,
  type OpenVikingOperationEvent,
  type OpenVikingRecallCandidateTrace,
  type OpenVikingRecallTrace,
} from "../openviking-memory-control";
import type { OpenVikingWorkspace } from "../openviking-memory";
import type { PostgresDatabase, PostgresQueryable } from "./database";

export interface AddOpenVikingWorkspaceInput {
  id: string;
  userId: string;
  rootPath: string;
  identity: string;
  displayName: string;
}

export interface SaveOpenVikingMemoryControlInput {
  workspaceId: string;
  uri: string;
  title: string;
  content: string;
  source: "manual" | "user-edit";
  now?: string;
}

export interface RecordOpenVikingMemoryFeedbackInput {
  id: string;
  workspaceId: string;
  memoryUri: string;
  feedback: OpenVikingMemoryFeedbackKind;
  actor: string;
  note?: string;
  createdAt: string;
}

export interface OpenVikingSourceSessionReference {
  sourceSessionId: string;
  sourceAgent: string;
}

interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  root_path: string;
  identity: string;
  display_name: string;
  managed: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MemoryRow extends Record<string, unknown> {
  workspace_id: string;
  uri: string;
  memory_type: string;
  authority: OpenVikingMemoryAuthority;
  lifecycle: OpenVikingMemoryLifecycle;
  locked: boolean;
  evidence_status: OpenVikingMemoryEvidenceStatus;
  source: OpenVikingMemoryControl["source"];
  title: string | null;
  locked_content: string | null;
  evidence_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EvidenceRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  memory_uri: string;
  source_session_id: string | null;
  source_agent: string | null;
  source_turn_ids: unknown;
  archive_uri: string | null;
  memory_diff_uri: string | null;
  remote_task_id: string | null;
  model_snapshot: unknown;
  policy_snapshot: unknown;
  state: OpenVikingMemoryEvidence["state"];
  created_at: Date | string;
  updated_at: Date | string;
}

interface FeedbackRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  memory_uri: string;
  feedback: OpenVikingMemoryFeedbackKind;
  actor: string;
  note: string | null;
  created_at: Date | string;
}

interface CommitRow extends Record<string, unknown> {
  task_id: string;
  workspace_id: string;
  session_id: string;
  agent: string | null;
  trigger: string;
  state: OpenVikingCommitRun["state"];
  source_turn_ids: unknown;
  token_estimate: number | string;
  archive_uri: string | null;
  memory_diff_uri: string | null;
  memories_extracted: unknown;
  token_usage: unknown;
  error: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  updated_at: Date | string;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  phase: string;
  status: OpenVikingOperationEvent["status"];
  session_id: string | null;
  task_id: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  duration_ms: number | string | null;
  details: unknown;
}

interface RecallTraceRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  agent: string;
  query: string;
  contextual_query: string;
  searched_scopes: unknown;
  searched_types: unknown;
  candidates: unknown;
  injected_uris: unknown;
  injected_token_count: number | string;
  duration_ms: number | string;
  degraded_reason: string | null;
  created_at: Date | string;
}

const WORKSPACE_SELECT = `
  select
    id,
    user_id,
    root_path,
    identity,
    display_name,
    managed,
    created_at,
    updated_at
  from agent_recall.openviking_workspaces
`;

const MEMORY_SELECT = `
  select
    memories.workspace_id,
    memories.uri,
    memories.memory_type,
    memories.authority,
    memories.lifecycle,
    memories.locked,
    memories.evidence_status,
    memories.source,
    memories.title,
    memories.locked_content,
    memories.created_at,
    memories.updated_at,
    (
      select count(*)
      from agent_recall.openviking_memory_evidence evidence
      where evidence.workspace_id = memories.workspace_id
        and evidence.memory_uri = memories.uri
        and evidence.state = 'active'
    ) as evidence_count
  from agent_recall.openviking_memories memories
`;

export class PostgresOpenVikingMemoryRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async addWorkspace(input: AddOpenVikingWorkspaceInput): Promise<OpenVikingWorkspace> {
    const now = new Date().toISOString();
    await this.database.query(
      `
        insert into agent_recall.openviking_workspaces (
          id, user_id, root_path, identity, display_name, managed, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, true, $6, $6)
      `,
      [input.id, input.userId, input.rootPath, input.identity, input.displayName, now],
    );
    const created = await this.getWorkspace(input.id);
    if (!created) throw new Error("OpenViking workspace was not created.");
    return created;
  }

  async listWorkspaces(): Promise<OpenVikingWorkspace[]> {
    const result = await this.database.query<WorkspaceRow>(
      `${WORKSPACE_SELECT} order by created_at, id`,
    );
    return result.rows.map(mapWorkspace);
  }

  async getWorkspace(id: string): Promise<OpenVikingWorkspace | null> {
    return this.findWorkspace("id = $1", id);
  }

  async findWorkspaceByRootPath(rootPath: string): Promise<OpenVikingWorkspace | null> {
    return this.findWorkspace("root_path = $1", rootPath);
  }

  async findWorkspaceByIdentity(identity: string): Promise<OpenVikingWorkspace | null> {
    return this.findWorkspace("identity = $1", identity);
  }

  async relinkWorkspace(id: string, rootPath: string, displayName: string): Promise<OpenVikingWorkspace> {
    const result = await this.database.query(
      `
        update agent_recall.openviking_workspaces
        set root_path = $2, display_name = $3, updated_at = $4
        where id = $1
      `,
      [id, rootPath, displayName, new Date().toISOString()],
    );
    if (result.rowCount === 0) throw new Error("OpenViking workspace was not found.");
    const workspace = await this.getWorkspace(id);
    if (!workspace) throw new Error("OpenViking workspace was not found after relinking.");
    return workspace;
  }

  async setWorkspaceManaged(id: string, managed: boolean): Promise<OpenVikingWorkspace> {
    const result = await this.database.query(
      `
        update agent_recall.openviking_workspaces
        set managed = $2, updated_at = $3
        where id = $1
      `,
      [id, managed, new Date().toISOString()],
    );
    if (result.rowCount === 0) throw new Error("OpenViking workspace was not found.");
    const workspace = await this.getWorkspace(id);
    if (!workspace) throw new Error("OpenViking workspace was not found after updating management.");
    return workspace;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const result = await this.database.query(
      "delete from agent_recall.openviking_workspaces where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  async listMemoryControls(workspaceId: string): Promise<OpenVikingMemoryControl[]> {
    const result = await this.database.query<MemoryRow>(
      `${MEMORY_SELECT} where memories.workspace_id = $1 order by memories.updated_at desc, memories.uri`,
      [workspaceId],
    );
    return result.rows.map(mapMemoryControl);
  }

  async getMemoryControl(workspaceId: string, uri: string): Promise<OpenVikingMemoryControl | null> {
    const result = await this.database.query<MemoryRow>(
      `${MEMORY_SELECT} where memories.workspace_id = $1 and memories.uri = $2`,
      [workspaceId, uri],
    );
    return result.rows[0] ? mapMemoryControl(result.rows[0]) : null;
  }

  async saveUserMemory(input: SaveOpenVikingMemoryControlInput): Promise<OpenVikingMemoryControl> {
    const now = input.now ?? new Date().toISOString();
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.openviking_memories (
            workspace_id, uri, memory_type, authority, lifecycle, locked,
            evidence_status, source, title, locked_content, created_at, updated_at
          )
          values ($1, $2, $3, 'user', 'active', true, 'verified', $4, $5, $6, $7, $7)
          on conflict (workspace_id, uri) do update set
            memory_type = excluded.memory_type,
            authority = 'user',
            lifecycle = 'active',
            locked = true,
            evidence_status = 'verified',
            source = excluded.source,
            title = excluded.title,
            locked_content = excluded.locked_content,
            updated_at = excluded.updated_at
        `,
        [
          input.workspaceId,
          input.uri,
          inferOpenVikingMemoryType(input.uri),
          input.source,
          input.title,
          input.content,
          now,
        ],
      );
      await client.query(
        `
          update agent_recall.openviking_memory_evidence
          set state = 'invalidated', updated_at = $3
          where workspace_id = $1 and memory_uri = $2 and state = 'active'
        `,
        [input.workspaceId, input.uri, now],
      );
    });
    const control = await this.getMemoryControl(input.workspaceId, input.uri);
    if (!control) throw new Error("OpenViking memory control record was not saved.");
    return control;
  }

  async markMemoryDeleted(workspaceId: string, uri: string, now = new Date().toISOString()): Promise<void> {
    const fallback = defaultOpenVikingMemoryControl(workspaceId, uri);
    await this.database.query(
      `
        insert into agent_recall.openviking_memories (
          workspace_id, uri, memory_type, authority, lifecycle, locked,
          evidence_status, source, created_at, updated_at
        )
        values ($1, $2, $3, $4, 'deleted', false, 'invalid', $5, $6, $6)
        on conflict (workspace_id, uri) do update set
          lifecycle = 'deleted',
          locked = false,
          evidence_status = 'invalid',
          locked_content = null,
          updated_at = excluded.updated_at
      `,
      [workspaceId, uri, fallback.memoryType, fallback.authority, fallback.source, now],
    );
    await this.database.query(
      `
        update agent_recall.openviking_memory_evidence
        set state = 'invalidated', updated_at = $3
        where workspace_id = $1 and memory_uri = $2 and state = 'active'
      `,
      [workspaceId, uri, now],
    );
  }

  async listMemoryEvidence(workspaceId: string, uri: string): Promise<OpenVikingMemoryEvidence[]> {
    const result = await this.database.query<EvidenceRow>(
      `
        select id, workspace_id, memory_uri, source_session_id, source_agent,
               source_turn_ids, archive_uri, memory_diff_uri, remote_task_id,
               model_snapshot, policy_snapshot, state, created_at, updated_at
        from agent_recall.openviking_memory_evidence
        where workspace_id = $1 and memory_uri = $2
        order by created_at desc, id desc
      `,
      [workspaceId, uri],
    );
    return result.rows.map(mapEvidence);
  }

  async listMemoryFeedback(workspaceId: string, uri: string): Promise<OpenVikingMemoryFeedback[]> {
    const result = await this.database.query<FeedbackRow>(
      `
        select id, workspace_id, memory_uri, feedback, actor, note, created_at
        from agent_recall.openviking_memory_feedback
        where workspace_id = $1 and memory_uri = $2
        order by created_at desc, id desc
      `,
      [workspaceId, uri],
    );
    return result.rows.map(mapFeedback);
  }

  async recordMemoryFeedback(
    input: RecordOpenVikingMemoryFeedbackInput,
  ): Promise<OpenVikingMemoryControl> {
    const fallback = defaultOpenVikingMemoryControl(input.workspaceId, input.memoryUri);
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.openviking_memories (
            workspace_id, uri, memory_type, authority, lifecycle, locked,
            evidence_status, source, created_at, updated_at
          )
          values ($1, $2, $3, $4, 'active', false, $5, $6, $7, $7)
          on conflict (workspace_id, uri) do nothing
        `,
        [
          input.workspaceId,
          input.memoryUri,
          fallback.memoryType,
          fallback.authority,
          fallback.evidenceStatus,
          fallback.source,
          input.createdAt,
        ],
      );
      const lifecycle = input.feedback === "helpful"
        ? "active"
        : input.feedback === "wrong"
          ? "invalidated"
          : "superseded";
      const evidenceStatus = input.feedback === "helpful" ? null : "invalid";
      await client.query(
        `
          update agent_recall.openviking_memories
          set lifecycle = $3,
              evidence_status = coalesce($4, evidence_status),
              updated_at = $5
          where workspace_id = $1 and uri = $2
        `,
        [input.workspaceId, input.memoryUri, lifecycle, evidenceStatus, input.createdAt],
      );
      if (input.feedback !== "helpful") {
        await client.query(
          `
            update agent_recall.openviking_memory_evidence
            set state = 'invalidated', updated_at = $3
            where workspace_id = $1 and memory_uri = $2 and state = 'active'
          `,
          [input.workspaceId, input.memoryUri, input.createdAt],
        );
      }
      await client.query(
        `
          insert into agent_recall.openviking_memory_feedback (
            id, workspace_id, memory_uri, feedback, actor, note, created_at
          ) values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (id) do nothing
        `,
        [
          input.id,
          input.workspaceId,
          input.memoryUri,
          input.feedback,
          input.actor,
          input.note ?? null,
          input.createdAt,
        ],
      );
    });
    const control = await this.getMemoryControl(input.workspaceId, input.memoryUri);
    if (!control) throw new Error("OpenViking memory feedback target was not found.");
    return control;
  }

  async invalidateSourceSessionEvidence(
    references: readonly OpenVikingSourceSessionReference[],
    now = new Date().toISOString(),
  ): Promise<string[]> {
    const unique = [...new Map(references
      .filter((reference) => reference.sourceSessionId && reference.sourceAgent)
      .map((reference) => [`${reference.sourceAgent}\0${reference.sourceSessionId}`, reference])).values()];
    if (unique.length === 0) return [];

    return this.database.transaction(async (client) => {
      const invalidated = await client.query<{ workspace_id: string; memory_uri: string }>(
        `
          with source_refs as (
            select *
            from jsonb_to_recordset($1::jsonb)
              as refs(source_session_id text, source_agent text)
          )
          update agent_recall.openviking_memory_evidence evidence
          set state = 'invalidated', updated_at = $2
          from source_refs refs
          where evidence.state = 'active'
            and evidence.source_session_id = refs.source_session_id
            and evidence.source_agent = refs.source_agent
          returning evidence.workspace_id, evidence.memory_uri
        `,
        [JSON.stringify(unique.map((reference) => ({
          source_session_id: reference.sourceSessionId,
          source_agent: reference.sourceAgent,
        }))), now],
      );
      if (invalidated.rows.length === 0) return [];

      const affected = [...new Map(invalidated.rows.map((row) => [
        `${row.workspace_id}\0${row.memory_uri}`,
        row,
      ])).values()];
      await client.query(
        `
          with affected as (
            select *
            from jsonb_to_recordset($1::jsonb)
              as memories(workspace_id text, memory_uri text)
          )
          update agent_recall.openviking_memories memories
          set lifecycle = 'invalidated', evidence_status = 'invalid', updated_at = $2
          from affected
          where memories.workspace_id = affected.workspace_id
            and memories.uri = affected.memory_uri
            and memories.authority = 'model'
            and memories.locked = false
            and not exists (
              select 1
              from agent_recall.openviking_memory_evidence evidence
              where evidence.workspace_id = memories.workspace_id
                and evidence.memory_uri = memories.uri
                and evidence.state = 'active'
            )
        `,
        [JSON.stringify(affected), now],
      );

      const workspaceIds = [...new Set(affected.map((row) => row.workspace_id))];
      await Promise.all(workspaceIds.map((workspaceId) => client.query(
        `
          insert into agent_recall.openviking_operation_events (
            id, workspace_id, phase, status, started_at, completed_at, duration_ms, details
          ) values ($1, $2, 'evidence-invalidate', 'completed', $3, $3, 0, $4)
        `,
        [
          randomUUID(),
          workspaceId,
          now,
          JSON.stringify({
            source: "session-delete",
            sourceSessionCount: unique.length,
            affectedMemoryCount: affected.filter((row) => row.workspace_id === workspaceId).length,
          }),
        ],
      )));
      return workspaceIds;
    });
  }

  async upsertCommitRun(run: OpenVikingCommitRun): Promise<void> {
    await upsertCommitRun(this.database, run);
  }

  async applyCommitResult(input: OpenVikingApplyCommitInput): Promise<OpenVikingLockedMemoryConflict[]> {
    return this.database.transaction(async (client) => {
      const uris = [...new Set(input.changes.map((change) => change.uri))];
      const controls = uris.length === 0
        ? []
        : (await client.query<MemoryRow>(
          `${MEMORY_SELECT} where memories.workspace_id = $1 and memories.uri = any($2::text[])`,
          [input.run.workspaceId, uris],
        )).rows.map(mapMemoryControl);
      const controlsByUri = new Map(controls.map((control) => [control.uri, control]));
      const conflicts: OpenVikingLockedMemoryConflict[] = [];
      const completedAt = input.run.completedAt ?? input.run.updatedAt;

      for (const change of input.changes) {
        const existing = controlsByUri.get(change.uri);
        if (existing?.locked && existing.lockedContent !== undefined) {
          conflicts.push({
            uri: change.uri,
            content: existing.lockedContent,
            ...(existing.title ? { title: existing.title } : {}),
            change,
          });
          continue;
        }

        if (change.kind === "delete") {
          const fallback = existing ?? defaultOpenVikingMemoryControl(input.run.workspaceId, change.uri);
          await client.query(
            `
              insert into agent_recall.openviking_memories (
                workspace_id, uri, memory_type, authority, lifecycle, locked,
                evidence_status, source, created_at, updated_at
              )
              values ($1, $2, $3, $4, 'invalidated', false, 'invalid', $5, $6, $6)
              on conflict (workspace_id, uri) do update set
                lifecycle = 'invalidated',
                evidence_status = 'invalid',
                updated_at = excluded.updated_at
            `,
            [
              input.run.workspaceId,
              change.uri,
              change.memoryType || fallback.memoryType,
              fallback.authority,
              fallback.source,
              completedAt,
            ],
          );
        } else {
          await client.query(
            `
              insert into agent_recall.openviking_memories (
                workspace_id, uri, memory_type, authority, lifecycle, locked,
                evidence_status, source, created_at, updated_at
              )
              values ($1, $2, $3, 'model', 'active', false, 'verified', 'openviking', $4, $4)
              on conflict (workspace_id, uri) do update set
                memory_type = excluded.memory_type,
                authority = 'model',
                lifecycle = 'active',
                locked = false,
                evidence_status = 'verified',
                source = 'openviking',
                title = null,
                locked_content = null,
                updated_at = excluded.updated_at
            `,
            [input.run.workspaceId, change.uri, change.memoryType, completedAt],
          );
        }

        const evidenceId = commitEvidenceId(input.run.taskId, change.uri, change.kind);
        await client.query(
          `
            insert into agent_recall.openviking_memory_evidence (
              id, workspace_id, memory_uri, source_session_id, source_agent,
              source_turn_ids, archive_uri, memory_diff_uri, remote_task_id,
              model_snapshot, policy_snapshot, state, created_at, updated_at
            ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
            on conflict (id) do update set
              archive_uri = excluded.archive_uri,
              memory_diff_uri = excluded.memory_diff_uri,
              model_snapshot = excluded.model_snapshot,
              policy_snapshot = excluded.policy_snapshot,
              state = excluded.state,
              updated_at = excluded.updated_at
          `,
          [
            evidenceId,
            input.run.workspaceId,
            change.uri,
            input.run.sourceSessionId ?? input.run.sessionId,
            input.run.agent ?? null,
            JSON.stringify(input.run.sourceTurnIds),
            input.archiveUri ?? null,
            input.memoryDiffUri ?? null,
            input.run.taskId,
            input.modelSnapshot ? JSON.stringify(input.modelSnapshot) : null,
            input.policySnapshot ? JSON.stringify(input.policySnapshot) : null,
            change.kind === "delete" ? "invalidated" : "active",
            completedAt,
          ],
        );
      }

      await upsertCommitRun(client, {
        ...input.run,
        state: "completed",
        archiveUri: input.archiveUri ?? input.run.archiveUri,
        memoryDiffUri: input.memoryDiffUri ?? input.run.memoryDiffUri,
        completedAt,
        updatedAt: completedAt,
      });
      return conflicts;
    });
  }

  async recordOperationEvent(event: OpenVikingOperationEvent): Promise<void> {
    await this.database.query(
      `
        insert into agent_recall.openviking_operation_events (
          id, workspace_id, phase, status, session_id, task_id,
          started_at, completed_at, duration_ms, details
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        on conflict (id) do nothing
      `,
      [
        event.id,
        event.workspaceId,
        event.phase,
        event.status,
        event.sessionId ?? null,
        event.taskId ?? null,
        event.startedAt,
        event.completedAt ?? null,
        event.durationMs ?? null,
        event.details ? JSON.stringify(event.details) : null,
      ],
    );
  }

  async recordRecallTrace(trace: OpenVikingRecallTrace): Promise<void> {
    await this.database.query(
      `
        insert into agent_recall.openviking_recall_traces (
          id, workspace_id, agent, query, contextual_query, searched_scopes,
          searched_types, candidates, injected_uris, injected_token_count,
          duration_ms, degraded_reason, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (id) do nothing
      `,
      [
        trace.id,
        trace.workspaceId,
        trace.agent,
        trace.query,
        trace.contextualQuery,
        JSON.stringify(trace.searchedScopes),
        JSON.stringify(trace.searchedTypes),
        JSON.stringify(trace.candidates),
        JSON.stringify(trace.injectedUris),
        trace.injectedTokenCount,
        trace.durationMs,
        trace.degradedReason ?? null,
        trace.createdAt,
      ],
    );
  }

  async getControlDiagnostics(limit = 30): Promise<OpenVikingControlDiagnostics> {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)));
    const [events, traces, commits] = await Promise.all([
      this.database.query<EventRow>(
        `
          select id, workspace_id, phase, status, session_id, task_id,
                 started_at, completed_at, duration_ms, details
          from agent_recall.openviking_operation_events
          order by started_at desc, id desc
          limit $1
        `,
        [cap],
      ),
      this.database.query<RecallTraceRow>(
        `
          select id, workspace_id, agent, query, contextual_query, searched_scopes,
                 searched_types, candidates, injected_uris, injected_token_count,
                 duration_ms, degraded_reason, created_at
          from agent_recall.openviking_recall_traces
          order by created_at desc, id desc
          limit $1
        `,
        [cap],
      ),
      this.database.query<CommitRow>(
        `
          select task_id, workspace_id, session_id, agent, trigger, state,
                 source_turn_ids, token_estimate, archive_uri, memory_diff_uri,
                 memories_extracted, token_usage, error, started_at, completed_at, updated_at
          from agent_recall.openviking_commit_runs
          order by updated_at desc, task_id desc
          limit $1
        `,
        [cap],
      ),
    ]);
    return {
      recentEvents: events.rows.map(mapEvent),
      recentRecallTraces: traces.rows.map(mapRecallTrace),
      recentCommits: commits.rows.map(mapCommitRun),
    };
  }

  private async findWorkspace(clause: string, value: string): Promise<OpenVikingWorkspace | null> {
    const result = await this.database.query<WorkspaceRow>(`${WORKSPACE_SELECT} where ${clause}`, [value]);
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }
}

async function upsertCommitRun(database: PostgresQueryable, run: OpenVikingCommitRun): Promise<void> {
  await database.query(
    `
      insert into agent_recall.openviking_commit_runs (
        task_id, workspace_id, session_id, agent, trigger, state,
        source_turn_ids, token_estimate, archive_uri, memory_diff_uri,
        memories_extracted, token_usage, error, started_at, completed_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      on conflict (task_id) do update set
        state = excluded.state,
        archive_uri = coalesce(excluded.archive_uri, agent_recall.openviking_commit_runs.archive_uri),
        memory_diff_uri = coalesce(excluded.memory_diff_uri, agent_recall.openviking_commit_runs.memory_diff_uri),
        memories_extracted = coalesce(excluded.memories_extracted, agent_recall.openviking_commit_runs.memories_extracted),
        token_usage = coalesce(excluded.token_usage, agent_recall.openviking_commit_runs.token_usage),
        error = excluded.error,
        completed_at = coalesce(excluded.completed_at, agent_recall.openviking_commit_runs.completed_at),
        updated_at = excluded.updated_at
    `,
    [
      run.taskId,
      run.workspaceId,
      run.sessionId,
      run.agent ?? null,
      run.trigger,
      run.state,
      JSON.stringify(run.sourceTurnIds),
      run.tokenEstimate,
      run.archiveUri ?? null,
      run.memoryDiffUri ?? null,
      run.memoriesExtracted ? JSON.stringify(run.memoriesExtracted) : null,
      run.tokenUsage ? JSON.stringify(run.tokenUsage) : null,
      run.error ?? null,
      run.startedAt,
      run.completedAt ?? null,
      run.updatedAt,
    ],
  );
}

function mapWorkspace(row: WorkspaceRow): OpenVikingWorkspace {
  return {
    id: row.id,
    userId: row.user_id,
    rootPath: row.root_path,
    identity: row.identity,
    displayName: row.display_name,
    managed: row.managed,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapMemoryControl(row: MemoryRow): OpenVikingMemoryControl {
  return {
    workspaceId: row.workspace_id,
    uri: row.uri,
    memoryType: row.memory_type,
    authority: row.authority,
    lifecycle: row.lifecycle,
    locked: row.locked,
    evidenceStatus: row.evidence_status,
    source: row.source,
    ...(row.title ? { title: row.title } : {}),
    ...(row.locked_content !== null ? { lockedContent: row.locked_content } : {}),
    evidenceCount: Number(row.evidence_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapEvidence(row: EvidenceRow): OpenVikingMemoryEvidence {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    memoryUri: row.memory_uri,
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.source_agent ? { sourceAgent: row.source_agent } : {}),
    sourceTurnIds: stringArray(row.source_turn_ids),
    ...(row.archive_uri ? { archiveUri: row.archive_uri } : {}),
    ...(row.memory_diff_uri ? { memoryDiffUri: row.memory_diff_uri } : {}),
    ...(row.remote_task_id ? { remoteTaskId: row.remote_task_id } : {}),
    ...(recordValue(row.model_snapshot) ? { modelSnapshot: recordValue(row.model_snapshot)! } : {}),
    ...(recordValue(row.policy_snapshot) ? { policySnapshot: recordValue(row.policy_snapshot)! } : {}),
    state: row.state,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapFeedback(row: FeedbackRow): OpenVikingMemoryFeedback {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    memoryUri: row.memory_uri,
    feedback: row.feedback,
    actor: row.actor,
    ...(row.note ? { note: row.note } : {}),
    createdAt: iso(row.created_at),
  };
}

function mapCommitRun(row: CommitRow): OpenVikingCommitRun {
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    ...(row.agent ? { agent: row.agent } : {}),
    trigger: row.trigger,
    state: row.state,
    sourceTurnIds: stringArray(row.source_turn_ids),
    tokenEstimate: Number(row.token_estimate),
    ...(row.archive_uri ? { archiveUri: row.archive_uri } : {}),
    ...(row.memory_diff_uri ? { memoryDiffUri: row.memory_diff_uri } : {}),
    ...(numberRecord(row.memories_extracted) ? { memoriesExtracted: numberRecord(row.memories_extracted)! } : {}),
    ...(recordValue(row.token_usage) ? { tokenUsage: recordValue(row.token_usage)! } : {}),
    ...(row.error ? { error: row.error } : {}),
    startedAt: iso(row.started_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    updatedAt: iso(row.updated_at),
  };
}

function mapEvent(row: EventRow): OpenVikingOperationEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    phase: row.phase,
    status: row.status,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    startedAt: iso(row.started_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
    ...(recordValue(row.details) ? { details: recordValue(row.details)! } : {}),
  };
}

function mapRecallTrace(row: RecallTraceRow): OpenVikingRecallTrace {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agent: row.agent,
    query: row.query,
    contextualQuery: row.contextual_query,
    searchedScopes: stringArray(row.searched_scopes),
    searchedTypes: stringArray(row.searched_types),
    candidates: recallCandidates(row.candidates),
    injectedUris: stringArray(row.injected_uris),
    injectedTokenCount: Number(row.injected_token_count),
    durationMs: Number(row.duration_ms),
    ...(row.degraded_reason ? { degradedReason: row.degraded_reason } : {}),
    createdAt: iso(row.created_at),
  };
}

function recallCandidates(value: unknown): OpenVikingRecallCandidateTrace[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is OpenVikingRecallCandidateTrace => (
    Boolean(candidate)
      && typeof candidate === "object"
      && typeof (candidate as OpenVikingRecallCandidateTrace).uri === "string"
  ));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberRecord(value: unknown): Record<string, number> | null {
  const record = recordValue(value);
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

function commitEvidenceId(taskId: string, uri: string, kind: string): string {
  const digest = createHash("sha256").update(`${taskId}\0${kind}\0${uri}`, "utf8").digest("hex");
  return `commit-${digest.slice(0, 40)}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
