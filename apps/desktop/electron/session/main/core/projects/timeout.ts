/** A leaf module: what projects/utils pulls in (the session manager, the database) must not come with a timeout. */
export class TimeoutSignal extends Error {
  constructor(readonly ms: number) {
    super(`Operation timed out after ${ms}ms`);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
