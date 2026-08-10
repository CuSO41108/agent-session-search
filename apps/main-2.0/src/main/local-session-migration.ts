import { assertMigrationTargetEnabled, isMigrationTarget } from "../core/migration-targets";
import type { AppSettings } from "../core/platform";
import type { MigrationCompressionListener, PreparedMigrationSession } from "../core/session-migration-compression";
import type { WrittenMigratedSession } from "../core/session-migration-writers";
import type {
  MigrateSessionOptions,
  SessionMigrationDependencies,
} from "../core/session-migration";
import type {
  MigrationTarget,
  PortableSession,
  SessionMessage,
  SessionMigrationProgress,
  SessionMigrationRequest,
  SessionMigrationRecord,
  SessionMigrationResult,
  SessionSearchResult,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../core/types";

export interface LocalSessionMigrationSourceStore {
  getSession(sessionKey: string): Promise<SessionSearchResult | null>;
  getAllMessages(sessionKey: string): Promise<SessionMessage[]>;
  listSessionTurns(sessionKey: string): Promise<SessionTurnSummary[]>;
  getSessionTurn(sessionKey: string, turnId: string): Promise<SessionTurnDetail | null>;
}

export async function loadLocalSessionMigrationSource(
  store: LocalSessionMigrationSourceStore,
  request: SessionMigrationRequest,
): Promise<{
  source: SessionSearchResult;
  messages: SessionMessage[];
  turnSourceMessageIndexes: number[];
}> {
  const source = await store.getSession(request.sessionKey);
  if (!source) throw new Error("Session not found.");
  const [allMessages, turns] = await Promise.all([
    store.getAllMessages(request.sessionKey),
    store.listSessionTurns(request.sessionKey),
  ]);
  if (!request.throughTurnId) {
    return {
      source,
      messages: allMessages,
      turnSourceMessageIndexes: turns
        .map((turn) => turn.sourceMessageIndex)
        .filter((index): index is number => index !== null),
    };
  }

  const selectedTurn = await store.getSessionTurn(request.sessionKey, request.throughTurnId);
  if (!selectedTurn) throw new Error("Turn not found.");
  const selectedSummary = turns.find((turn) => turn.id === request.throughTurnId);
  if (!selectedSummary || selectedTurn.id !== request.throughTurnId) {
    throw new Error("Turn does not belong to this Session.");
  }
  if (selectedSummary.synthetic || selectedTurn.synthetic) {
    throw new Error("Synthetic turns cannot be migrated.");
  }
  const sourceIndexes = selectedTurn.messages
    .map((entry) => entry.sourceMessageIndex)
    .filter((index): index is number => index !== null);
  if (sourceIndexes.length === 0) throw new Error("Turn has no migration message boundary.");
  const cutoff = Math.max(...sourceIndexes);
  return {
    source,
    messages: allMessages.filter((entry) => entry.index <= cutoff),
    turnSourceMessageIndexes: turns
      .map((turn) => turn.sourceMessageIndex)
      .filter((index): index is number => index !== null && index <= cutoff),
  };
}

export interface LocalSessionMigrationRuntime<TEndpoint, TCompressor> {
  resolveSummaryEndpoint: (settings: AppSettings) => Promise<TEndpoint | null> | TEndpoint | null;
  createCompressor: (
    endpoint: TEndpoint,
    concurrency: number,
    completeTokenLimit: number,
  ) => TCompressor;
  migrate: (options: MigrateSessionOptions) => Promise<SessionMigrationResult>;
  inspectCli: (target: MigrationTarget, settings: AppSettings) => Promise<void> | void;
  prepare: (
    session: PortableSession,
    onProgress: MigrationCompressionListener | undefined,
    compressor: TCompressor | null,
    completeTokenLimit: number,
  ) => Promise<PreparedMigrationSession>;
  write: (target: MigrationTarget, session: PortableSession) => Promise<WrittenMigratedSession>;
  record: (record: SessionMigrationRecord) => Promise<void> | void;
  refreshIndex: (target: MigrationTarget, targetFilePath: string, targetSessionId: string) => Promise<void>;
  launch: (target: MigrationTarget, sessionId: string, projectPath: string, settings: AppSettings) => Promise<void>;
  resumeCommand: (target: MigrationTarget, sessionId: string, projectPath: string, settings: AppSettings) => string;
  fallbackResumeCommand: (target: MigrationTarget, sessionId: string, projectPath: string, settings: AppSettings) => string;
  onProgress?: (progress: SessionMigrationProgress) => void;
  idFactory: () => string;
  now: () => number;
  projectPathExists: SessionMigrationDependencies["projectPathExists"];
  projectPathIsDirectory: SessionMigrationDependencies["projectPathIsDirectory"];
}

export async function runLocalSessionMigration<TEndpoint, TCompressor>(
  input: {
    source: SessionSearchResult;
    messages: SessionMessage[];
    turnSourceMessageIndexes?: readonly number[];
    target: unknown;
    targetProjectPath?: string;
    settings: AppSettings;
  },
  runtime: LocalSessionMigrationRuntime<TEndpoint, TCompressor>,
): Promise<SessionMigrationResult> {
  const { source, messages, turnSourceMessageIndexes, target, targetProjectPath, settings } = input;
  if (!isMigrationTarget(target)) throw new Error(`Migration target ${String(target)} is not supported.`);
  assertMigrationTargetEnabled(target, settings);

  const endpoint = await runtime.resolveSummaryEndpoint(settings);
  const compressor = endpoint
    ? runtime.createCompressor(
        endpoint,
        settings.compressionConcurrency,
        settings.migrationCompleteTokenLimit,
      )
    : null;
  return runtime.migrate({
    source,
    messages,
    target,
    targetProjectPath,
    completeTokenLimit: settings.migrationCompleteTokenLimit,
    turnSourceMessageIndexes,
    deps: {
      inspectCli: (migrationTarget) => runtime.inspectCli(migrationTarget, settings),
      prepare: (session, onProgress) => runtime.prepare(
        session,
        onProgress,
        compressor,
        settings.migrationCompleteTokenLimit,
      ),
      write: runtime.write,
      record: runtime.record,
      refreshIndex: runtime.refreshIndex,
      launch: (migrationTarget, sessionId, projectPath) => runtime.launch(migrationTarget, sessionId, projectPath, settings),
      resumeCommand: (migrationTarget, sessionId, projectPath) => runtime.resumeCommand(migrationTarget, sessionId, projectPath, settings),
      fallbackResumeCommand: (migrationTarget, sessionId, projectPath) => runtime.fallbackResumeCommand(migrationTarget, sessionId, projectPath, settings),
      onProgress: runtime.onProgress,
      idFactory: runtime.idFactory,
      now: runtime.now,
      projectPathExists: runtime.projectPathExists,
      projectPathIsDirectory: runtime.projectPathIsDirectory,
    },
  });
}
