import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  OpenVikingApplyCommitInput,
  OpenVikingCommitRun,
  OpenVikingMemoryChange,
  OpenVikingOperationEvent,
  OpenVikingRecallTrace,
} from "../../core/openviking-memory-control";
import type { OpenVikingClientPort } from "./openviking-client";
import type { OpenVikingCredentialStorePort } from "./openviking-memory-service";

interface OpenVikingHookStateFlusherOptions {
  stateDir: string;
  client: Pick<
    OpenVikingClientPort,
    "commitSession" | "getTask" | "readMemory" | "writeMemoryContent"
  >;
  credentials: Pick<OpenVikingCredentialStorePort, "get">;
  control: {
    upsertOpenVikingCommitRun(run: OpenVikingCommitRun): Promise<void>;
    applyOpenVikingCommitResult(
      input: OpenVikingApplyCommitInput,
    ): Promise<Array<{ uri: string; content: string }>>;
    recordOpenVikingOperationEvent(event: OpenVikingOperationEvent): Promise<void>;
    recordOpenVikingRecallTrace(trace: OpenVikingRecallTrace): Promise<void>;
  };
  onStateChanged?(): void | Promise<void>;
  snapshot?(): Promise<{
    modelSnapshot?: Record<string, unknown>;
    policySnapshot?: Record<string, unknown>;
  }>;
  idleMs?: number;
  intervalMs?: number;
}

interface HookTurnEvidence {
  id?: string;
  inputChars?: number;
  toolCount?: number;
}

interface HookCommitTask {
  taskId?: string;
  trigger?: string;
  agent?: string;
  sourceSessionId?: string;
  sourceTurnIds?: string[];
  tokenEstimate?: number;
  inputChars?: number;
  toolCount?: number;
  startedAt?: string;
  acceptedAt?: string;
}

