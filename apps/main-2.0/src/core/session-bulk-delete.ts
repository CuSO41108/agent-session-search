import type { EnvironmentKind, LiveSession, SessionSource } from "./types";

export const SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE = "Session deletion requires explicit confirmation.";
export const SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE =
  "Session deletion requires explicit confirmation because running sessions could not be verified.";
export const SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD = 10;

export function isSessionDeleteConfirmationRequiredMessage(message: string): boolean {
  return matchesIpcErrorMessage(message, SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
}

export function isSessionDeleteLiveCheckConfirmationRequiredMessage(message: string): boolean {
  return matchesIpcErrorMessage(message, SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE);
}

export interface SessionDeleteOptions {
  confirmed?: boolean;
  allowLiveSessions?: boolean;
  allowUnverifiedLiveSessions?: boolean;
  confirmationFingerprint?: string;
}

export function normalizeSessionDeleteOptions(options: unknown): Required<Omit<SessionDeleteOptions, "confirmationFingerprint">>
  & Pick<SessionDeleteOptions, "confirmationFingerprint"> {
  if (options === undefined) {
    return {
      confirmed: false,
      allowLiveSessions: false,
      allowUnverifiedLiveSessions: false,
    };
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("The session deletion options are invalid.");
  }
  const candidate = options as SessionDeleteOptions;
  if (
    (candidate.confirmed !== undefined && typeof candidate.confirmed !== "boolean")
    || (candidate.allowLiveSessions !== undefined && typeof candidate.allowLiveSessions !== "boolean")
    || (
      candidate.allowUnverifiedLiveSessions !== undefined
      && typeof candidate.allowUnverifiedLiveSessions !== "boolean"
    )
    || (candidate.confirmationFingerprint !== undefined && typeof candidate.confirmationFingerprint !== "string")
  ) {
    throw new Error("The session deletion options are invalid.");
  }
  const confirmed = candidate.confirmed === true;
  return {
    confirmed,
    allowLiveSessions: confirmed && candidate.allowLiveSessions === true,
    allowUnverifiedLiveSessions: confirmed && candidate.allowUnverifiedLiveSessions === true,
    confirmationFingerprint: confirmed ? candidate.confirmationFingerprint : undefined,
  };
}

export type SessionBulkDeleteSkipReason =
  | "not-found"
  | "live"
  | "favorite"
  | "recent"
  | "read-only"
  | "remote-source"
  | "shared-database";

export interface SessionBulkDeleteRequest {
  sessionKeys: string[];
  liveSessionKeys: string[];
  inactiveBefore?: number;
  protectFavorites?: boolean;
  includeOrphanedSubagents?: boolean;
  confirmed?: boolean;
  openSessionKey?: string;
  liveSessionCheckFailed?: boolean;
  allowUnverifiedLiveSessions?: boolean;
  confirmationFingerprint?: string;
}

export interface SessionBulkDeleteTarget {
  sessionKey: string;
  cascadeRootSessionKey: string;
  orphanedParentSessionId: string | null;
  rawId: string;
  source: SessionSource;
  filePath: string;
  isSubagent: boolean;
  parentSessionId: string | null;
  ancestorRawIds: string[];
  sourceAvailable: boolean;
  favorited: boolean;
  lastActivityAt: number;
  environmentId: string;
  environmentKind: EnvironmentKind;
}

export interface SessionBulkDeleteIssue {
  sessionKey: string;
  reason: SessionBulkDeleteSkipReason | "delete-failed";
  message: string;
}

export interface SessionBulkDeletePreview {
  requestedCount: number;
  matchedCount: number;
  expandedCount: number;
  deletableCount: number;
  hasRelatedSessions: boolean;
  includesOpenSession: boolean;
  liveSessionCheckFailed: boolean;
  confirmationFingerprint: string;
  sourceCounts: Array<{ source: SessionSource; count: number }>;
  skipped: SessionBulkDeleteIssue[];
}

export interface SessionBulkDeleteResult extends SessionBulkDeletePreview {
  deletedSessionKeys: string[];
  failed: SessionBulkDeleteIssue[];
}

export function liveSessionDeleteKey(session: Pick<LiveSession, "family" | "rawId" | "environmentId">): string {
  const familyKey = `${session.family}:${session.rawId}`;
  return session.environmentId ? `${session.environmentId}\0${familyKey}` : familyKey;
}

function matchesIpcErrorMessage(message: string, expected: string): boolean {
  return message === expected || message.endsWith(`: ${expected}`);
}
