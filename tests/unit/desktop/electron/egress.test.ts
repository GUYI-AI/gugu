import { createServer, type Server } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { Request as UndiciRequest } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEgress, EgressError, egressErrorText, type EgressBackend } from '@gugu/core/shared/egress'
import { nodeEgressBackend } from '../../../../apps/desktop/electron/egress/node'
import { cachedProxyAnswers, chromiumRoutes, envRoutes, installProxyRoutes, parseProxyAnswer, proxyEndpoints } from '../../../../apps/desktop/electron/egress/proxy-route'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as { port: number }).port
}
function nodeTransport(routes: Parameters<typeof nodeEgressBackend>[0]['routes'], ca?: string[], keepAliveTimeoutMs?: number) {
  const backend = nodeEgressBackend({ name: 'test-node', routes, ca, keepAliveTimeoutMs })
  cleanups.push(() => backend.closeConnections?.())
  return createEgress(backend)
}

// Test-only self-signed identity for localhost and 127.0.0.1 (trusted only through the transport's `ca` in these tests).
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUMa+hP4AL/6IIX93lsJj2uG+i1qQwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExOTE3MTIwM1oYDzIxMjYxMDI2
MTcxMjAzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT0qMbUq9Y79Rh9LqJ8CezK69M0AhQIsTxD3S+diJQHWluslh+697nr
urAEXst/HqNET6cg/Gn2a64p896Vpn5Ao28wbTAdBgNVHQ4EFgQUUK+rYl1+HQsU
FsawkWWB5o0IIFkwHwYDVR0jBBgwFoAUUK+rYl1+HQsUFsawkWWB5o0IIFkwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIhAOTChybn3aIT2YcpTMm0UpDVlDExdoh0R+OatS4qtd2EAiAw
pZieFsfnFyMpjIga3WShZZgJ9PclN//iSMt6vqJWng==
-----END CERTIFICATE-----`
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgM7tYU7yasr1GbXNw
CHDXxHavN2N2/E5h71Wuu4hu2bihRANCAAT0qMbUq9Y79Rh9LqJ8CezK69M0AhQI
sTxD3S+diJQHWluslh+697nrurAEXst/HqNET6cg/Gn2a64p896Vpn5A
-----END PRIVATE KEY-----`