interface HookSessionState {
  workspaceId?: string;
  sessionId?: string;
  sourceSessionId?: string;
  agent?: string;
  pendingTokenEstimate?: number;
  pendingEvidence?: HookTurnEvidence[];
  commitTasks?: HookCommitTask[];
  recallBlockedByTaskId?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface OpenVikingTaskRecord extends Record<string, unknown> {
  status?: unknown;
  result?: unknown;
  error?: unknown;
}

interface OpenVikingTaskResult extends Record<string, unknown> {
  archive_uri?: unknown;
  archiveUri?: unknown;
  memory_diff_uri?: unknown;
  memoryDiffUri?: unknown;
  memories_extracted?: unknown;
  memoriesExtracted?: unknown;
  token_usage?: unknown;
  tokenUsage?: unknown;
  stage_timings?: unknown;
  stageTimings?: unknown;
  stages?: unknown;
}

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_INTERVAL_MS = 10_000;

export class OpenVikingHookStateFlusher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private readonly options: OpenVikingHookStateFlusherOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushIdle().catch(() => {
        // Pending state and artifacts remain on disk for the next sweep.
      });
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async flushIdle(now = Date.now()): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    let changed = false;
    try {
      changed = await this.flushArtifacts() || changed;
      let names: string[];
      try {
        names = (await readdir(this.options.stateDir)).filter((name) => name.endsWith(".json"));
      } catch {
        return;
      }
      for (const name of names) {
        changed = await this.flushFile(path.join(this.options.stateDir, name), now) || changed;
      }
    } finally {
      this.flushing = false;
      if (changed) await this.options.onStateChanged?.();
    }
  }

  private async flushArtifacts(): Promise<boolean> {
    const [events, traces] = await Promise.all([
      this.flushArtifactDirectory("operation-events", async (value) => {
        await this.options.control.recordOpenVikingOperationEvent(value as unknown as OpenVikingOperationEvent);
      }),
      this.flushArtifactDirectory("recall-traces", async (value) => {
        await this.options.control.recordOpenVikingRecallTrace(value as unknown as OpenVikingRecallTrace);
      }),
    ]);
    return events || traces;
  }

  private async flushArtifactDirectory(
    name: string,
    persist: (value: Record<string, unknown>) => Promise<void>,
  ): Promise<boolean> {
    const directory = path.join(this.options.stateDir, name);
    let names: string[];
    try {
      names = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
    } catch {
      return false;
    }
    let changed = false;
    for (const entry of names) {
      const filePath = path.join(directory, entry);
      try {
        const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
        await persist(value);
        await rm(filePath, { force: true });
        changed = true;
      } catch {
        // Keep invalid or temporarily unpersisted artifacts for inspection/retry.
      }
    }
    return changed;
  }

  private async flushFile(filePath: string, now: number): Promise<boolean> {
    let state = await readState(filePath);
    if (!state) return false;
    let changed = false;

    if (state.workspaceId && state.sessionId && Array.isArray(state.commitTasks)) {
      const result = await this.processCommitTasks(state, now);
      if (result.completedTaskIds.size > 0) {
        const current = await readState(filePath);
        if (!current) return changed;
        current.commitTasks = (Array.isArray(current.commitTasks) ? current.commitTasks : [])
          .filter((task) => !result.completedTaskIds.has(String(task?.taskId || "")));
        if (result.lastOutcome?.state === "failed") {
          current.recallBlockedByTaskId = result.lastOutcome.taskId;
        } else if (result.lastOutcome?.state === "completed") {
          delete current.recallBlockedByTaskId;
        }
        await writeState(filePath, current);
        state = current;
        changed = true;
      }
    }

    const pending = Number(state.pendingTokenEstimate || 0);
    const updatedAt = Date.parse(state.updatedAt || "");
    if (
      pending <= 0
      || !state.workspaceId
      || !state.sessionId
      || !Number.isFinite(updatedAt)
      || now - updatedAt < (this.options.idleMs ?? DEFAULT_IDLE_MS)
    ) return changed;
    const auth = await this.options.credentials.get(state.workspaceId);
    if (!auth) return changed;

    const startedAt = new Date(now).toISOString();
    let taskId: string;
    try {
      taskId = (await this.options.client.commitSession(auth, state.sessionId)).taskId;
    } catch (error) {
      await this.options.control.recordOpenVikingOperationEvent({
        id: randomUUID(),
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
        phase: "commit",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - now),
        details: { trigger: "idle", error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
      return changed;
    }

    const current = await readState(filePath);
    if (!current) return changed;
    if (current.updatedAt !== state.updatedAt || Number(current.pendingTokenEstimate || 0) !== pending) return changed;
    const sourceTurnIds = (Array.isArray(current.pendingEvidence) ? current.pendingEvidence : [])
      .map((evidence) => String(evidence?.id || ""))
      .filter(Boolean);
    const inputChars = (Array.isArray(current.pendingEvidence) ? current.pendingEvidence : [])
      .reduce((total, evidence) => total + Math.max(0, Number(evidence?.inputChars || 0)), 0);
    const toolCount = (Array.isArray(current.pendingEvidence) ? current.pendingEvidence : [])
      .reduce((total, evidence) => total + Math.max(0, Number(evidence?.toolCount || 0)), 0);
    const acceptedAt = new Date(now).toISOString();
    const task: HookCommitTask = {
      taskId,
      trigger: "idle",
      agent: current.agent || "unknown",
      ...(current.sourceSessionId ? { sourceSessionId: current.sourceSessionId } : {}),
      sourceTurnIds,
      tokenEstimate: pending,
      inputChars,
      toolCount,
      startedAt,
      acceptedAt,
    };
    current.pendingEvidence = [];
    current.pendingTokenEstimate = 0;
    current.pendingSince = null;
    current.commitTasks = [
      ...(Array.isArray(current.commitTasks) ? current.commitTasks : []).filter((item) => item?.taskId !== taskId),
      task,
    ].slice(-20);
    current.lastCommittedAt = acceptedAt;
    current.updatedAt = acceptedAt;
    await writeState(filePath, current);
    await this.options.control.upsertOpenVikingCommitRun(toCommitRun(current, task, "running"));
    await this.options.control.recordOpenVikingOperationEvent({
      id: randomUUID(),
      workspaceId: current.workspaceId!,
      sessionId: current.sessionId!,
      taskId,
      phase: "commit",
      status: "completed",
      startedAt,
      completedAt: acceptedAt,
      durationMs: Math.max(0, Date.parse(acceptedAt) - now),
      details: {
        trigger: "idle",
        sourceTurnCount: sourceTurnIds.length,
        tokenEstimate: pending,
        inputChars,
        toolCount,
      },
    });
    return true;
  }

  private async processCommitTasks(
    state: HookSessionState,
    now: number,
  ): Promise<{
    completedTaskIds: Set<string>;
    lastOutcome?: { taskId: string; state: "completed" | "failed" };
  }> {
    const completedTaskIds = new Set<string>();
    let lastOutcome: { taskId: string; state: "completed" | "failed" } | undefined;
    const auth = await this.options.credentials.get(state.workspaceId!);
    if (!auth) return { completedTaskIds };
    for (const task of state.commitTasks ?? []) {
      const taskId = String(task?.taskId || "");
      if (!taskId) continue;
      const run = toCommitRun(state, task, "running");
      await this.options.control.upsertOpenVikingCommitRun(run);
      let remoteTask: OpenVikingTaskRecord | null;
      try {
        remoteTask = await this.options.client.getTask(auth, taskId) as OpenVikingTaskRecord | null;
      } catch {
        continue;
      }
      if (!remoteTask) continue;
      const status = String(remoteTask.status || "").toLowerCase();
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        const completedAt = new Date(now).toISOString();
        await this.options.control.upsertOpenVikingCommitRun({
          ...run,
          state: "failed",
          error: taskError(remoteTask),
          completedAt,
          updatedAt: completedAt,
        });
        await this.options.control.recordOpenVikingOperationEvent({
          id: randomUUID(),
          workspaceId: state.workspaceId!,
          sessionId: state.sessionId!,
          taskId,
          phase: "verify",
          status: "failed",
          startedAt: run.startedAt,
          completedAt,
          durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(run.startedAt)),
          details: { error: taskError(remoteTask) },
        });
        completedTaskIds.add(taskId);
        lastOutcome = { taskId, state: "failed" };
        continue;
      }
      if (!["completed", "succeeded", "success", "done"].includes(status)) continue;

      const result = (objectValue(remoteTask.result) ?? {}) as OpenVikingTaskResult;
      const archiveUri = stringValue(result.archive_uri) || stringValue(result.archiveUri);
      const memoryDiffUri = stringValue(result.memory_diff_uri) || stringValue(result.memoryDiffUri);
      let changes: OpenVikingMemoryChange[] = [];
      if (memoryDiffUri) {
        try {
          changes = parseMemoryDiff(
            await this.options.client.readMemory(auth, memoryDiffUri),
            auth.userId,
          );
        } catch {
          continue;
        }
      }
      const completedAt = new Date(now).toISOString();
      const completedRun: OpenVikingCommitRun = {
        ...run,
        state: "completed",
        ...(archiveUri ? { archiveUri } : {}),
        ...(memoryDiffUri ? { memoryDiffUri } : {}),
        ...(numberRecord(result.memories_extracted ?? result.memoriesExtracted)
          ? { memoriesExtracted: numberRecord(result.memories_extracted ?? result.memoriesExtracted)! }
          : {}),
        ...(objectValue(result.token_usage ?? result.tokenUsage)
          ? { tokenUsage: objectValue(result.token_usage ?? result.tokenUsage)! }
          : {}),
        completedAt,
        updatedAt: completedAt,
      };
      const snapshot: {
        modelSnapshot?: Record<string, unknown>;
        policySnapshot?: Record<string, unknown>;
      } = this.options.snapshot
        ? await this.options.snapshot().catch(() => ({}))
        : {};
      const conflicts = await this.options.control.applyOpenVikingCommitResult({
        run: completedRun,
        changes,
        ...(archiveUri ? { archiveUri } : {}),
        ...(memoryDiffUri ? { memoryDiffUri } : {}),
        ...(snapshot?.modelSnapshot ? { modelSnapshot: snapshot.modelSnapshot } : {}),
        policySnapshot: {
          trigger: completedRun.trigger,
          ...(snapshot?.policySnapshot ?? {}),
        },
      });
      let restored = 0;
      try {
        for (const conflict of conflicts) {
          await this.options.client.writeMemoryContent(auth, conflict.uri, conflict.content);
          restored += 1;
        }
      } catch {
        continue;
      }
      await this.recordCompletedPhases(completedRun, changes, restored, remoteTask, result);
      completedTaskIds.add(taskId);
      lastOutcome = { taskId, state: "completed" };
    }
    return { completedTaskIds, ...(lastOutcome ? { lastOutcome } : {}) };
  }

  private async recordCompletedPhases(
    run: OpenVikingCommitRun,
    changes: OpenVikingMemoryChange[],
    restored: number,
    remoteTask: OpenVikingTaskRecord,
    result: OpenVikingTaskResult,
  ): Promise<void> {
    const completedAt = run.completedAt ?? run.updatedAt;
    const extracted = run.memoriesExtracted ?? {};
    const timings = stageTimings(remoteTask, result);
    const events: OpenVikingOperationEvent[] = [
      eventForPhase(run, "summary", "completed", completedAt, timings.get("summary"), {}),
      eventForPhase(run, "long-term-memory", "completed", completedAt, timings.get("long-term-memory"), {
        changes: changes.length,
        extracted,
      }),
      eventForPhase(
        run,
        "experience",
        Number(extracted.experiences || extracted.skills || extracted.cases || 0) > 0 ? "completed" : "skipped",
        completedAt,
        timings.get("experience"),
        { extracted },
      ),
      eventForPhase(run, "vectorize", "completed", completedAt, timings.get("vectorize"), {}),
      eventForPhase(run, "verify", "completed", completedAt, timings.get("verify"), {
        memoryDiffUri: run.memoryDiffUri,
        restoredLockedMemories: restored,
      }),
    ];
    await Promise.all(events.map((event) => this.options.control.recordOpenVikingOperationEvent(event)));
  }
}

