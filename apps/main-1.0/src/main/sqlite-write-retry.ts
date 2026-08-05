export interface SqliteWriteRetryOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  delay?: (delayMs: number) => Promise<void>;
}

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & { errcode?: unknown; errstr?: unknown };
  return details.errcode === 5
    || /database is (?:locked|busy)/i.test(`${error.message} ${String(details.errstr ?? "")}`);
}

export async function retrySqliteWrite<T>(
  write: () => T | Promise<T>,
  options: SqliteWriteRetryOptions = {},
): Promise<T> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000);
  const maxDelayMs = Math.max(1, options.maxDelayMs ?? 100);
  let delayMs = Math.max(1, Math.min(maxDelayMs, options.initialDelayMs ?? 10));
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((waitMs) => new Promise<void>((resolve) => setTimeout(resolve, waitMs)));
  const startedAt = now();

  while (true) {
    try {
      return await write();
    } catch (error) {
      if (!isSqliteBusyError(error) || now() - startedAt >= timeoutMs) throw error;
      await delay(delayMs);
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    }
  }
}
