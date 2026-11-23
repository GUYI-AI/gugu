import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentRequestId, declareAttachment, declaredUploadState, drawImagePreviews, finishDeclaredAttachment, placeAttachment, planAttachmentUpload, retryableAttachmentError, withUploadedAttachment, type AttachmentsEndpoint } from '../../../../packages/core/src/cloud/attachmentsApi'

// Direct upload (contract §3): every upload sends the file's sha256 with its permit request; the server answers `stored`
// (no bytes go up), `upload` straight to the final object, or 409 upload_in_progress (wait and ask again). The final
// object is never overwritten: its store refusing goes to finish, which decides from the object itself.
const bytes = new TextEncoder().encode('hello world'), sha = createHash('sha256').update(bytes).digest('hex')
const later = () => new Date(Date.now() + 600_000).toISOString()
type Answer = { status?: number; body: Record<string, unknown> }
function server(routes: Record<string, (body: Record<string, unknown>) => Answer | Record<string, unknown>>, storeStatus: () => number = () => 200) {
  const calls: { route: string; body: Record<string, unknown> }[] = [], stored: string[] = []
  const endpoint: AttachmentsEndpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = String(input).split('/').at(-1)!, body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ route, body })
      const handler = routes[route]
      if (!handler) throw Error(`unexpected route ${route}`)
      const answer = handler(body)
      const { status, body: json } = 'body' in answer && typeof answer.body === 'object' ? answer as Answer : { status: 200, body: answer }
      return new Response(JSON.stringify(json), { status: status ?? 200 })
    }) as typeof fetch,
    upload: async url => { stored.push(url); return { status: storeStatus() } } }
  return { endpoint, calls, stored, routes: (name: string) => calls.filter(call => call.route === name) }
}
const direct = (requestId: string) => ({ status: 'upload', staging_key: `direct/acct/${requestId}`, url: `https://bucket.test/u/acct/${sha}`, fields: {}, max_bytes: bytes.length, expires_at: later() })
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { error, message: error, ...extra } })
const file = { bytes, name: 'hello.txt', contentType: 'text/plain' }
const scope = { chat_id: 'chat', as: 'me' }
const place = (endpoint: AttachmentsEndpoint) => (key: string) => placeAttachment(endpoint, { staging_key: key, chat_id: 'chat', file_name: 'hello.txt' })
afterEach(() => vi.useRealTimers())