function eventForPhase(
  run: OpenVikingCommitRun,
  phase: string,
  status: OpenVikingOperationEvent["status"],
  completedAt: string,
  timing: StageTiming | undefined,
  details: Record<string, unknown>,
): OpenVikingOperationEvent {
  const startedAt = timing?.startedAt ?? completedAt;
  const finishedAt = timing?.completedAt ?? completedAt;
  return {
    id: `${run.taskId}:${phase}`,
    workspaceId: run.workspaceId,
    sessionId: run.sessionId,
    taskId: run.taskId,
    phase,
    status,
    startedAt,
    completedAt: finishedAt,
    ...(timing?.durationMs === undefined ? {} : { durationMs: timing.durationMs }),
    details: {
      timingSource: timing ? "remote-task" : "completion-marker",
      ...details,
    },
  };
}

interface StageTiming {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

function stageTimings(
  remoteTask: OpenVikingTaskRecord,
  result: OpenVikingTaskResult,
): Map<string, StageTiming> {
  const output = new Map<string, StageTiming>();
  const candidates = [
    result.stage_timings,
    result.stageTimings,
    result.stages,
    remoteTask.stage_timings,
    remoteTask.stageTimings,
    remoteTask.stages,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const value of candidate) addStageTiming(output, value);
      continue;
    }
    const record = objectValue(candidate);
    if (!record) continue;
    for (const [name, value] of Object.entries(record)) addStageTiming(output, value, name);
  }
  return output;
}

