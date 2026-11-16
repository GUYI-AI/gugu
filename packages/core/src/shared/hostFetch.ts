/**
 * The one fetch a host process uses for every network request.
 *
 * The desktop main process installs Electron's `net.fetch` here once the app is ready: it goes through
 * Chromium's network stack, so it honors the system proxy (and its bypass list, PAC included) and the system
 * certificate store, and it shares Chromium's connection pool. Node's global fetch (undici) does none of that.
 * A user behind a system-only proxy could sign in and chat, while every request the host made with the global
 * fetch failed, the Gugu tools of every agent among them.
 *
 * Until something is installed (and in the renderer, mobile and a headless server, where nothing is), this is
 * the runtime's own global fetch, read at call time.
 *
 * Product code in host trees never names the global `fetch`; lint (`no-restricted-globals`) holds that.
 */
let installed: typeof globalThis.fetch | null = null

export function installHostFetch(impl: typeof globalThis.fetch): void {
  installed = impl
}

// eslint-disable-next-line no-restricted-properties -- the one place that reads the runtime's own fetch
export const hostFetch: typeof globalThis.fetch = (input, init) => (installed ?? globalThis.fetch)(input, init)
