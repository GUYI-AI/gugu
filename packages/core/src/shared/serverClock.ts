/**
 * @@@server-clock — this runtime's reading of the backend's clock. A device clock can be hours off (a PC 4 h 17 min
 * fast), while tickets, signed URLs, OAuth attempts and row stamps carry absolute times issued by the backend (or by
 * another device). Comparing those with `Date.now()` turns every skew larger than the lifetime into "already expired"
 * or "never expires". Compare them with `serverNow()`; durations, timers and anything stamped on this device stay on
 * `Date.now()`. Display keeps the local clock and time zone.
 *
 * Reading: every answer from our backend carries `Date` (whole seconds, rounded down). The backend wrote it at some
 * local moment between sending and receiving, so offset = server − local lies in [Date − received, Date + 1 s − sent].
 * The true offset lies in every such interval: keep their intersection. A slow answer is a wide interval and can only
 * leave the estimate where it is; quick answers narrow it to about the 1 s granularity. An answer whose interval misses
 * the kept one means this device's clock was set (or drifted) since: start again from that answer. Before any answer
 * the offset is 0 — the local clock is all there is.
 *
 * One clock per runtime (renderer, main process, headless host, phone runtime). Each samples its own answers: the
 * renderer only sees `Date` where the backend exposes it to cross-origin pages (PostgREST does; edge functions and
 * GoTrue do not), the Node-side runtimes see it on every answer. The iOS native host keeps the same rule in
 * `GuguServerClock` (GuguIOSCloudBroker.swift).
 */
export type ServerClock = {
  /** The backend's clock now, in epoch ms. */
  now(): number
  /** One answer: its `Date` header and the local times the request went out and the answer came back. */
  observe(date: string | null | undefined, sentAt: number, receivedAt: number): void
}

export function createServerClock(localNow: () => number = () => Date.now()): ServerClock {
  let low = 0
  let high = 0
  let known = false
  return {
    now: () => localNow() + (known ? (low + high) / 2 : 0),
    observe(date, sentAt, receivedAt) {
      const at = Date.parse(date ?? '')
      if (!Number.isFinite(at) || receivedAt < sentAt) return
      const from = at - receivedAt
      const to = at + 1_000 - sentAt
      if (known && from <= high && to >= low) {
        low = Math.max(low, from)
        high = Math.min(high, to)
      } else {
        low = from
        high = to
        known = true
      }
    },
  }
}

const runtimeClock = createServerClock()

/** The backend's clock now (epoch ms), for comparing with times the backend or another device issued. */
export function serverNow(): number {
  return runtimeClock.now()
}

// Storage objects are cacheable (an HTTP cache replays an old `Date`); these answers are not.
const SAMPLED_PATHS = ['/rest/v1/', '/functions/v1/', '/auth/v1/']

function requestPath(input: unknown): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: unknown } | null)?.url
  try {
    return typeof url === 'string' ? new URL(url).pathname : ''
  } catch {
    return ''
  }
}

/** A fetch to our backend that also reads each answer's `Date` into this runtime's clock. */
export function withServerClock<A extends [unknown, ...unknown[]], R extends { headers?: { get(name: string): string | null } }>(
  fetchImpl: (...args: A) => Promise<R>,
  clock: ServerClock = runtimeClock,
): (...args: A) => Promise<R> {
  return async (...args) => {
    const sentAt = Date.now()
    const response = await fetchImpl(...args)
    if (SAMPLED_PATHS.some((path) => requestPath(args[0]).includes(path))) {
      clock.observe(response.headers?.get('date'), sentAt, Date.now())
    }
    return response
  }
}
