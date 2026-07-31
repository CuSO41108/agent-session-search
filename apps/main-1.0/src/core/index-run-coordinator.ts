export interface IndexRunCoordinator<T> {
  request(run: () => Promise<T>): Promise<T>;
}

export interface IndexRunCoordinatorOptions {
  afterRun?: () => void | Promise<void>;
}

interface DeferredRun<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferredRun<T>(): DeferredRun<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function createIndexRunCoordinator<T>(
  options: IndexRunCoordinatorOptions = {},
): IndexRunCoordinator<T> {
  let active: Promise<T> | null = null;
  let queued: { deferred: DeferredRun<T>; run: () => Promise<T> } | null = null;

  const start = (run: () => Promise<T>, target?: DeferredRun<T>): Promise<T> => {
    let runPromise: Promise<T>;
    try {
      runPromise = run();
    } catch (error) {
      runPromise = Promise.reject(error);
    }
    const completion = options.afterRun ? runPromise.finally(options.afterRun) : runPromise;
    active = completion;
    if (target) completion.then(target.resolve, target.reject);
    void completion.finally(() => {
      if (active !== completion) return;
      active = null;
      const next = queued;
      queued = null;
      if (next) start(next.run, next.deferred);
    }).catch(() => undefined);
    return target?.promise ?? completion;
  };

  return {
    request(run: () => Promise<T>): Promise<T> {
      if (!active) return start(run);
      if (!queued) queued = { deferred: deferredRun<T>(), run };
      return queued.deferred.promise;
    },
  };
}
