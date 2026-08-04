export interface LatestTaskQueue<T> {
  request(task: () => Promise<T>): Promise<T>;
}

interface PendingTask<T> {
  task: () => Promise<T>;
  waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }>;
}

export function createLatestTaskQueue<T>(): LatestTaskQueue<T> {
  let running = false;
  let pending: PendingTask<T> | null = null;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const current = pending;
        pending = null;
        try {
          const result = await current.task();
          for (const waiter of current.waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of current.waiters) waiter.reject(error);
        }
      }
    } finally {
      running = false;
      if (pending) void drain();
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
        void drain();
      });
    },
  };
}
