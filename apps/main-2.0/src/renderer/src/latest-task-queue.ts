export interface LatestTaskQueue<T> {
  request(task: () => Promise<T>): Promise<T>;
}

export interface LatestTaskQueueOptions {
  settleMs?: number;
}

interface PendingTask<T> {
  task: () => Promise<T>;
  waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }>;
}

export function createLatestTaskQueue<T>(options: LatestTaskQueueOptions = {}): LatestTaskQueue<T> {
  const settleMs = Math.max(0, options.settleMs ?? 0);
  let running = false;
  let pending: PendingTask<T> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleDrain = (): void => {
    if (running || !pending) return;
    if (settleTimer) clearTimeout(settleTimer);
    if (settleMs === 0) {
      void drain();
      return;
    }
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void drain();
    }, settleMs);
  };

  const drain = async (): Promise<void> => {
    if (running) return;
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    running = true;
    try {
      const current = pending;
      pending = null;
      if (!current) return;
      try {
        const result = await current.task();
        for (const waiter of current.waiters) waiter.resolve(result);
      } catch (error) {
        for (const waiter of current.waiters) waiter.reject(error);
      }
    } finally {
      running = false;
      scheduleDrain();
    }
  };

  return {
    request(task) {
      return new Promise<T>((resolve, reject) => {
        if (pending) {
          pending.task = task;
          pending.waiters.push({ resolve, reject });
        } else {
          pending = { task, waiters: [{ resolve, reject }] };
        }
        scheduleDrain();
      });
    },
  };
}
