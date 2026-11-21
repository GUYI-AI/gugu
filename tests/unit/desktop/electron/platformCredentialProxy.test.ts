import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxyPlatformCredentialRequest, withinCredentialDeadline } from '../../../../apps/desktop/electron/sessionpage/platform-credential-proxy'
import { egress, EgressError } from '@gugu/core/shared/egress'
import { deferred } from '../../../support/testHarness'

const servers: Server[] = []
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test endpoint')
  return `http://127.0.0.1:${address.port}/v1/messages?stream=true`
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

describe('the host credential relay', () => {
  it('finishes the response and stream completion when the HTTP diagnostic callback throws', async () => {
    const wire = 'event: error\ndata: {"type":"error"}\n\n'
    const upstream = await serve((_request, response) => {
      response.writeHead(400, { 'content-type': 'text/event-stream' })
      response.end(wire)
    })
    const httpError = vi.fn(() => { throw new Error('synthetic observer failure') })
    const streamTiming = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'fresh', refresh: vi.fn(), warn: vi.fn(), httpError, streamTiming,
      })
    })
    const result = await fetch(relay, { method: 'POST', body: '{}' })
    expect(result.status).toBe(400)
    expect(await result.text()).toBe(wire)
    await vi.waitFor(() => expect(streamTiming).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ complete: true })))
    expect(httpError).toHaveBeenCalledTimes(1)
  })

  it('observes a synthetic 400 before ACP wrapping without changing its wire response or retrying', async () => {
    const id = '20261116000000000000000000aBcDeFgHiJkLm'
    const wire = JSON.stringify({ request_id: id, error: { type: 'invalid_request_error',
      code: 'unsupported_parameter', param: 'thinking.display', message: 'private prompt and private-token' } })
    const upstreamCall = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(400, { 'content-type': 'application/json', 'x-preserved': 'yes' })
      response.write(wire.slice(0, 20))
      response.end(wire.slice(20))
    })
    const upstream = await serve(upstreamCall)
    const httpError = vi.fn()
    const refresh = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'private-token', refresh, warn: vi.fn(), httpError,
      })
    })
    const result = await fetch(relay, { method: 'POST', body: '{}' })
    expect(result.status).toBe(400)
    expect(result.headers.get('x-preserved')).toBe('yes')
    expect(await result.text()).toBe(wire)
    await vi.waitFor(() => expect(httpError).toHaveBeenCalledExactlyOnceWith({ status: 400,
      bodyInspection: 'json', requestId: id, errorType: 'invalid_request_error',
      errorCode: 'unsupported_parameter', param: 'thinking.display' }))
    expect(upstreamCall).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(JSON.stringify(httpError.mock.calls)).not.toMatch(/private prompt|private-token/)
  })

  it('leaves successful JSON responses unchanged and never inspects them as errors', async () => {
    const wire = '{"error":{"type":"invalid_request_error"},"text":"successful response"}'
    const upstream = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(wire)
    })
    const httpError = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'fresh', refresh: vi.fn(), warn: vi.fn(), httpError,
      })
    })
    const result = await fetch(relay, { method: 'POST', body: '{}' })
    expect(result.status).toBe(200)
    expect(await result.text()).toBe(wire)
    expect(httpError).not.toHaveBeenCalled()
  })

  it('waits for the shared credential and replaces both local auth headers without changing bytes', async () => {
    const issued = deferred<string>()
    const readCredential = deferred<void>()
    const calls: Array<{ body: Buffer; headers: IncomingMessage['headers'] }> = []
    const upstream = await serve((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        calls.push({ body: Buffer.concat(chunks), headers: request.headers })
        response.end('accepted')
      })
    })
    const warn = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(['x-local-hint']),
        credential: () => { readCredential.resolve(); return issued.promise },
        refresh: vi.fn(), warn,
      })
    })
    const body = Buffer.from('{"prompt":"原图与报告\\n","stream":true} \n')
    const result = fetch(relay, { method: 'POST', headers: {
      authorization: 'Bearer local-secret', 'x-api-key': 'local-secret',
      'x-local-hint': 'local-only', 'anthropic-version': '2023-06-01', 'x-custom': 'unchanged',
    }, body })
    await readCredential.promise
    expect(calls).toHaveLength(0)
    issued.resolve('platform-fresh')
    expect(await (await result).text()).toBe('accepted')
    expect(calls[0].body).toEqual(body)
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer platform-fresh', 'x-api-key': 'platform-fresh', 'x-custom': 'unchanged', 'anthropic-version': '2023-06-01' })
    expect(calls[0].headers['x-local-hint']).toBeUndefined()
    expect(JSON.stringify(calls)).not.toContain('local-secret')
    expect(warn).not.toHaveBeenCalled()
  })

  it('lets the outbound fetch own transport metadata while preserving the harness user-agent', async () => {
    const userAgent = 'claude-cli/9.9.9 (external, cli)'
    let receivedUserAgent: string | undefined
    const upstream = await serve((request, response) => {
      receivedUserAgent = request.headers['user-agent']
      response.end('accepted')
    })
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'platform-fresh', refresh: vi.fn(), warn: vi.fn(),
      })
    })
    const headers = {
      'cookie2': '$Version=1', 'expect': '100-continue', 'origin': 'https://synthetic.invalid',
      'referer': 'https://synthetic.invalid/from', 'set-cookie': 'synthetic=1',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'sec-ch-ua': 'synthetic',
      'sec-purpose': 'prefetch', 'proxy-connection': 'keep-alive', 'proxy-rig': 'synthetic',
      'x-http-method': 'CONNECT', 'x-http-method-override': 'TRACE', 'x-method-override': 'TRACK',
      'user-agent': userAgent, 'x-client-version': 'synthetic-business-header',
    }
    const outbound = vi.spyOn(egress, 'fetch')
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const request = httpRequest(relay, { method: 'POST', headers }, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => resolve(Buffer.concat(chunks).toString()))
          response.on('error', reject)
        })
        request.on('error', reject)
        request.end('{}')
      })
      expect(result).toBe('accepted')
      const sent = new Headers(outbound.mock.calls[0][1]?.headers)
      // Only the header undici refuses is dropped; the relay forwards the rest, as the Node relay before it did.
      expect(sent.has('expect')).toBe(false)
      for (const name of Object.keys(headers).filter(name => name !== 'expect')) expect(sent.has(name)).toBe(true)
      expect(sent.get('user-agent')).toBe(userAgent)
      expect(sent.get('x-client-version')).toBe('synthetic-business-header')
      expect(receivedUserAgent).toBe(userAgent)
    } finally { outbound.mockRestore() }
  })

  it('rejects a gateway redirect without forwarding platform credentials to its destination', async () => {
    let followed = 0
    const target = await serve((_request, response) => { followed++; response.end('not expected') })
    const upstream = await serve((_request, response) => response.writeHead(302, { location: target }).end())
    const warn = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), credential: async () => 'platform-credential',
        refresh: vi.fn(), localOnlyHeaders: new Set(), warn,
      })
    })
    const response = await fetch(relay, { method: 'POST', body: '{"prompt":"hello"}' })
    expect(response.status).toBe(502)
    expect(followed).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'connection' }))
  })

  it.each([200, 401])('refreshes and replays a 401 only once, including when the second status is %s', async (secondStatus) => {
    const bodies: Buffer[] = []
    const auth: unknown[] = []
    const upstream = await serve((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks)); auth.push(request.headers.authorization)
        response.writeHead(bodies.length === 1 ? 401 : secondStatus)
        response.end(bodies.length === 1 ? 'first rejection' : 'second response')
      })
    })
    const refresh = vi.fn(async () => 'platform-next')
    const warn = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'platform-first', refresh, warn,
      })
    })
    const body = Buffer.from(JSON.stringify({ prompt: '字节'.repeat(60_000), stream: true }))
    const result = await fetch(relay, { method: 'POST', body })
    expect(result.status).toBe(secondStatus)
    expect(await result.text()).toBe('second response')
    expect(bodies).toEqual([body, body])
    expect(auth).toEqual(['Bearer platform-first', 'Bearer platform-next'])
    expect(refresh).toHaveBeenCalledExactlyOnceWith('platform-first')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/platform-first|platform-next/)
  })

  it('delivers SSE chunks before the upstream finishes', async () => {
    const finish = deferred<void>()
    const upstream = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-stream-test': 'kept' })
      response.write('event: message_start\ndata: first\n\n')
      void finish.promise.then(() => response.end('event: message_stop\ndata: last\n\n'))
    })
    const httpError = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'fresh', refresh: vi.fn(), warn: vi.fn(), httpError,
      })
    })
    const result = await fetch(relay, { method: 'POST', body: '{}' })
    expect(result.headers.get('x-stream-test')).toBe('kept')
    const reader = result.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: message_start\ndata: first\n\n')
    finish.resolve()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: message_stop\ndata: last\n\n')
    expect((await reader.read()).done).toBe(true)
    expect(httpError).not.toHaveBeenCalled()
  })

  it('hands the harness the decoded body without the encoding headers the host fetch already undid', async () => {
    const wire = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    const upstream = await serve((_request, response) => {
      const gz = gzipSync(wire)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': String(gz.length) })
      response.end(gz)
    })
    const streamTiming = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'fresh', refresh: vi.fn(), warn: vi.fn(), streamTiming,
      })
    })
    const result = await fetch(relay, { method: 'POST', body: '{}' })
    expect(result.headers.get('content-encoding')).toBeNull()
    expect(await result.text()).toBe(wire)
    await vi.waitFor(() => expect(streamTiming).toHaveBeenCalledTimes(1))
    expect(streamTiming.mock.calls[0][0]).toMatchObject({ frames: 1, eventTimingAvailable: true, complete: true })
  })

  it('reports passive stream timings once without recording response content or credentials', async () => {
    const wire = 'event: ping\ndata: {"type":"ping"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"private response"}}\n\n'
    const upstream = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(wire)
    })
    const streamTiming = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'private-token', refresh: vi.fn(), warn: vi.fn(), streamTiming,
      })
    })
    expect(await (await fetch(relay, { method: 'POST', body: '{}' })).text()).toBe(wire)
    await vi.waitFor(() => expect(streamTiming).toHaveBeenCalledTimes(1))
    expect(streamTiming.mock.calls[0][0]).toMatchObject({ frames: 2, heartbeatFrames: 1, progressFrames: 1, complete: true })
    expect(JSON.stringify(streamTiming.mock.calls)).not.toMatch(/private response|private-token|content_block_delta/)
  })

  it('records the trailing quiet interval when the native client aborts a stalled stream', async () => {
    const upstream = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    })
    const streamTiming = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'fresh', refresh: vi.fn(), warn: vi.fn(), streamTiming,
      })
    })
    const controller = new AbortController()
    const result = await fetch(relay, { method: 'POST', body: '{}', signal: controller.signal })
    const reader = result.body!.getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
    await vi.waitFor(() => expect(streamTiming).toHaveBeenCalledTimes(1))
    expect(streamTiming.mock.calls[0][0]).toMatchObject({ complete: false, progressFrames: 1 })
  })

  it('bounds waiting without cancelling or returning the old credential', async () => {
    vi.useFakeTimers()
    const issued = deferred<string>()
    const pending = withinCredentialDeadline(issued.promise)
    const rejection = expect(pending).rejects.toThrow('credential refresh timed out')
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection
    issued.resolve('late-fresh')
    await expect(issued.promise).resolves.toBe('late-fresh')
  })

  it('returns the same safe proxy-location message to harnesses without exposing cause or credentials', async () => {
    const cause = Object.assign(new Error('private-cause-password'), { proxies: ['http://proxy.test:8080'] })
    const failure = new EgressError('proxy-auth', 'gateway.test', cause)
    const outbound = vi.spyOn(egress, 'fetch').mockRejectedValue(failure)
    try {
      const relay = await serve((request, response) => {
        void proxyPlatformCredentialRequest(request, response, {
          upstream: () => new URL('https://gateway.test'), localOnlyHeaders: new Set(),
          credential: async () => 'private-platform-token', refresh: vi.fn(), warn: vi.fn(),
        })
      })
      const result = await fetch(relay)
      expect(result.status).toBe(502)
      const text = await result.text()
      expect(JSON.parse(text).error.message).toContain('代理要求登录（系统代理 http://proxy.test:8080）')
      expect(text).not.toMatch(/private-cause-password|private-platform-token/)
    } finally { outbound.mockRestore() }
  })

  it('logs transport failure metadata without either credential value', async () => {
    const upstream = await serve((_request, response) => response.end())
    await new Promise<void>(resolve => servers[0].close(() => resolve()))
    const warn = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'platform-private', refresh: vi.fn(), warn,
      })
    })
    const result = await fetch(relay, { headers: { authorization: 'Bearer local-private', 'x-api-key': 'local-private' } })
    expect(result.status).toBe(502)
    expect(warn).toHaveBeenCalledWith({ kind: 'connection', code: 'connect', proxies: [], headerNames: expect.arrayContaining(['authorization', 'x-api-key']) })
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/platform-private|local-private/)
  })
})
