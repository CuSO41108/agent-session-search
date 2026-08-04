import type { RemoteSessionListItem, RemoteSessionStatus, SessionSyncItem } from "../../core/remote-session-sync";

export interface RemoteSessionsCache {
  status: RemoteSessionStatus | null;
  items: SessionSyncItem[];
  initialized: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  uploadTasks: Record<string, RemoteSessionUploadTask>;
  uploadBatch: RemoteSessionOperationBatch | null;
  deleteTasks: Record<string, RemoteSessionDeleteTask>;
  deleteBatch: RemoteSessionOperationBatch | null;
}

export type RemoteSessionTaskState = "queued" | "running" | "succeeded" | "failed";

export interface RemoteSessionUploadRequest {
  itemId: string;
  sessionKey: string;
  title: string;
  force?: boolean;
}

export interface RemoteSessionDeleteRequest {
  itemId: string;
  remoteId: string;
  title: string;
}

export interface RemoteSessionUploadTask extends RemoteSessionUploadRequest {
  state: RemoteSessionTaskState;
  error: string | null;
}

export interface RemoteSessionDeleteTask extends RemoteSessionDeleteRequest {
  state: RemoteSessionTaskState;
  error: string | null;
}

export interface RemoteSessionOperationBatch {
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
}

export const EMPTY_REMOTE_SESSIONS_CACHE: RemoteSessionsCache = {
  status: null,
  items: [],
  initialized: false,
  loading: false,
  refreshing: false,
  error: null,
  uploadTasks: {},
  uploadBatch: null,
  deleteTasks: {},
  deleteBatch: null,
};

export function applyRemoteSessionUpload(
  items: SessionSyncItem[],
  localSessionKey: string,
  remote: RemoteSessionListItem,
): SessionSyncItem[] {
  return items.map((item) => {
    if (item.local?.sessionKey !== localSessionKey && item.remote?.id !== remote.id) return item;
    return {
      ...item,
      id: remote.id,
      state: "synced",
      remote,
      localRevision: remote.contentHash,
      remoteRevision: remote.contentHash,
      lastSyncedAt: remote.syncedAt,
    };
  });
}

export function applyRemoteSessionDeletion(items: SessionSyncItem[], removedRemoteIds: Iterable<string>): SessionSyncItem[] {
  const removed = new Set(removedRemoteIds);
  return items.flatMap((item) => {
    if (!item.remote || !removed.has(item.remote.id)) return [item];
    if (!item.local) return [];
    return [{
      ...item,
      id: `local:${item.local.sessionKey}`,
      state: "local-only",
      remote: null,
      remoteRevision: "",
      lastSyncedAt: null,
    }];
  });
}
