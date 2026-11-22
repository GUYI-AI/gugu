import { createEgress, type Egress } from '../egress'

/** Browser runtimes already own their proxy and certificate policy. */
export function runtimeEgress(): Egress {
  return createEgress({
    name: 'runtime',
    fetch: (input, init) => globalThis.fetch(input, init),
    webSocket: (url, { protocols }) => new globalThis.WebSocket(url, protocols),
    classify: error => error instanceof TypeError && /fetch failed|failed to fetch|network request failed|networkerror|load failed/i.test(error.message) ? 'connect' : null,
  })
}