describe('hash first, then the permit', () => {
  // The server will refuse a plan without sha256 (426). Each upload names its own bytes: a preview its preview's
  // sha, never the original's that it is offered for.
  it('every plan request carries the sha256 of the bytes it uploads', async () => {
    const s = server({ upload: body => ({ ...direct(String(body.request_id)), max_bytes: body.size_bytes }), place: () => ({ item: { id: 'item' } }), 'file-preview': () => ({}) })
    const preview = new Blob(['a small preview'], { type: 'image/png' })
    const previewSha = createHash('sha256').update('a small preview').digest('hex')
    await withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))
    await declareAttachment(s.endpoint, { bytes, contentType: 'text/plain' }, { ...scope, request_id: 'message-1' })
    await declareAttachment(s.endpoint, { bytes, contentType: 'text/plain', sha256: sha }, { ...scope, request_id: 'message-2' })
    // An uploaded image offers its preview: the preview goes up under its own sha, offered for the image's.
    drawImagePreviews({ draw: async () => preview, warn: error => { throw error } })
    try {
      await withUploadedAttachment(s.endpoint, { ...file, contentType: 'image/png' }, scope, place(s.endpoint))
      await vi.waitFor(() => expect(s.routes('file-preview')).toHaveLength(1))
    } finally { drawImagePreviews({ draw: () => new Promise(() => {}), warn: () => {} }) }
    const plans = s.routes('upload').map(call => call.body.sha256)
    expect(plans).toEqual([sha, sha, sha, sha, previewSha])
    expect(s.routes('file-preview')[0]!.body).toMatchObject({ sha256: sha })
    await expect(planAttachmentUpload(s.endpoint, { size: 1, contentType: 'text/plain', sha256: '' }, scope)).rejects.toThrow('Invalid upload SHA-256')
    expect(s.routes('upload')).toHaveLength(5)
  })

  it('asks with the sha256 and size of the exact bytes', async () => {
    const s = server({ upload: body => direct(String(body.request_id)), place: () => ({ item: { id: 'item' } }) })
    await withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))
    expect(s.routes('upload')[0]!.body).toMatchObject({ sha256: sha, size_bytes: bytes.length })
    expect(s.routes('place')[0]!.body.staging_key).toMatch(/^direct\/acct\//)
  })

  // One message with the same bytes twice: the second declaration is `stored` (the server binds it to the first permit's
  // object). Its finish answers upload_in_progress until the first upload lands. It waits; it never sends the bytes again.
  it('the same bytes twice in one message: the second waits for the first upload and sends nothing', async () => {
    let landed = false
    const s = server({
      upload: body => body.request_id === 'm-b' ? { status: 'stored', staging_key: 'direct/acct/m-b' } : direct(String(body.request_id)),
      finish: body => body.staging_key === 'direct/acct/m-b' && !landed ? refuse(409, 'upload_in_progress', { retry_after: later() }) : {},
    })
    const first = await declareAttachment(s.endpoint, { bytes, contentType: 'text/plain' }, { ...scope, request_id: 'm-a' })
    const second = await declareAttachment(s.endpoint, { bytes, contentType: 'text/plain' }, { ...scope, request_id: 'm-b' })
    expect(second.staging_key).toBe('direct/acct/m-b')
    const waiting = finishDeclaredAttachment(s.endpoint, second, file, { id: 'm-b', ...scope })
    expect(await finishDeclaredAttachment(s.endpoint, first, file, { id: 'm-a', ...scope })).toBe(true)
    landed = true
    expect(await waiting).toBe(true)
    expect(s.stored).toHaveLength(1)
    expect(s.routes('finish').filter(call => call.body.staging_key === 'direct/acct/m-b').length).toBeGreaterThan(1)
  })

  it('stored: no byte goes up, the key goes straight to place (and to a declared message\'s finish)', async () => {
    const s = server({ upload: body => ({ status: 'stored', staging_key: `direct/acct/${body.request_id}` }), place: () => ({ item: { id: 'item' } }), finish: () => ({}) })
    await withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))
    expect(s.stored).toEqual([])
    expect(s.routes('place')).toHaveLength(1)
    // A declared attachment: no size check against a missing max_bytes; commit, then the same finish as ever.
    const declared = await declareAttachment(s.endpoint, { bytes, contentType: 'text/plain' }, { ...scope, request_id: 'message-1' })
    expect(declared).toMatchObject({ sha256: sha, size_bytes: bytes.length, staging_key: 'direct/acct/message-1' })
    expect(await finishDeclaredAttachment(s.endpoint, declared, file, { id: 'message-1', ...scope })).toBe(true)
    expect(s.stored).toEqual([])
    expect(s.routes('finish')[0]!.body).toMatchObject({ staging_key: 'direct/acct/message-1', message_id: 'message-1' })
  })

  it('upload_in_progress: asks again at 1 s, 2 s, 4 s … (never past retry_after), not a failure', async () => {
    vi.useFakeTimers()
    const asks: number[] = [], t0 = Date.now()
    const s = server({ upload: body => { asks.push(Date.now() - t0); return asks.length < 4 ? refuse(409, 'upload_in_progress', { retry_after: new Date(t0 + 5_000).toISOString() }) : direct(String(body.request_id)) },
      place: () => ({ item: { id: 'item' } }) })
    const run = withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))
    await vi.advanceTimersByTimeAsync(6_000)
    await run
    // 1 s, then 2 s, then the 4 s step is cut to retry_after (5 s).
    expect(asks).toEqual([0, 1_000, 3_000, 5_000])
    expect(s.stored).toHaveLength(1)
  })

  it('upload_in_progress that never ends: a declared finish gives up after a minute with a retryable error, it never hangs', async () => {
    vi.useFakeTimers()
    // The earlier permit's upload was refused by the store and nobody released it: finish keeps answering in progress.
    const s = server({ finish: () => refuse(409, 'upload_in_progress', { retry_after: later() }) })
    const declared = { staging_key: 'direct/acct/m-1', sha256: sha, size_bytes: bytes.length, plan: { ...direct('m-1'), status: 'stored' as const } }
    const t0 = Date.now()
    const finished = finishDeclaredAttachment(s.endpoint, declared, file, { id: 'm-1', chat_id: 'chat', as: 'me' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(120_000)
    const error = await finished
    expect(error).toMatchObject({ status: 409, code: 'upload_in_progress' })
    expect(retryableAttachmentError(error)).toBe(true)
    // It asked again for a minute (1 s, 2 s, 4 s, 8 s, 15 s …), then said so.
    expect(s.routes('finish').length).toBeGreaterThan(3)
    expect(Date.now() - t0).toBeLessThanOrEqual(120_000)
  })

  it('the same bytes sent twice at once: the second gets `stored` soon after the first registers, not at the other permit\'s expiry', async () => {
    vi.useFakeTimers()
    let open: string | null = null, registered = false
    const writes: string[] = [], t0 = Date.now()
    const route = (path: string, body: Record<string, unknown>) => {
      if (path === 'upload') {
        if (registered) return Response.json({ status: 'stored', staging_key: `direct/acct/${body.request_id}` })
        if (open && open !== body.request_id) return Response.json({ error: 'upload_in_progress', message: 'busy', retry_after: new Date(t0 + 420_000).toISOString() }, { status: 409 })
        open = String(body.request_id)
        return Response.json(direct(open))
      }
      if (path === 'place') { registered = true; return Response.json({ item: { id: `item-${body.staging_key}` } }) }
      throw Error(path)
    }
    const endpoint: AttachmentsEndpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => route(String(input).split('/').at(-1)!, JSON.parse(String(init?.body)))) as typeof fetch,
      // The first sender's bytes take 3 s to go up.
      upload: async url => { writes.push(url); await new Promise(resolve => setTimeout(resolve, 3_000)); return { status: 200 } } }
    const done: Record<string, number> = {}
    const send = (id: string) => withUploadedAttachment(endpoint, file, { ...scope, request_id: id }, key => placeAttachment(endpoint, { staging_key: key, chat_id: 'chat', file_name: 'hello.txt' }))
      .then(item => { done[id] = Date.now() - t0; return item })
    const first = send('request-a'), second = send('request-b')
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([first, second])
    expect(writes).toHaveLength(1)
    expect(done['request-a']).toBe(3_000)
    expect(done['request-b']).toBeLessThanOrEqual(7_000)
  })
})