function addStageTiming(
  output: Map<string, StageTiming>,
  value: unknown,
  fallbackName = "",
): void {
  const record = objectValue(value);
  if (!record) return;
  const phase = normalizeStageName(
    stringValue(record.phase)
      || stringValue(record.name)
      || stringValue(record.stage)
      || fallbackName,
  );
  if (!phase) return;
  const startedAt = validDate(record.started_at) ?? validDate(record.startedAt) ?? undefined;
  const completedAt = validDate(record.completed_at) ?? validDate(record.completedAt) ?? undefined;
  const rawDuration = Number(record.duration_ms ?? record.durationMs);
  const durationMs = Number.isFinite(rawDuration) && rawDuration >= 0 ? Math.floor(rawDuration) : undefined;
  output.set(phase, {
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function normalizeStageName(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  if (["summarize", "summary"].includes(normalized)) return "summary";
  if (["memory", "memories", "long-term-memory", "longterm-memory"].includes(normalized)) {
    return "long-term-memory";
  }
  if (["experience", "experiences", "skills", "cases"].includes(normalized)) return "experience";
  if (["vector", "vectors", "vectorize", "index", "indexing"].includes(normalized)) return "vectorize";
  if (["verify", "verification", "finalize"].includes(normalized)) return "verify";
  return "";
}

function toCommitRun(
  state: HookSessionState,
  task: HookCommitTask,
  runState: OpenVikingCommitRun["state"],
): OpenVikingCommitRun {
  const startedAt = validDate(task.startedAt) ?? validDate(task.acceptedAt) ?? new Date().toISOString();
  const updatedAt = validDate(task.acceptedAt) ?? startedAt;
  return {
    taskId: String(task.taskId || ""),
    workspaceId: state.workspaceId!,
    sessionId: state.sessionId!,
    ...(task.sourceSessionId || state.sourceSessionId
      ? { sourceSessionId: String(task.sourceSessionId || state.sourceSessionId) }
      : {}),
    ...(task.agent || state.agent ? { agent: String(task.agent || state.agent) } : {}),
    trigger: String(task.trigger || "unknown"),
    state: runState,
    sourceTurnIds: Array.isArray(task.sourceTurnIds)
      ? task.sourceTurnIds.filter((value): value is string => typeof value === "string")
      : [],
    tokenEstimate: Math.max(0, Math.floor(Number(task.tokenEstimate || 0))),
    startedAt,
    updatedAt,
  };
}

function parseMemoryDiff(content: string, userId: string): OpenVikingMemoryChange[] {
  const value = JSON.parse(content) as Record<string, unknown>;
  const operations = objectValue(value.operations);
  if (!operations) return [];
  const changes: OpenVikingMemoryChange[] = [];
  for (const [kind, key] of [["add", "adds"], ["update", "updates"], ["delete", "deletes"]] as const) {
    const values = Array.isArray(operations[key]) ? operations[key] : [];
    for (const candidate of values) {
      const record = objectValue(candidate);
      if (!record) continue;
      const uri = normalizeMemoryUri(stringValue(record.uri), userId);
      if (!uri) continue;
      changes.push({
        kind,
        uri,
        memoryType: stringValue(record.memory_type) || inferMemoryType(uri),
        ...(stringValue(record.before) ? { before: stringValue(record.before) } : {}),
        ...(stringValue(record.after) ? { after: stringValue(record.after) } : {}),
        ...(stringValue(record.deleted_content) ? { before: stringValue(record.deleted_content) } : {}),
      });
    }
  }
  return changes;
}

function normalizeMemoryUri(uri: string, userId: string): string {
  if (uri.startsWith("viking://user/memories/")) return uri;
  const normalized = uri.replaceAll("\\", "/");
  const prefix = `memory/user/${userId}/`;
  if (!normalized.startsWith(prefix)) return "";
  const suffix = normalized.slice(prefix.length);
  if (!suffix || suffix.split("/").some((segment) => !segment || segment === "." || segment === "..")) return "";
  return `viking://user/memories/${suffix}`;
}

function taskError(task: OpenVikingTaskRecord): string {
  if (typeof task.error === "string") return task.error;
  const error = objectValue(task.error);
  return stringValue(error?.message) || "OpenViking commit task failed.";
}

async function readState(filePath: string): Promise<HookSessionState | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as HookSessionState;
  } catch {
    return null;
  }
}

async function writeState(filePath: string, state: HookSessionState): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberRecord(value: unknown): Record<string, number> | null {
  const record = objectValue(value);
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

function inferMemoryType(uri: string): string {
  const segment = uri
    .toLowerCase()
    .replace(/^viking:\/\/user\/memories\//u, "")
    .split("/")[0]
    ?.replace(/\.md$/u, "");
  if (segment === "identity" || segment === "soul") return "profile";
  return segment || "other";
}
