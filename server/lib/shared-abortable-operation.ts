interface SharedEntry<T> {
  readonly controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  settled: boolean;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

/**
 * Coalesces identical work while giving every caller an independent abort.
 * The underlying operation is cancelled only after its final subscriber leaves.
 */
export function createSharedAbortableOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): (signal?: AbortSignal) => Promise<T> {
  let current: SharedEntry<T> | null = null;

  const createEntry = (previous: SharedEntry<T> | null): SharedEntry<T> => {
    const entry: SharedEntry<T> = {
      controller: new AbortController(),
      promise: Promise.resolve(undefined as T),
      subscribers: 0,
      settled: false,
    };
    const ready = previous
      ? previous.promise.then(() => undefined, () => undefined)
      : Promise.resolve();
    entry.promise = ready
      .then(() => operation(entry.controller.signal))
      .finally(() => {
        entry.settled = true;
        if (current === entry) current = null;
      });
    return entry;
  };

  return (signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!current || (current.controller.signal.aborted && current.subscribers === 0)) {
      current = createEntry(current);
    }
    const entry = current;
    entry.subscribers += 1;

    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const release = (): void => {
        entry.subscribers = Math.max(0, entry.subscribers - 1);
        if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
      };
      const finish = (callback: () => void): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        release();
        callback();
      };
      const onAbort = (): void => finish(() => reject(abortReason(signal!)));
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  };
}