describe('the final object is never overwritten', () => {
  it.each([409, 400])('a direct permit whose store answers %i goes to finish/place, which decides', async status => {
    const s = server({ upload: body => direct(String(body.request_id)), place: () => ({ item: { id: 'item' } }) }, () => status)
    await withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))
    expect(s.stored).toHaveLength(1)
    expect(s.routes('place')).toHaveLength(1)
  })

  it('a legacy staging permit keeps its rule: a first 400 is a failure', async () => {
    const s = server({ upload: () => ({ staging_key: 'staging/acct/x', url: 'https://bucket.test/staging', fields: {}, max_bytes: bytes.length, expires_at: later() }),
      place: () => ({ item: { id: 'item' } }) }, () => 400)
    await expect(withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))).rejects.toThrow('HTTP 400')
    expect(s.routes('place')).toEqual([])
  })

  it('place says upload_missing: the bytes go again under the same permit', async () => {
    let placed = 0
    const s = server({ upload: body => direct(String(body.request_id)), place: () => ++placed === 1 ? refuse(409, 'upload_missing') : { item: { id: 'item' } } })
    await withUploadedAttachment(s.endpoint, file, { ...scope, request_id: '11111111-1111-4111-8111-111111111111' }, place(s.endpoint))
    expect(s.routes('upload')).toHaveLength(1)
    expect(s.stored).toHaveLength(2)
    expect(s.routes('place').map(call => call.body.staging_key)).toEqual(['direct/acct/11111111-1111-4111-8111-111111111111', 'direct/acct/11111111-1111-4111-8111-111111111111'])
  })

  it('place says upload_changed: the next permit (the deterministic successor) writes it again', async () => {
    let placed = 0
    const first = '11111111-1111-4111-8111-111111111111', next = await contentRequestId('attachment-upload-permit', first)
    const s = server({ upload: body => direct(String(body.request_id)), place: () => ++placed === 1 ? refuse(409, 'upload_changed') : { item: { id: 'item' } } })
    await withUploadedAttachment(s.endpoint, file, { ...scope, request_id: first }, place(s.endpoint))
    expect(s.routes('upload').map(call => call.body.request_id)).toEqual([first, next])
    expect(s.routes('place').at(-1)!.body.staging_key).toBe(`direct/acct/${next}`)
  })

  it('asking again under a live direct permit says upload_used: the server decides at place', async () => {
    let asked = 0, placed = 0
    const s = server({ upload: body => ++asked === 1 ? { status: 'stored', staging_key: `direct/acct/${body.request_id}` } : refuse(409, 'upload_used'),
      place: () => ++placed === 1 ? refuse(409, 'upload_missing') : { item: { id: 'item' } } })
    await withUploadedAttachment(s.endpoint, file, { ...scope, request_id: 'request-1' }, place(s.endpoint))
    expect(s.routes('place').map(call => call.body.staging_key)).toEqual(['direct/acct/request-1', 'direct/acct/request-1'])
    expect(s.stored).toEqual([])
  })

  it('a direct store refusal after finish said the object is missing is the store\'s own failure, with its status', async () => {
    let stores = 0
    const s = server({ upload: body => direct(String(body.request_id)), place: () => refuse(409, 'upload_missing') }, () => ++stores && 400)
    await expect(withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))).rejects.toMatchObject({ route: 'upload', status: 400, message: expect.stringContaining('HTTP 400') })
    expect(stores).toBe(2)
    expect(s.routes('place')).toHaveLength(1)
  })

  it('upload_missing twice is said, not retried forever', async () => {
    const s = server({ upload: body => direct(String(body.request_id)), place: () => refuse(409, 'upload_missing') })
    await expect(withUploadedAttachment(s.endpoint, file, scope, place(s.endpoint))).rejects.toMatchObject({ code: 'upload_missing' })
    expect(s.routes('place')).toHaveLength(2)
  })
})

describe('declared attachments under a direct key', () => {
  it('a restarted sender recovers the permit from a direct key', () => {
    expect(declaredUploadState('direct/acct/request-7', 'message-1').requestId).toBe('request-7')
    expect(declaredUploadState('staging/acct/request-7', 'message-1').requestId).toBe('request-7')
  })

  it('finish says upload_changed: the next permit uploads, then finish names it', async () => {
    let finished = 0
    const next = await contentRequestId('attachment-upload-permit', 'message-1')
    const s = server({ upload: body => direct(String(body.request_id)), finish: () => ++finished === 1 ? refuse(409, 'upload_changed') : {} })
    const declared = await declareAttachment(s.endpoint, { bytes, contentType: 'text/plain' }, { ...scope, request_id: 'message-1' })
    expect(await finishDeclaredAttachment(s.endpoint, declared, file, { id: 'message-1', ...scope })).toBe(true)
    expect(s.routes('upload').map(call => call.body.request_id)).toEqual(['message-1', next])
    expect(s.routes('finish').at(-1)!.body).toMatchObject({ staging_key: 'direct/acct/message-1', upload_key: `direct/acct/${next}` })
  })
})
