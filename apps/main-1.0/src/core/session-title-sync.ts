import { liveSessionPidForSession } from "./session-focus";
import type { LiveSessionSnapshot, SessionSearchResult } from "./types";

export interface SessionTitleSyncDependencies {
  getSession(sessionKey: string): SessionSearchResult | null;
  setCustomTitle(sessionKey: string, title: string | null): void;
  setNativeSessionTitle?(session: SessionSearchResult, title: string): boolean | Promise<boolean>;
  loadLiveSessions(): Promise<LiveSessionSnapshot>;
  setLiveTerminalTitle(pid: number, title: string): Promise<boolean>;
  onSyncError?(error: unknown): void;
}

export async function setSessionCustomTitleAndSyncTerminal(
  sessionKey: string,
  title: string | null,
  dependencies: SessionTitleSyncDependencies,
): Promise<void> {
  if (!dependencies.getSession(sessionKey)) return;

  dependencies.setCustomTitle(sessionKey, title);

  const updated = dependencies.getSession(sessionKey);
  if (!updated || updated.environmentKind !== "local") return;

  if (dependencies.setNativeSessionTitle) {
    try {
      await dependencies.setNativeSessionTitle(updated, updated.displayTitle);
    } catch (error) {
      dependencies.onSyncError?.(error);
    }
  }

  try {
    const snapshot = await dependencies.loadLiveSessions();
    if (snapshot.error) {
      dependencies.onSyncError?.(new Error(snapshot.error));
      return;
    }

    const pid = liveSessionPidForSession(updated, snapshot.sessions);
    if (pid) await dependencies.setLiveTerminalTitle(pid, updated.displayTitle);
  } catch (error) {
    dependencies.onSyncError?.(error);
  }
}
