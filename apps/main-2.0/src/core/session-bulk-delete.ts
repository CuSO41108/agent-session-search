import type { EnvironmentKind, SessionSource } from "./types";

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
}

export interface SessionBulkDeleteTarget {
  sessionKey: string;
  rawId: string;
  source: SessionSource;
  filePath: string;
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
  deletableCount: number;
  sourceCounts: Array<{ source: SessionSource; count: number }>;
  skipped: SessionBulkDeleteIssue[];
}

export interface SessionBulkDeleteResult extends SessionBulkDeletePreview {
  deletedSessionKeys: string[];
  failed: SessionBulkDeleteIssue[];
}
