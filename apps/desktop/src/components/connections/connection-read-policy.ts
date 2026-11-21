/** How long a connection read waits before it is asked again after `failures` failures (backoff, at most 30 s). */
export const connectionReadDelay = (failures: number) => Math.min(30_000,1000 * 2 ** Math.min(failures,5))
