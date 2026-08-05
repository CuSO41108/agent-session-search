import { startTransition, useCallback, useRef, useState } from "react";
import {
  applyRemoteSessionDeletion,
  applyRemoteSessionUpload,
  EMPTY_REMOTE_SESSIONS_CACHE,
  type RemoteSessionDeleteRequest,
  type RemoteSessionUploadRequest,
  type RemoteSessionsCache,
} from "../../remote-sessions-cache";

export interface RemoteSessionsController {
  cache: RemoteSessionsCache;
  ensureLoaded(): Promise<void>;
  refresh(): Promise<void>;
  invalidate(): void;
  queueUploads(requests: RemoteSessionUploadRequest[]): void;
  queueDeletions(requests: RemoteSessionDeleteRequest[]): void;
}

export function useRemoteSessionsCache(): RemoteSessionsController {
  const [cache, setCache] = useState(EMPTY_REMOTE_SESSIONS_CACHE);
  const initializedRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const uploadQueueRef = useRef<RemoteSessionUploadRequest[]>([]);
  const activeUploadKeysRef = useRef(new Set<string>());
  const uploadRunningRef = useRef(false);
  const deleteQueueRef = useRef<RemoteSessionDeleteRequest[][]>([]);
  const activeDeleteIdsRef = useRef(new Set<string>());
  const deleteRunningRef = useRef(false);

  const refresh = useCallback((): Promise<void> => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    const requestId = ++loadSequenceRef.current;
    const request = (async () => {
      setCache((current) => ({
        ...current,
        loading: !current.initialized,
        refreshing: current.initialized,
        error: null,
      }));
      try {
        const snapshot = await window.sessionSearch.loadRemoteSessionSyncSnapshot();
        if (requestId !== loadSequenceRef.current) return;
        startTransition(() => {
          initializedRef.current = true;
          setCache((current) => ({
            ...current,
            status: snapshot.status,
            items: snapshot.items,
            initialized: true,
            loading: false,
            refreshing: false,
            error: null,
          }));
        });
      } catch (error) {
        if (requestId !== loadSequenceRef.current) return;
        initializedRef.current = true;
        setCache((current) => ({
          ...current,
          initialized: true,
          loading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    loadPromiseRef.current = request;
    void request.finally(() => {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null;
    });
    return request;
  }, []);

  const ensureLoaded = useCallback((): Promise<void> => {
    return initializedRef.current ? Promise.resolve() : refresh();
  }, [refresh]);

  const invalidate = useCallback((): void => {
    loadSequenceRef.current += 1;
    loadPromiseRef.current = null;
    initializedRef.current = false;
    setCache((current) => ({
      ...current,
      status: null,
      items: [],
      initialized: false,
      loading: false,
      refreshing: false,
      error: null,
    }));
  }, []);

  const drainUploads = useCallback(async (): Promise<void> => {
    if (uploadRunningRef.current) return;
    uploadRunningRef.current = true;
    try {
      while (uploadQueueRef.current.length > 0) {
        const request = uploadQueueRef.current.shift()!;
        setCache((current) => ({
          ...current,
          uploadTasks: {
            ...current.uploadTasks,
            [request.sessionKey]: { ...current.uploadTasks[request.sessionKey], ...request, state: "running", error: null },
          },
        }));
        try {
          const result = await window.sessionSearch.uploadRemoteSession(request.sessionKey, request.force);
          setCache((current) => ({
            ...current,
            items: applyRemoteSessionUpload(current.items, request.sessionKey, result.remoteSession),
            uploadTasks: {
              ...current.uploadTasks,
              [request.sessionKey]: { ...request, state: "succeeded", error: null },
            },
            uploadBatch: current.uploadBatch ? {
              ...current.uploadBatch,
              completed: current.uploadBatch.completed + 1,
              succeeded: current.uploadBatch.succeeded + 1,
            } : null,
          }));
        } catch (error) {
          setCache((current) => ({
            ...current,
            uploadTasks: {
              ...current.uploadTasks,
              [request.sessionKey]: { ...request, state: "failed", error: error instanceof Error ? error.message : String(error) },
            },
            uploadBatch: current.uploadBatch ? {
              ...current.uploadBatch,
              completed: current.uploadBatch.completed + 1,
              failed: current.uploadBatch.failed + 1,
            } : null,
          }));
        } finally {
          activeUploadKeysRef.current.delete(request.sessionKey);
        }
      }
    } finally {
      uploadRunningRef.current = false;
      setCache((current) => ({
        ...current,
        uploadBatch: current.uploadBatch ? { ...current.uploadBatch, running: false } : null,
      }));
    }
  }, []);

  const queueUploads = useCallback((requests: RemoteSessionUploadRequest[]): void => {
    const accepted = requests.filter((request) => {
      if (activeUploadKeysRef.current.has(request.sessionKey)) return false;
      activeUploadKeysRef.current.add(request.sessionKey);
      return true;
    });
    if (accepted.length === 0) return;
    const startingNewBatch = !uploadRunningRef.current && uploadQueueRef.current.length === 0;
    uploadQueueRef.current.push(...accepted);
    setCache((current) => {
      const uploadTasks = startingNewBatch ? {} : { ...current.uploadTasks };
      for (const request of accepted) {
        uploadTasks[request.sessionKey] = { ...request, state: "queued", error: null };
      }
      return {
        ...current,
        uploadTasks,
        uploadBatch: startingNewBatch || !current.uploadBatch?.running
          ? { running: true, total: accepted.length, completed: 0, succeeded: 0, failed: 0 }
          : { ...current.uploadBatch, total: current.uploadBatch.total + accepted.length },
      };
    });
    void drainUploads();
  }, [drainUploads]);

  const drainDeletions = useCallback(async (): Promise<void> => {
    if (deleteRunningRef.current) return;
    deleteRunningRef.current = true;
    try {
      while (deleteQueueRef.current.length > 0) {
        const requests = deleteQueueRef.current.shift()!;
        setCache((current) => {
          const deleteTasks = { ...current.deleteTasks };
          for (const request of requests) deleteTasks[request.remoteId] = { ...request, state: "running", error: null };
          return { ...current, deleteTasks };
        });
        try {
          const result = await window.sessionSearch.deleteRemoteSessions(requests.map((request) => request.remoteId));
          const removedIds = new Set([...result.deletedIds, ...result.missingIds]);
          const failures = new Map(result.failures.map((failure) => [failure.id, failure.message]));
          setCache((current) => {
            const deleteTasks = { ...current.deleteTasks };
            for (const request of requests) {
              deleteTasks[request.remoteId] = removedIds.has(request.remoteId)
                ? { ...request, state: "succeeded", error: null }
                : { ...request, state: "failed", error: failures.get(request.remoteId) ?? "Remote session was not deleted." };
            }
            return {
              ...current,
              items: applyRemoteSessionDeletion(current.items, removedIds),
              deleteTasks,
              deleteBatch: current.deleteBatch ? {
                ...current.deleteBatch,
                completed: current.deleteBatch.completed + requests.length,
                succeeded: current.deleteBatch.succeeded + removedIds.size,
                failed: current.deleteBatch.failed + requests.length - removedIds.size,
              } : null,
            };
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setCache((current) => {
            const deleteTasks = { ...current.deleteTasks };
            for (const request of requests) deleteTasks[request.remoteId] = { ...request, state: "failed", error: message };
            return {
              ...current,
              deleteTasks,
              deleteBatch: current.deleteBatch ? {
                ...current.deleteBatch,
                completed: current.deleteBatch.completed + requests.length,
                failed: current.deleteBatch.failed + requests.length,
              } : null,
            };
          });
        } finally {
          for (const request of requests) activeDeleteIdsRef.current.delete(request.remoteId);
        }
      }
    } finally {
      deleteRunningRef.current = false;
      setCache((current) => ({
        ...current,
        deleteBatch: current.deleteBatch ? { ...current.deleteBatch, running: false } : null,
      }));
    }
  }, []);

  const queueDeletions = useCallback((requests: RemoteSessionDeleteRequest[]): void => {
    const accepted = requests.filter((request) => {
      if (activeDeleteIdsRef.current.has(request.remoteId)) return false;
      activeDeleteIdsRef.current.add(request.remoteId);
      return true;
    });
    if (accepted.length === 0) return;
    const startingNewBatch = !deleteRunningRef.current && deleteQueueRef.current.length === 0;
    deleteQueueRef.current.push(accepted);
    setCache((current) => {
      const deleteTasks = startingNewBatch ? {} : { ...current.deleteTasks };
      for (const request of accepted) deleteTasks[request.remoteId] = { ...request, state: "queued", error: null };
      return {
        ...current,
        deleteTasks,
        deleteBatch: startingNewBatch || !current.deleteBatch?.running
          ? { running: true, total: accepted.length, completed: 0, succeeded: 0, failed: 0 }
          : { ...current.deleteBatch, total: current.deleteBatch.total + accepted.length },
      };
    });
    void drainDeletions();
  }, [drainDeletions]);

  return { cache, ensureLoaded, refresh, invalidate, queueUploads, queueDeletions };
}