/** Minimal no-auth SOCKS5 CONNECT proxy (IPv4 and domain targets); counts tunnels. */
async function socks5(): Promise<{ port: number; tunnels: () => number }> {
  let tunnels = 0
  const open = new Set<Socket>()
  const server = createTcpServer((client: Socket) => {
    open.add(client); client.on('close', () => open.delete(client))
    client.once('data', () => {
      client.write(Buffer.from([5, 0]))
      client.once('data', (request: Buffer) => {
        const type = request[3]
        const host = type === 1 ? [...request.subarray(4, 8)].join('.') : request.subarray(5, 5 + request[4]!).toString()
        const port = request.readUInt16BE(request.length - 2)
        const upstream = connect(port, host, () => {
          tunnels++
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          upstream.pipe(client); client.pipe(upstream)
        })
        upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy())
        client.on('close', () => upstream.destroy())
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { for (const client of open) client.destroy(); server.close(() => resolve()) }))
  return { port: (server.address() as { port: number }).port, tunnels: () => tunnels }
}

describe('egress contract on a real Node transport', () => {
  it('formats proxy context without credentials and keeps explicit ports and fallback ambiguity', () => {
    const selected = proxyEndpoints(parseProxyAnswer('PROXY proxy.test:80; SOCKS5 [::1]:1080; DIRECT'))
    expect(selected).toEqual(['http://proxy.test:80', 'socks5://[::1]:1080'])
    expect(egressErrorText({ kind: 'proxy-auth', proxies: selected })).toContain('系统代理之一：http://proxy.test:80、socks5://[::1]:1080')
  })

  it('takes desktop routes from Chromium only and keeps proxy credentials out of host routes', async () => {
    const routes = chromiumRoutes(async () => 'PROXY dead.test:1; PROXY proxy.test:1234; HTTPS proxy.test:1234; DIRECT')
    expect(await routes('https://cloud.test')).toEqual([
      { kind: 'http', host: 'dead.test', port: 1 }, { kind: 'http', host: 'proxy.test', port: 1234 },
      { kind: 'https', host: 'proxy.test', port: 1234 }, { kind: 'direct' },
    ])
    expect(await routes('https://127.0.0.1:1234')).toEqual([{ kind: 'direct' }])
    const env = { HTTPS_PROXY: 'http://user:pa%3Ass@proxy.test:1234' }
    expect(await envRoutes(env)('https://cloud.test')).toEqual([{ kind: 'http', host: 'proxy.test', port: 1234 }])
    // A harness's own environment keeps the URL's credentials, as its CLI would (fetchWithEnv).
    expect(await envRoutes(env, { withCredentials: true })('https://cloud.test')).toEqual([{ kind: 'http', host: 'proxy.test', port: 1234, username: 'user', password: 'pa:ss' }])
    expect(await envRoutes({ ...env, NO_PROXY: '*' })('https://cloud.test')).toEqual([{ kind: 'direct' }])
    await expect(envRoutes({ HTTPS_PROXY: 'http://[' })('https://cloud.test')).rejects.toThrow('Invalid environment proxy')
  })

  it('fails an install visibly when the system proxy is one the installer cannot use', async () => {
    const { installerEnvironment } = await import('../../../../apps/desktop/electron/egress/installer')
    installProxyRoutes(async () => [{ kind: 'socks5', host: '127.0.0.1', port: 1080 }])
    try {
      await expect(installerEnvironment('https://registry.example/', { PATH: '/bin' })).rejects.toThrow('SOCKS5')
      // An explicit user proxy wins, whatever the system proxy is.
      expect(await installerEnvironment('https://registry.example/', { HTTPS_PROXY: 'http://user.proxy:3128' })).toMatchObject({ HTTPS_PROXY: 'http://user.proxy:3128' })
      installProxyRoutes(async () => [{ kind: 'http', host: 'sys.proxy', port: 8080 }])
      expect(await installerEnvironment('https://registry.example/', { PATH: '/bin' })).toMatchObject({ HTTPS_PROXY: 'http://sys.proxy:8080/', NO_PROXY: 'localhost,127.0.0.1,::1' })
    } finally { installProxyRoutes(envRoutes()) }
  })

  it('keeps one proxy answer per origin for the window, then asks again; failures and clear() are not kept', async () => {
    let clock = 0
    const ask = vi.fn(async (url: string) => (url.includes('fail') ? Promise.reject(new Error('resolver')) : 'PROXY p.test:1'))
    const answers = cachedProxyAnswers(ask, 5_000, () => clock)
    await answers.resolve('https://cloud.test/a')
    await answers.resolve('https://cloud.test/b?q=1')
    await answers.resolve('wss://cloud.test/realtime')
    await answers.resolve('https://cloud.test:8443/')
    expect(ask.mock.calls.map(([url]) => url)).toEqual(['https://cloud.test/a', 'wss://cloud.test/realtime', 'https://cloud.test:8443/'])
    clock = 5_000
    await answers.resolve('https://cloud.test/c')
    expect(ask).toHaveBeenCalledTimes(4)
    answers.clear()
    await answers.resolve('https://cloud.test/d')
    expect(ask).toHaveBeenCalledTimes(5)
    await expect(answers.resolve('https://fail.test/')).rejects.toThrow('resolver')
    await expect(answers.resolve('https://fail.test/')).rejects.toThrow('resolver')
    expect(ask).toHaveBeenCalledTimes(7)
  })

  it('keeps idle TLS connections through a SOCKS5 proxy open and sends the origin SNI', async () => {
    const names: unknown[] = []
    const server = createTlsServer({ cert: TEST_CERT, key: TEST_KEY }, (request, response) => {
      names.push((request.socket as unknown as { servername?: unknown }).servername)
      response.end('ok')
    })
    server.keepAliveTimeout = 60_000
    const port = await listen(server as unknown as Server)
    const sockets = new WebSocketServer({ server: server as unknown as Server })
    cleanups.push(() => new Promise<void>(resolve => { for (const socket of sockets.clients) socket.terminate(); sockets.close(() => resolve()) }))
    const proxy = await socks5()
    const transport = nodeTransport(async () => [{ kind: 'socks5', host: '127.0.0.1', port: proxy.port }], [TEST_CERT], 60_000) // desktop's pool setting
    const socket = transport.webSocket(`wss://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    expect(await (await transport.fetch(`https://localhost:${port}/`)).text()).toBe('ok')
    // A CDN picks its certificate by SNI: the tunnelled TLS hello must name the origin.
    expect(names).toEqual(['localhost'])
    // Idle past both connect bounds (5 s socket, 10 s fetch): open connections must not be torn down by them.
    await new Promise(resolve => setTimeout(resolve, 10_500))
    const message = new Promise<unknown>((resolve, reject) => {
      socket.addEventListener('message', event => resolve(event.data), { once: true })
      socket.addEventListener('close', () => reject(new Error('closed while idle')), { once: true })
    })
    for (const client of sockets.clients) client.send('still here')
    expect(await message).toBe('still here')
    expect(await (await transport.fetch(`https://localhost:${port}/`)).text()).toBe('ok')
    expect(proxy.tunnels()).toBe(2)
    socket.close()
  }, 20_000)

  it('reaches a local process through loopbackFetch and refuses anything that is not loopback', async () => {
    const { loopbackFetch } = await import('@gugu/core/local/loopback')
    const port = await listen(createServer((request, response) => { response.writeHead(201, { 'x-seen': request.method ?? '' }); response.end('{"id":"ses_1"}') }))
    const response = await loopbackFetch(`http://127.0.0.1:${port}/session/a/fork`, { method: 'POST' })
    expect(response.status).toBe(201)
    expect(response.headers.get('x-seen')).toBe('POST')
    expect(await response.json()).toEqual({ id: 'ses_1' })
    await expect(loopbackFetch('http://example.test/')).rejects.toThrow('loopback')
  })

  it('delivers a WebSocket welcome sent in the same packet as the upgrade', async () => {
    const server = createServer()
    const port = await listen(server)
    const sockets = new WebSocketServer({ server })
    sockets.on('connection', socket => socket.send('welcome'))
    cleanups.push(() => new Promise<void>(resolve => { for (const socket of sockets.clients) socket.terminate(); sockets.close(() => resolve()) }))
    const socket = nodeTransport(async () => [{ kind: 'direct' }]).webSocket(`ws://127.0.0.1:${port}`)
    const first = await new Promise<unknown>((resolve, reject) => {
      socket.addEventListener('message', event => resolve(event.data), { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    socket.close()
    expect(first).toBe('welcome')
  })

  it('keeps the caller cancellation connected after response headers', async () => {
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n')
    }))
    const abort = new AbortController()
    const transport = nodeTransport(async () => [{ kind: 'direct' }])
    const response = await transport.fetch(`http://127.0.0.1:${port}`, { signal: abort.signal })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    abort.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('normalizes a truncated response body and preserves response metadata through clones', async () => {
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-length': '100' })
      response.end('short')
    }))
    const response = await nodeTransport(async () => [{ kind: 'direct' }]).fetch(`http://127.0.0.1:${port}/stream`)
    const copy = response.clone()
    expect(copy.url).toBe(response.url)
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'EgressError', kind: 'connect' })
    await expect(copy.arrayBuffer()).rejects.toMatchObject({ name: 'EgressError', kind: 'connect' })
  })

  it('uses the proxy for a host that cannot resolve directly, including ordered fallback', async () => {
    const upstream = await listen(createServer((_request, response) => response.end('through proxy')))
    const sockets = new Set<Duplex>()
    const proxy = createServer()
    proxy.on('connect', (_request, client, head) => {
      const server = connect(upstream, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) server.write(head)
        client.pipe(server).pipe(client)
      })
      sockets.add(server); sockets.add(client)
      server.on('error', () => client.destroy())
    })
    const port = await listen(proxy)
    cleanups.push(() => { for (const socket of sockets) socket.destroy() })
    const transport = nodeTransport(async () => [{ kind: 'http', host: '127.0.0.1', port: 1 }, { kind: 'http', host: '127.0.0.1', port }])
    expect(await (await transport.fetch('http://unresolvable.invalid/data')).text()).toBe('through proxy')
  })

  it('reports proxy authentication for both HTTP and WebSocket', async () => {
    const proxy = createServer()
    proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'))
    const port = await listen(proxy)
    const transport = nodeTransport(async () => [{ kind: 'http', host: '127.0.0.1', port, username: 'private-user', password: 'private-password' }])
    await expect(transport.fetch('https://unresolvable.invalid/')).rejects.toMatchObject({ kind: 'proxy-auth', proxies: [`http://127.0.0.1:${port}`] })
    const socket = transport.webSocket('wss://unresolvable.invalid/')
    const error = await new Promise<unknown>(resolve => socket.addEventListener('error', event => resolve((event as Event & { error: unknown }).error), { once: true }))
    expect(error).toMatchObject({ kind: 'proxy-auth', proxies: [`http://127.0.0.1:${port}`] })
    expect((error as Error).message).toContain(`http://127.0.0.1:${port}`)
    expect((error as Error).message).not.toContain('private-')
    expect(socket.readyState).toBe(socket.CLOSED)
  })

  it('falls back when a proxy accepts CONNECT but never answers, even without a header deadline', { timeout: 25_000 }, async () => {
    const upstream = await listen(createServer((_request, response) => response.end('fallback reached')))
    const stalled = new Set<Duplex>()
    const proxy = createServer()
    proxy.on('connect', (_request, socket) => { stalled.add(socket); socket.on('error', () => {}) })
    const port = await listen(proxy)
    cleanups.push(() => { for (const socket of stalled) socket.destroy() })
    const transport = nodeTransport(async () => [{ kind: 'http', host: '127.0.0.1', port }, { kind: 'direct' }])
    expect(await (await transport.fetch(`http://127.0.0.1:${upstream}`, { timeoutMs: 0 })).text()).toBe('fallback reached')
  })

  it('does not replay a POST whose origin applied it before returning a broken HTTP response', async () => {
    let applied = 0, replayed = 0
    const broken = await listen(createServer((request, response) => {
      request.resume()
      request.once('end', () => { applied++; response.socket!.end('HTTP/1.1 200 OK\r\nInvalid Header\r\n\r\n') })
    }))
    const destination = await listen(createServer((_request, response) => { replayed++; response.end('duplicate') }))
    const tunnels = new Set<Duplex>()
    const proxy = createServer()
    proxy.on('connect', (_request, client) => {
      const socket = connect(broken, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.pipe(socket).pipe(client) })
      tunnels.add(client); tunnels.add(socket)
      socket.on('error', () => client.destroy())
    })
    const port = await listen(proxy)
    cleanups.push(() => { for (const socket of tunnels) socket.destroy() })
    const transport = nodeTransport(async () => [{ kind: 'http', host: '127.0.0.1', port }, { kind: 'direct' }])
    await expect(transport.fetch(`http://127.0.0.1:${destination}`, { method: 'POST', body: '{"action":"apply"}' })).rejects.toMatchObject({ kind: 'connect' })
    expect(applied).toBe(1)
    expect(replayed).toBe(0)
  })

  it('rejects non-network schemes before invoking a backend', async () => {
    const transport = nodeTransport(async () => [{ kind: 'direct' }])
    await expect(transport.fetch('file:///tmp/private')).rejects.toThrow('HTTP or HTTPS')
    await expect(transport.fetch('https://example.test', { redirect: 'manual' })).rejects.toThrow('manual redirects')
    await expect(transport.fetch(new Request('https://example.test', { redirect: 'manual' }))).rejects.toThrow('manual redirects')
    await expect(transport.fetch(new UndiciRequest('https://example.test', { redirect: 'manual' }) as unknown as Request)).rejects.toThrow('manual redirects')
    expect(() => transport.webSocket('https://example.test')).toThrow('WS or WSS')
  })

  it('preserves cancellation carried by another runtime Request class', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const backend: EgressBackend = {
      name: 'pending-request', fetch: () => new Promise(() => {}), classify: () => null,
      webSocket: () => { throw new Error('No socket in this test') },
    }
    const request = new UndiciRequest('https://example.test', { signal: abort.signal }) as unknown as Request
    const rejected = expect(createEgress(backend).fetch(request, { timeoutMs: 50 })).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await vi.advanceTimersByTimeAsync(50)
    await rejected
  })

  it('bounds an unresolved WebSocket route and exposes an EgressError on the error event', async () => {
    vi.useFakeTimers()
    const backend: EgressBackend = {
      name: 'pending-proxy', fetch: async () => new Response(), classify: () => null,
      webSocket: () => new Promise(() => {}),
    }
    const socket = createEgress(backend).webSocket('wss://example.test', { handshakeTimeoutMs: 50 })
    const failed = new Promise<unknown>(resolve => socket.addEventListener('error', event => resolve((event as Event & { error: unknown }).error)))
    await vi.advanceTimersByTimeAsync(50)
    const error = await failed
    expect(error).toBeInstanceOf(EgressError)
    expect(error).toMatchObject({ kind: 'timeout', host: 'example.test' })
    expect(socket.readyState).toBe(socket.CLOSED)
  })

  it('includes asynchronous proxy lookup in the HTTP header deadline', async () => {
    vi.useFakeTimers()
    const transport = nodeTransport(() => new Promise(() => {}))
    const checked = expect(transport.fetch('https://example.test', { timeoutMs: 50 })).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await checked
  })

  it('never uses a configured proxy for a loopback endpoint', async () => {
    const routes = envRoutes({ HTTPS_PROXY: 'http://proxy.invalid:1234', NO_PROXY: 'existing.test' })
    expect(await routes('https://127.0.0.2:1234')).toEqual([{ kind: 'direct' }])
    expect(await routes('https://[::1]:1234')).toEqual([{ kind: 'direct' }])
    expect(parseProxyAnswer('PROXY dead.test:1;HTTPS live.test:2;DIRECT')).toEqual([
      { kind: 'http', host: 'dead.test', port: 1 }, { kind: 'https', host: 'live.test', port: 2 }, { kind: 'direct' },
    ])
    expect(() => parseProxyAnswer('UNSUPPORTED somewhere:1')).toThrow()
    const scoped = envRoutes({ HTTPS_PROXY: 'http://proxy.invalid:1234', NO_PROXY: 'private.test:443' })
    expect(await scoped('https://private.test')).toEqual([{ kind: 'direct' }])
    expect((await scoped('https://private.test:444'))[0]?.kind).toBe('http')
    expect((await scoped('https://127.evil.test'))[0]?.kind).toBe('http')
  })
})
