// Multipart uploads from a host that can send signed part PUTs (S6): the client half of attachments upload /
// upload-parts / upload-complete. The fake server keeps the state the way the backend does (the parts reported done).
import { describe, expect, it } from 'vitest'
import { contentRequestId, declareAttachment, finishDeclaredAttachment, withUploadedAttachment, type AttachmentsEndpoint } from '../../../../packages/core/src/cloud/attachmentsApi'

// The upload alone: `use` hands back its key.
const uploadAttachmentBytes = (...[endpoint, file, scope, options]: [Parameters<typeof withUploadedAttachment>[0], Parameters<typeof withUploadedAttachment>[1], Parameters<typeof withUploadedAttachment>[2], Parameters<typeof withUploadedAttachment>[4]?]) =>
  withUploadedAttachment(endpoint, file, scope, async key => key, options)

const PART = 4
const KEY = 'staging/u/22222222-2222-4222-8222-222222222222'
type Answer = { status: number; body?: unknown }
function server(opts: { done?: number[]; refuse?: (n: number, attempt: number) => number | null; complete?: Array<Answer>; begin?: Array<Answer>; parts?: Array<Answer> } = {}) {
  const done = new Set(opts.done ?? [])
  const stored = new Map<number, Uint8Array>()
  const calls: Array<{ route: string; body: Record<string, unknown> }> = []
  const puts: Array<{ n: number; headers: Record<string, string>; bytes: Uint8Array }> = []
  const tries = new Map<number, number>()
  let size = 0, signedRound = 0
  const json = (answer: Answer) => new Response(JSON.stringify(answer.body ?? {}), { status: answer.status })
  const fetch = (async (input: string, init: RequestInit = {}) => {
    if (input === 'https://oss.example/form') return new Response(null, { status: 204 })
    if (input.startsWith('https://oss.example/')) {
      const n = Number(new URL(input).searchParams.get('partNumber'))
      const attempt = (tries.get(n) ?? 0) + 1
      tries.set(n, attempt)
      const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer())
      puts.push({ n, headers: init.headers as Record<string, string>, bytes })
      const refused = opts.refuse?.(n, attempt)
      if (refused) return new Response(null, { status: refused })
      stored.set(n, bytes)
      return new Response(null, { status: 200 })
    }
    const route = input.split('/').at(-1)!, body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ route, body })
    const count = Math.ceil(size / PART)
    if (route === 'upload') {
      const next = opts.begin?.shift()
      if (next) return json(next)
      size = Number(body.size_bytes)
      if (!body.parts) return json({ status: 200, body: { staging_key: KEY, url: 'https://oss.example/form', fields: {}, max_bytes: size } })
      return json({ status: 200, body: { staging_key: KEY, max_bytes: size, expires_at: new Date(Date.now() + 300_000).toISOString(), parts: { part_bytes: PART, count: Math.ceil(size / PART) } } })
    }
    if (route === 'finish') return json({ status: 200, body: { message: { id: body.message_id } } })
    if (route === 'upload-parts') {
      const scripted = opts.parts?.shift()
      if (scripted) return json(scripted)
      for (const n of body.done as number[]) done.add(n)
      signedRound++
      const todo = Array.from({ length: count }, (_, i) => i + 1).filter(n => !done.has(n)).slice(0, 2)
      return json({ status: 200, body: { done: [...done].sort(), todo: todo.map(n => ({ n, bytes: n < count ? PART : size - (count - 1) * PART,
        url: `https://oss.example/${KEY}?partNumber=${n}&round=${signedRound}`, headers: { 'content-length': String(n < count ? PART : size - (count - 1) * PART), authorization: 'OSS4-HMAC-SHA256 …', 'x-oss-date': 'now' } })) } })
    }
    if (route === 'upload-complete') {
      const next = opts.complete?.shift()
      if (next) return json(next)
      return json({ status: 200, body: { staging_key: KEY, size_bytes: size } })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof globalThis.fetch
  const endpoint: AttachmentsEndpoint = { supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch, signedParts: true }
  return { endpoint, calls, puts, stored, done }
}
const file = (n = 10) => ({ bytes: new Blob([Uint8Array.from({ length: n }, (_, i) => i)]), name: 'big.bin', contentType: 'application/octet-stream' })
const scope = { chat_id: 'chat', as: 'agent', request_id: '11111111-1111-4111-8111-111111111111' }

