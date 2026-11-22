import { X509Certificate } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { Request as UndiciRequest } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEgress, egressErrorText, type EgressBackend } from '@gugu/core/shared/egress'
import { nodeEgressBackend } from '../../../../apps/desktop/electron/egress/node'
import { cachedProxyAnswers, chromiumRoutes, envRoutes, installProxyRoutes, parseProxyAnswer } from '../../../../apps/desktop/electron/egress/proxy-route'

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
function nodeTransport(routes: Parameters<typeof nodeEgressBackend>[0]['routes'], ca?: string[], keepAliveTimeoutMs?: number, connectTimeoutMs?: number) {
  const backend = nodeEgressBackend({ name: 'test-node', routes, ca, keepAliveTimeoutMs, connectTimeoutMs })
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

// A second self-signed identity for the same names, trusted nowhere.
const OTHER_CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUcUpq1c0sUdAISkY24X1nbCniiA4wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyMjEwMTk1MloYDzIxMjYxMDI5
MTAxOTUyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARqCo3bbVLADIuPgqUkHP6ibPE1pKE7JioXm9l2KdqYSQI8sG7/ZW3j
/f457Xw5TNfQ5xAlEaxGfg31aVyCBXXgo28wbTAdBgNVHQ4EFgQUFm3BG0OaG/NG
oqjnKxkwC4XXDoEwHwYDVR0jBBgwFoAUFm3BG0OaG/NGoqjnKxkwC4XXDoEwGgYD
VR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZI
zj0EAwIDSAAwRQIhAPbieCiSY+x6S8B7Qmx9841RawcNTDvSy0SGEg//eZHFAiAG
CamvNBzKWCtN6z/ZARb0XI+3VUCEFH3U8ABNzUSu9w==
-----END CERTIFICATE-----`
const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMw2Ze+J/SpYIZ1p4
eRv2rnkOc9PQrHfinnQ0xrJPbQOhRANCAARqCo3bbVLADIuPgqUkHP6ibPE1pKE7
JioXm9l2KdqYSQI8sG7/ZW3j/f457Xw5TNfQ5xAlEaxGfg31aVyCBXXg
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
  it('uses the first proxy entry it speaks, as VS Code does, and refuses an answer with none', () => {
    expect(parseProxyAnswer('PROXY proxy.test:80; SOCKS5 [::1]:1080; DIRECT')).toBe('http://proxy.test:80')
    expect(parseProxyAnswer('SOCKS4 old.test:1080; SOCKS [::1]:1080')).toBe('socks5://[::1]:1080')
    expect(parseProxyAnswer('DIRECT')).toBeNull()
    expect(() => parseProxyAnswer('QUIC proxy.test:443')).toThrow('Unsupported proxy configuration')
    expect(() => parseProxyAnswer('PROXY proxy.test')).toThrow('Invalid proxy endpoint')
  })

  it('takes desktop routes from Chromium only and keeps proxy credentials out of host routes', async () => {
    const routes = chromiumRoutes(async () => 'PROXY proxy.test:1234; HTTPS proxy.test:1234; DIRECT')
    expect(await routes('https://cloud.test')).toBe('http://proxy.test:1234')
    expect(await routes('https://127.0.0.1:1234')).toBeNull()
    const env = { HTTPS_PROXY: 'http://user:pa%3Ass@proxy.test:1234' }
    expect(await envRoutes(env)('https://cloud.test')).toBe('http://proxy.test:1234')
    // A harness's own environment keeps the URL's credentials, as its CLI would (fetchWithEnv).
    expect(await envRoutes(env, { withCredentials: true })('https://cloud.test')).toBe('http://user:pa%3Ass@proxy.test:1234')
    expect(await envRoutes({ ALL_PROXY: 'socks5h://proxy.test:1080' })('https://cloud.test')).toBe('socks5://proxy.test:1080')
    expect(await envRoutes({ ...env, NO_PROXY: '*' })('https://cloud.test')).toBeNull()
    await expect(envRoutes({ HTTPS_PROXY: 'http://[' })('https://cloud.test')).rejects.toThrow('Invalid environment proxy')
  })

  it('gives an install the system HTTP proxy and the OS certificate store, and never overrides the user', async () => {
    const { installerEnvironment } = await import('../../../../apps/desktop/electron/egress/installer')
    installProxyRoutes(async () => 'http://sys.proxy:8080')
    try {
      expect(await installerEnvironment('https://registry.example/', { PATH: '/bin' })).toMatchObject({ HTTPS_PROXY: 'http://sys.proxy:8080', NO_PROXY: 'localhost,127.0.0.1,::1', NODE_USE_SYSTEM_CA: '1' })
      // An explicit user proxy wins, whatever the system proxy is.
      expect(await installerEnvironment('https://registry.example/', { HTTPS_PROXY: 'http://user.proxy:3128' })).toMatchObject({ HTTPS_PROXY: 'http://user.proxy:3128' })
      // The installer speaks HTTP proxies only: a SOCKS system proxy fills nothing.
      installProxyRoutes(async () => 'socks5://127.0.0.1:1080')
      expect(await installerEnvironment('https://registry.example/', { PATH: '/bin' })).not.toHaveProperty('HTTPS_PROXY')
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
    // Desktop's pool setting; the connect bound is shortened from 10 s so the idle wait below can pass it quickly.
    const transport = nodeTransport(async () => `socks5://127.0.0.1:${proxy.port}`, [TEST_CERT], 60_000, 300)
    const socket = transport.webSocket(`wss://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    expect(await (await transport.fetch(`https://localhost:${port}/`)).text()).toBe('ok')
    // A CDN picks its certificate by SNI: the tunnelled TLS hello must name the origin.
    expect(names).toEqual(['localhost'])
    // Idle past the connect bound: open connections must not be torn down by it.
    await new Promise(resolve => setTimeout(resolve, 600))
    const message = new Promise<unknown>((resolve, reject) => {
      socket.addEventListener('message', event => resolve(event.data), { once: true })
      socket.addEventListener('close', () => reject(new Error('closed while idle')), { once: true })
    })
    for (const client of sockets.clients) client.send('still here')
    expect(await message).toBe('still here')
    expect(await (await transport.fetch(`https://localhost:${port}/`)).text()).toBe('ok')
    expect(proxy.tunnels()).toBe(2)
    socket.close()
  })

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
    const socket = nodeTransport(async () => null).webSocket(`ws://127.0.0.1:${port}`)
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
    const transport = nodeTransport(async () => null)
    const response = await transport.fetch(`http://127.0.0.1:${port}`, { signal: abort.signal })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    abort.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('normalizes a truncated response body and preserves response metadata through clones', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': '100' })
      response.end('short')
    })
    // The body ends short when the server drops the connection; don't hold it for Node's default 5 s keep-alive.
    server.keepAliveTimeout = 50
    const port = await listen(server)
    const response = await nodeTransport(async () => null).fetch(`http://127.0.0.1:${port}/stream`)
    const copy = response.clone()
    expect(copy.url).toBe(response.url)
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'EgressError', kind: 'connect' })
    await expect(copy.arrayBuffer()).rejects.toMatchObject({ name: 'EgressError', kind: 'connect' })
  })

  it('uses the proxy for a host that cannot resolve directly', async () => {
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
    const transport = nodeTransport(async () => `http://127.0.0.1:${port}`)
    expect(await (await transport.fetch('http://unresolvable.invalid/data')).text()).toBe('through proxy')
  })

  it('reports proxy authentication and an unreachable proxy as the proxy, without credentials', async () => {
    const proxy = createServer()
    proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'))
    const port = await listen(proxy)
    const transport = nodeTransport(async () => `http://127.0.0.1:${port}`)
    const failure = await transport.fetch('https://unresolvable.invalid/').catch((error: unknown) => error)
    expect(failure).toMatchObject({ kind: 'proxy-auth', message: egressErrorText('proxy-auth') })
    const closed = await listen(createServer())
    await cleanups.pop()?.()
    await expect(nodeTransport(async () => `http://127.0.0.1:${closed}`).fetch('https://unresolvable.invalid/')).rejects.toMatchObject({ kind: 'proxy' })
  })

  it('returns a redirect as the answer with manual redirects, without following it', async () => {
    let hits = 0
    const port = await listen(createServer((_req, res) => { hits++; res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }).end() }))
    const transport = nodeTransport(async () => null)
    const response = await transport.fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://127.0.0.1:9/elsewhere')
    expect(hits).toBe(1)
  })

  it('rejects non-network schemes before invoking a backend', async () => {
    const transport = nodeTransport(async () => null)
    await expect(transport.fetch('file:///tmp/private')).rejects.toThrow('HTTP or HTTPS')
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

  it('fails a WebSocket still opening at the handshake deadline and logs it as a timeout', async () => {
    const stalled = new Set<Socket>()
    const server = createTcpServer(socket => { stalled.add(socket); socket.on('error', () => {}) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => { for (const socket of stalled) socket.destroy(); server.close(() => resolve()) }))
    const log = vi.fn()
    const backend = nodeEgressBackend({ name: 'test-node', routes: async () => null, log })
    cleanups.push(() => backend.closeConnections())
    const socket = createEgress(backend).webSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, { handshakeTimeoutMs: 200 })
    const closed = await new Promise<number>(resolve => socket.addEventListener('close', () => resolve(socket.readyState), { once: true }))
    expect(closed).toBe(socket.CLOSED)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout', host: expect.stringMatching(/^127\.0\.0\.1:/) }))
  })

  it('trusts a certificate authority from the OS store, appended to the bundled ones, and still rejects an unknown one', async () => {
    const tls = (await import('node:tls')).default
    const { installSystemCertificates } = await import('../../../../apps/desktop/electron/egress/certificates')
    const bundled = tls.getCACertificates('default')
    const system = vi.spyOn(tls, 'getCACertificates').mockImplementation(type => type === 'system' ? [TEST_CERT] : bundled)
    cleanups.push(() => { system.mockRestore(); tls.setDefaultCACertificates(bundled) })
    const trusted = await listen(createTlsServer({ cert: TEST_CERT, key: TEST_KEY }, (_request, response) => response.end('system ca')) as unknown as Server)
    const unknown = await listen(createTlsServer({ cert: OTHER_CERT, key: OTHER_KEY }, (_request, response) => response.end('unknown ca')) as unknown as Server)
    await expect(nodeTransport(async () => null).fetch(`https://127.0.0.1:${trusted}/`)).rejects.toMatchObject({ kind: 'tls' })
    installSystemCertificates()
    system.mockRestore()
    const prints = (certs: string[]) => certs.map(cert => new X509Certificate(cert).fingerprint256)
    expect(prints(tls.getCACertificates('default'))).toEqual(expect.arrayContaining(prints([...bundled, TEST_CERT])))
    const transport = nodeTransport(async () => null)
    expect(await (await transport.fetch(`https://127.0.0.1:${trusted}/`)).text()).toBe('system ca')
    await expect(transport.fetch(`https://127.0.0.1:${unknown}/`)).rejects.toMatchObject({ kind: 'tls' })
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
    expect(await routes('https://127.0.0.2:1234')).toBeNull()
    expect(await routes('https://[::1]:1234')).toBeNull()
    const scoped = envRoutes({ HTTPS_PROXY: 'http://proxy.invalid:1234', NO_PROXY: 'private.test:443' })
    expect(await scoped('https://private.test')).toBeNull()
    expect(await scoped('https://private.test:444')).toBe('http://proxy.invalid:1234')
    expect(await scoped('https://127.evil.test')).toBe('http://proxy.invalid:1234')
  })
  // A large download reads one file as several ranged GETs at once; under HTTP/2 undici puts every request to an origin
  // on one connection, so they share it. Each request gets its own connection, over HTTP/1.1.
  it('gives concurrent requests to one origin their own connections, over HTTP/1.1, even where the server offers h2', async () => {
    const { createSecureServer } = await import('node:http2')
    const connections: string[] = [], versions: string[] = []
    const server = createSecureServer({ key: TEST_KEY, cert: TEST_CERT, allowHTTP1: true }, (request, response) => {
      versions.push(request.httpVersion); setTimeout(() => response.end('ok'), 50)
    })
    server.on('secureConnection', socket => connections.push(socket.alpnProtocol || 'none'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const port = (server.address() as { port: number }).port
    const transport = nodeTransport(async () => null, [TEST_CERT])
    const answers = await Promise.all([1, 2, 3].map(i => transport.fetch(`https://127.0.0.1:${port}/part-${i}`).then(response => response.text())))
    expect(answers).toEqual(['ok', 'ok', 'ok'])
    expect(versions).toEqual(['1.1', '1.1', '1.1'])
    expect(connections).toEqual(['http/1.1', 'http/1.1', 'http/1.1'])
  })
})
