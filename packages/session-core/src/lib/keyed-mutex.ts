type Waiter = () => void;

export class KeyedMutex {
  private readonly queues = new Map<string, Set<Waiter>>();

  /**
   * Runs `fn` exclusively for `key` in acquisition order. Different keys run
   * independently, and a rejection releases the lock.
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Acquires a lease that can cross stages. Cancellation removes a queued waiter. */
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const held = this.queues.get(key);
    if (!held) {
      const queue = new Set<Waiter>();
      this.queues.set(key, queue);
      return this.lease(key, queue);
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        held.delete(admit);
        reject(signal?.reason);
      };
      const admit = () => {
        signal?.removeEventListener('abort', onAbort);
        held.delete(admit);
        resolve(this.lease(key, held));
      };
      held.add(admit);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private lease(key: string, queue: Set<Waiter>): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.values().next().value;
      if (next) next();
      else this.queues.delete(key);
    };
  }
}