describe('multipart uploads from a host that sends signed parts', () => {
  it('only an endpoint with signedParts asks for parts; a page keeps the one form request', async () => {
    const page = server()
    await uploadAttachmentBytes({ ...page.endpoint, signedParts: undefined }, file(), scope)
    expect(page.calls[0]!.body).not.toHaveProperty('parts')
    expect(page.calls.map(c => c.route)).toEqual(['upload'])
    const host = server()
    await uploadAttachmentBytes(host.endpoint, file(), scope)
    expect(host.calls[0]!.body.parts).toBe(true)
  })
  it('sends each part as its slice with the signed headers (content-length left to the runtime), reports them, then joins', async () => {
    const s = server()
    const progress: number[] = []
    expect(await uploadAttachmentBytes(s.endpoint, file(10), scope, { onProgress: p => progress.push(p.loaded) })).toBe(KEY)
    expect(s.calls.map(c => c.route)).toEqual(['upload', 'upload-parts', 'upload-parts', 'upload-parts', 'upload-complete'])
    expect(s.calls.filter(c => c.route === 'upload-parts').map(c => c.body.done)).toEqual([[], [1, 2], [3]])
    expect([...s.stored.entries()].sort(([a], [b]) => a - b).map(([n, bytes]) => [n, [...bytes]])).toEqual([[1, [0, 1, 2, 3]], [2, [4, 5, 6, 7]], [3, [8, 9]]])
    for (const put of s.puts) {
      expect(Object.keys(put.headers).map(h => h.toLowerCase())).not.toContain('content-length')
      expect(put.headers.authorization).toContain('OSS4-HMAC-SHA256')
    }
    expect(progress.at(-1)).toBe(10)
  })
  it('a later call for the same upload sends only the parts the server has not recorded', async () => {
    const s = server({ done: [1, 2] })
    await uploadAttachmentBytes(s.endpoint, file(10), scope)
    expect(s.puts.map(p => p.n)).toEqual([3])
  })
  it('a part whose signature expired (403) is signed again; refused again right after a fresh signature, it fails', async () => {
    const once = server({ refuse: (n, attempt) => n === 2 && attempt === 1 ? 403 : null })
    await uploadAttachmentBytes(once.endpoint, file(10), scope)
    expect(once.puts.filter(p => p.n === 2)).toHaveLength(2)
    const always = server({ refuse: n => n === 1 ? 403 : null })
    await expect(uploadAttachmentBytes(always.endpoint, file(4 * PART), scope)).rejects.toThrow('refused a fresh part signature')
  })
  it('a join refused for missing parts goes back for them; a join that does not make the file starts once more from upload', async () => {
    const missing = server({ complete: [{ status: 409, body: { error: 'upload_incomplete', message: 'Parts not sent yet: 2' } }] })
    await uploadAttachmentBytes(missing.endpoint, file(10), scope)
    expect(missing.calls.map(c => c.route)).toEqual(['upload', 'upload-parts', 'upload-parts', 'upload-parts', 'upload-complete', 'upload-parts', 'upload-complete'])
    const changed = server({ complete: [{ status: 409, body: { error: 'upload_changed', message: 'The parts make 4 bytes, not 10' } }] })
    await uploadAttachmentBytes(changed.endpoint, file(10), scope)
    expect(changed.calls.filter(c => c.route === 'upload').map(c => c.body.request_id)).toEqual([scope.request_id, scope.request_id])
    const twice = server({ complete: [0, 1].map(() => ({ status: 409, body: { error: 'upload_changed', message: 'no' } })) })
    await expect(uploadAttachmentBytes(twice.endpoint, file(10), scope)).rejects.toMatchObject({ code: 'upload_changed' })
  })
  it('a given id whose permit was used or lapsed (on upload or while reporting parts) starts once more under a fresh id, once', async () => {
    const expired = { status: 410, body: { error: 'expired', message: 'Upload permit expired' } }
    const atStart = server({ begin: [expired] })
    await uploadAttachmentBytes(atStart.endpoint, file(10), scope)
    const ids = atStart.calls.filter(c => c.route === 'upload').map(c => c.body.request_id)
    expect([ids[0], ids.length]).toEqual([scope.request_id, 2])
    expect(ids[1]).not.toBe(scope.request_id)
    // A resumed upload that had stopped reporting: the permit lapsed between calls, so its parts are asked for in vain.
    const midway = server({ complete: [expired] })
    await uploadAttachmentBytes(midway.endpoint, file(10), scope)
    expect(midway.calls.filter(c => c.route === 'upload').map(c => c.body.request_id)).toEqual([scope.request_id, expect.not.stringMatching(scope.request_id)])
    const repeatedlyExpired = server({ parts: [expired, expired] })
    await expect(uploadAttachmentBytes(repeatedlyExpired.endpoint, file(10), scope)).rejects.toMatchObject({ code: 'expired' })
    expect(repeatedlyExpired.calls.filter(c => c.route === 'upload')).toHaveLength(2)
    const older = server({ begin: [expired, expired] })
    await uploadAttachmentBytes(older.endpoint, file(10), scope)
    const first = await contentRequestId('attachment-upload-permit', scope.request_id)
    const second = await contentRequestId('attachment-upload-permit', first)
    expect(older.calls.filter(c => c.route === 'upload').map(c => c.body.request_id)).toEqual([scope.request_id, first, second])
  })
  it('a caller with a stable request ID recovers its one successor when the signing response is lost', async () => {
    const s = server()
    const successor = await contentRequestId('attachment-upload-permit', scope.request_id)
    const other = '33333333-3333-4333-8333-333333333333'
    const requests: string[] = []
    const issued = new Set<string>()
    const endpoint = { ...s.endpoint, fetch: (async (input, init) => {
      if (String(input).endsWith('/attachments/upload')) {
        const id = JSON.parse(String(init?.body)).request_id
        requests.push(id)
        if (id === scope.request_id) return Response.json({ error: 'expired' }, { status: 410 })
        const previous = issued.has(id)
        issued.add(id)
        if (id === successor && !previous) throw new TypeError('signing response lost')
      }
      return s.endpoint.fetch!(input, init)
    }) as typeof globalThis.fetch }
    await expect(uploadAttachmentBytes(endpoint, file(), scope)).rejects.toThrow('signing response lost')
    await uploadAttachmentBytes(endpoint, file(), scope)
    await uploadAttachmentBytes(endpoint, file(), { ...scope, request_id: other })
    expect(requests).toEqual([scope.request_id, successor, scope.request_id, successor, other])
    expect([...issued]).toEqual([successor, other])
  })
  it('a content request id is the same for the same identity, differs otherwise, and has the UUID shape', async () => {
    const a = await contentRequestId('chat', 'agent', 'c1', 'ab'.repeat(32), '10')
    expect(a).toBe(await contentRequestId('chat', 'agent', 'c1', 'ab'.repeat(32), '10'))
    expect(a).not.toBe(await contentRequestId('chat', 'agent', 'c2', 'ab'.repeat(32), '10'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it.each([new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), new Error('net::ERR_CONNECTION_RESET')])('retries the interrupted part after $message without sending stored parts again', async error => {
    const s = server({ refuse: (n, attempt) => {
      if (n === 3 && attempt === 1) throw error
      return null
    } })
    const bytes = file(10)
    const declared = await declareAttachment(s.endpoint, bytes, { chat_id: 'chat', as: 'agent' })
    expect(declared.plan?.parts).toEqual({ part_bytes: PART, count: 3 })
    await finishDeclaredAttachment(s.endpoint, declared, bytes, { id: 'm1', chat_id: 'chat', as: 'agent' })
    expect(s.calls.filter(c => c.route === 'upload')).toHaveLength(1)
    expect(s.puts.map(p => p.n).sort()).toEqual([1, 2, 3, 3])
    expect(s.calls.at(-1)?.route).toBe('finish')
  })
  it('stops after three attempts of one part even if storage keeps failing', async () => {
    const s = server({ refuse: n => n === 3 ? 503 : null })
    await expect(uploadAttachmentBytes(s.endpoint, file(), scope)).rejects.toMatchObject({ status: 503 })
    expect(s.puts.map(p => p.n).sort()).toEqual([1, 2, 3, 3, 3])
    expect(s.done).toEqual(new Set([1, 2]))
  })
  it('a message sent before its bytes: a multipart upload whose permit lapsed is replaced by a new plan', async () => {
    const expired = { status: 410, body: { error: 'expired', message: 'Upload permit expired' } }
    const s = server({ parts: [expired] })
    const bytes = file(10)
    const id = KEY.split('/').at(-1)!
    const declared = await declareAttachment(s.endpoint, bytes, { ...scope, request_id: id })
    await finishDeclaredAttachment(s.endpoint, declared, bytes, { id: 'm1', chat_id: 'chat', as: 'agent' })
    expect(s.calls.filter(c => c.route === 'upload').map(c => c.body.request_id)).toEqual([id, await contentRequestId('attachment-upload-permit', id)])
    expect(s.calls.at(-1)?.route).toBe('finish')
  })
  it.each(['upload_changed', 'upload_incomplete'])('recovers from %s without replacing a live reservation', async code => {
    const issue = { status: 409, body: { error: code } }
    const s = server(code === 'upload_changed' ? { complete: [issue] } : { parts: [issue] })
    const bytes = file()
    const id = KEY.split('/').at(-1)!
    const declared = await declareAttachment(s.endpoint, bytes, { ...scope, request_id: id })
    await finishDeclaredAttachment(s.endpoint, declared, bytes, { id: 'm1', chat_id: 'chat', as: 'agent' })
    expect(s.calls.filter(c => c.route === 'upload').map(c => c.body.request_id)).toEqual([id, id])
    expect(s.calls.at(-1)?.body).toEqual(expect.objectContaining({ staging_key: KEY, message_id: 'm1' }))
  })
  it('rereads a server-extended permit under the original upload id and keeps recorded parts', async () => {
    const s = server({ done: [1, 2] })
    const bytes = file()
    const declared = await declareAttachment(s.endpoint, bytes, scope)
    declared.plan!.expires_at = new Date(Date.now() - 1).toISOString()
    await finishDeclaredAttachment(s.endpoint, declared, bytes, { id: 'm1', chat_id: 'chat', as: 'agent' })
    expect(s.calls.filter(c => c.route === 'upload').at(-1)?.body.request_id).toBe(KEY.split('/').at(-1))
    expect(s.puts.map(p => p.n)).toEqual([3])
  })
  it('continues across repeated extensions of one multipart permit', async () => {
    const base = Date.now() - 240_000
    const refreshed = (additional: number) => ({ status: 200, body: { staging_key: KEY, max_bytes: 10,
      expires_at: new Date(base + additional).toISOString(), parts: { part_bytes: PART, count: 3 } } })
    const begin: Answer[] = []
    const s = server({ begin, done: [1, 2] })
    const bytes = file()
    const id = KEY.split('/').at(-1)!
    const declared = await declareAttachment(s.endpoint, bytes, { ...scope, request_id: id })
    declared.plan!.expires_at = new Date(base).toISOString()
    begin.push(refreshed(120_000), refreshed(360_000))
    await finishDeclaredAttachment(s.endpoint, declared, bytes, { id: 'm1', chat_id: 'chat', as: 'agent' })
    expect(s.calls.filter(c => c.route === 'upload').map(c => c.body.request_id)).toEqual([id, id, id])
    expect(s.puts.map(p => p.n)).toEqual([3])
  })
  it('a batch that fails part-way reports the parts that did go up first, so the next attempt does not send them again', async () => {
    // Parts 1 and 2 are signed together; part 2 is refused for good once, part 1 goes up.
    const s = server({ refuse: (n, attempt) => n === 2 && attempt === 1 ? 400 : null })
    await expect(uploadAttachmentBytes(s.endpoint, file(10), scope)).rejects.toMatchObject({ status: 400 })
    expect(s.calls.filter(c => c.route === 'upload-parts').at(-1)?.body.done).toEqual([1])
    expect(s.done).toEqual(new Set([1]))
  })
})
