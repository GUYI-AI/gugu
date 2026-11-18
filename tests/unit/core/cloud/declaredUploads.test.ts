import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Owner 11-15: a message is its text and its files' index. The bytes go up behind the delivered message; what is still to
// upload is the server's answer (pending), and the host supplies this device's verified stored originals.
// The server is faked here at the network; no renderer or Electron dependencies enter the queue.
const server = vi.hoisted(() => ({ plan: vi.fn(), store: vi.fn(), finish: vi.fn(), pending: vi.fn() }))
const progress = vi.hoisted(() => ({ set: vi.fn(), fail: vi.fn() }))
const copies = vi.hoisted(() => new Map<string, Blob>())
const refuse = (status: number, error: string) => Object.assign(new Error(error), { status, error })
import { createDeclaredUploads } from '@gugu/core/cloud/declaredUploads'
import { AttachmentsError, contentRequestId } from '@gugu/core/cloud/attachmentsApi'
const endpoint = async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't',
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = String(input).split('/').at(-1)!, body = JSON.parse(String(init?.body)) as Record<string, unknown>
    try {
      const answer = await (route === 'upload' ? server.plan : route === 'finish' ? server.finish : server.pending)(body)
      return new Response(JSON.stringify(answer ?? {}), { status: 200 })
    } catch (error) {
      const said = error as { status?: number; error?: string }
      if (!said.status) throw error
      return new Response(JSON.stringify({ error: said.error, message: said.error }), { status: said.status })
    }
  },
  upload: async (url: string, init: { body: Blob | FormData }, onProgress?: (p: { loaded: number; total?: number }) => void) => {
    await server.store(url, init.body instanceof FormData ? init.body.get('file') : init.body, onProgress)
    return { status: 200 }
  } })

let queue: ReturnType<typeof createDeclaredUploads>
const beginAttachmentUpload = (...args: Parameters<typeof queue.begin>) => queue.begin(...args)
const resumeAttachmentUploads = () => queue.resume()
const dropAttachmentUpload = (id: string) => queue.drop(id)
const plan = (key: string) => ({ staging_key: key, url: `https://bucket.test/${key}`, fields: {}, max_bytes: 100, expires_at: new Date(Date.now() + 600_000).toISOString() })
const task = (messageId = 'message-1', as = 'sender') => ({ messageId, chatId: 'chat', as, pendingKey: `pending/${messageId}`, sha256: 'a'.repeat(64), name: 'photo.png', contentType: 'image/png', size: 5 })
const pending = (messageId: string, sha: string, file_name: string | null = 'notes.txt') => ({ staging_key: `pending/${messageId}`, message_id: messageId, chat_id: 'chat', as: 'sender', sha256: sha, size_bytes: 5, content_type: 'text/plain', file_name })
const notFound = () => refuse(404, 'upload_not_found')

beforeEach(() => {
  queue?.dispose(); copies.clear()
  server.plan.mockReset(); server.store.mockReset().mockResolvedValue(undefined); server.finish.mockReset().mockResolvedValue({}); server.pending.mockReset().mockResolvedValue({ uploads: [] })
  progress.set.mockReset(); progress.fail.mockReset()
  queue = createDeclaredUploads({ endpoint, copyOf: async sha => copies.get(sha) ?? null,
    progress: (id, value) => { if (value?.failed) progress.fail(id, value.final ? undefined : () => { void queue.retry(id) }); else if (value) progress.set(id, value); else progress.set(id) },
  })
})

afterEach(() => queue.dispose())

describe('attachment bytes go up behind their message', () => {
  it('an exhausted missing declaration stops when the server no longer lists the message', async () => {
    vi.useFakeTimers()
    try {
      server.finish.mockRejectedValue(notFound())
      const run = beginAttachmentUpload(task(), new Blob(['bytes']), plan('pending/message-1'))
      await vi.advanceTimersByTimeAsync(121_000)
      await run
      expect(server.pending).toHaveBeenCalledOnce()
      expect(progress.fail).not.toHaveBeenCalled()
      expect(progress.set).toHaveBeenLastCalledWith('message-1')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(server.store).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it.each(['listed', 'read failed'])('an exhausted missing declaration keeps its duty when pending is %s', async state => {
    vi.useFakeTimers()
    try {
      server.finish.mockRejectedValue(notFound())
      if (state === 'listed') server.pending.mockResolvedValue({ uploads: [pending('message-1', 'a'.repeat(64))] })
      else server.pending.mockRejectedValue(new TypeError('metadata offline'))
      server.plan.mockResolvedValue(plan('upload/recovered'))
      void beginAttachmentUpload(task(), new Blob(['bytes']), plan('pending/message-1')).catch(() => {})
      await vi.advanceTimersByTimeAsync(121_000)
      expect(progress.fail).toHaveBeenCalledOnce()
      server.finish.mockReset().mockResolvedValue({})
      await vi.advanceTimersByTimeAsync(60_000)
      expect(server.store).toHaveBeenCalledOnce()
      copies.set('a'.repeat(64), new Blob(['bytes']))
      server.pending.mockResolvedValue({ uploads: [pending('message-1', 'a'.repeat(64))] })
      await queue.retry('message-1')
      await vi.advanceTimersByTimeAsync(0)
      expect(server.plan).not.toHaveBeenCalled()
      expect(server.finish).toHaveBeenLastCalledWith(expect.objectContaining({ staging_key: 'pending/message-1' }))
      expect(server.finish.mock.lastCall?.[0]).not.toHaveProperty('upload_key')
    } finally { vi.useRealTimers() }
  })
  it('discard before prepare returns prevents a late declaration from starting an upload', async () => {
    dropAttachmentUpload('discarded')
    await beginAttachmentUpload(task('discarded'), new Blob(['bytes']), plan('pending/discarded'))
    expect(server.store).not.toHaveBeenCalled()
  })
  it('overlapping reconnects use one server query and one upload per message', async () => {
    copies.set('a'.repeat(64), new Blob(['bytes']))
    server.pending.mockResolvedValue({ uploads: [pending('one', 'a'.repeat(64))] })
    server.plan.mockResolvedValue(plan('upload/one'))
    await Promise.all([resumeAttachmentUploads(), resumeAttachmentUploads()])
    await vi.waitFor(() => expect(server.finish).toHaveBeenCalledOnce())
    expect(server.pending).toHaveBeenCalledOnce()
    expect(server.store).toHaveBeenCalledOnce()
  })

  it('uploads under the commit\'s plan, waits for the commit\'s declaration, then finishes it', async () => {
    server.store.mockImplementation(async (_url, _file, onProgress: (p: { loaded: number; total: number }) => void) => {
      onProgress({ loaded: 2, total: 5 }); onProgress({ loaded: 5, total: 5 })
    })
    // The bytes beat the message's commit: the server does not know the declaration yet, then it does.
    server.finish.mockRejectedValueOnce(notFound())
    await beginAttachmentUpload(task(), new Blob(['bytes']), plan('pending/message-1'))
    expect(server.finish).toHaveBeenCalledTimes(2)
    expect(server.finish).toHaveBeenLastCalledWith({ staging_key: 'pending/message-1', file_name: 'photo.png', content_type: 'image/png', message_id: 'message-1' })
    expect(progress.set).toHaveBeenCalledWith('message-1', { sha256: 'a'.repeat(64), chatId: 'chat', loaded: 2, total: 5, attempt: 1 })
    expect(progress.set).toHaveBeenLastCalledWith('message-1')
    expect(progress.fail).not.toHaveBeenCalled()
  })

  it('a restarted sender reopens the original permit and finishes the original message and document', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    const key = `staging/owner/${requestId}`
    copies.set('a'.repeat(64), new Blob(['bytes']))
    // Another device sent the second one: this device holds no copy and leaves it to that device.
    server.pending.mockResolvedValue({ uploads: [{ ...pending('message-1', 'a'.repeat(64)), staging_key: key }, pending('message-2', 'b'.repeat(64))] })
    server.plan.mockResolvedValue(plan(key))
    server.finish.mockRejectedValueOnce(refuse(409, 'upload_missing'))
    await resumeAttachmentUploads()
    await vi.waitFor(() => expect(server.finish).toHaveBeenCalledTimes(2))
    expect(server.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ request_id: requestId, size_bytes: 5, content_type: 'text/plain', chat_id: 'chat', as: 'sender' }))
    expect(server.finish.mock.invocationCallOrder[0]).toBeLessThan(server.plan.mock.invocationCallOrder[0]!)
    expect(await (server.store.mock.calls[0]![1] as Blob).text()).toBe('bytes')
    // The name is what finish classifies the bytes by: a text file resumed is still a document.
    expect(server.finish).toHaveBeenCalledWith({ staging_key: key, file_name: 'notes.txt', content_type: 'text/plain', message_id: 'message-1' })
  })

  it('settles already-staged bytes after a restart without planning or uploading again', async () => {
    const key = 'staging/owner/11111111-1111-4111-8111-111111111111'
    const message = { ...task(), pendingKey: key }
    copies.set(message.sha256, new Blob(['bytes']))
    server.pending.mockResolvedValue({ uploads: [{ ...pending(message.messageId, message.sha256), staging_key: key }] })
    await resumeAttachmentUploads()
    await vi.waitFor(() => expect(progress.set).toHaveBeenLastCalledWith(message.messageId))
    expect(server.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ staging_key: key, message_id: message.messageId }))
    expect(server.plan).not.toHaveBeenCalled()
    expect(server.store).not.toHaveBeenCalled()
  })

  it('walks two expired generations and plans only the unissued successor', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const next = await contentRequestId('attachment-upload-permit', id)
    const last = await contentRequestId('attachment-upload-permit', next)
    const key = `staging/owner/${id}`
    const lastKey = `staging/owner/${last}`
    server.finish.mockRejectedValueOnce(refuse(410, 'expired'))
    server.plan.mockRejectedValueOnce(refuse(410, 'expired')).mockResolvedValue(plan(lastKey))
    await beginAttachmentUpload({ ...task(), pendingKey: key }, new Blob(['bytes']), null)
    expect(server.finish.mock.calls.map(([body]) => body.upload_key ?? body.staging_key)).toEqual([key, lastKey])
    expect(server.finish.mock.calls.every(([body]) => body.staging_key === key)).toBe(true)
    expect(server.plan.mock.calls.map(([body]) => body.request_id)).toEqual([next, last])
    expect(server.store).toHaveBeenCalledOnce()
  })

  it.each(['upload_used', 'conflict'])('only a precise signing conflict can finish a successor (%s)', async code => {
    const id = '11111111-1111-4111-8111-111111111111'
    const key = `staging/owner/${id}`
    const next = await contentRequestId('attachment-upload-permit', id)
    const nextKey = `staging/owner/${next}`
    server.finish.mockRejectedValueOnce(refuse(410, 'expired'))
    server.plan.mockRejectedValue(refuse(409, code))
    const run = beginAttachmentUpload({ ...task(), pendingKey: key }, new Blob(['bytes']), null)
    if (code === 'upload_used') {
      await run
      expect(server.finish).toHaveBeenCalledTimes(2)
      expect(server.finish).toHaveBeenLastCalledWith(expect.objectContaining({ staging_key: key, upload_key: nextKey }))
    } else {
      await expect(run).rejects.toMatchObject({ code })
      expect(server.finish).toHaveBeenCalledOnce()
    }
    expect(server.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ request_id: next }))
    expect(server.store).not.toHaveBeenCalled()
  })

  it('keeps a genuine denial from finish and does not obtain a plan', async () => {
    const key = 'staging/owner/11111111-1111-4111-8111-111111111111'
    server.finish.mockRejectedValue(refuse(403, 'denied'))
    await expect(beginAttachmentUpload({ ...task(), pendingKey: key }, new Blob(['bytes']), null)).rejects.toMatchObject({ code: 'denied' })
    expect(server.plan).not.toHaveBeenCalled()
  })

  it('a restart whose question to the server fails asks again by itself, then resumes', async () => {
    vi.useFakeTimers()
    try {
      copies.set('c'.repeat(64), new Blob(['bytes']))
      server.pending.mockRejectedValueOnce(refuse(503, 'unavailable')).mockResolvedValue({ uploads: [pending('message-6', 'c'.repeat(64))] })
      server.plan.mockResolvedValue(plan('upload/asked-again'))
      await expect(resumeAttachmentUploads()).rejects.toThrow()
      expect(server.store).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_100)
      expect(server.pending).toHaveBeenCalledTimes(2)
      expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ staging_key: 'pending/message-6', upload_key: 'upload/asked-again' }))
    } finally { vi.useRealTimers() }
  })

  it('bytes that do not go up fail the attachment (not the message) with a retry that uploads them again', async () => {
    server.store.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
    server.plan.mockResolvedValue(plan('upload/retry'))
    server.pending.mockResolvedValue({ uploads: [pending('message-3', 'a'.repeat(64))] })
    copies.set('a'.repeat(64), new Blob(['bytes']))
    void beginAttachmentUpload(task('message-3'), new Blob(['bytes']), plan('pending/message-3'))
    // The storage request is tried three times under the same plan.
    await vi.waitFor(() => expect(progress.fail).toHaveBeenCalled(), { timeout: 8000 })
    expect(server.store).toHaveBeenCalledTimes(3)
    expect(server.plan).not.toHaveBeenCalled()
    expect(progress.fail).toHaveBeenCalledExactlyOnceWith('message-3', expect.any(Function))
    expect(server.finish).not.toHaveBeenCalled()
    server.store.mockReset().mockResolvedValue(undefined)
    ;(progress.fail.mock.calls[0]![1] as () => void)()
    await vi.waitFor(() => expect(server.finish).toHaveBeenCalled())
    expect(server.plan).not.toHaveBeenCalled()
    expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ staging_key: 'pending/message-3' }))
    expect(server.store).toHaveBeenCalledExactlyOnceWith('https://bucket.test/pending/message-3', expect.any(Blob), expect.any(Function))
  }, 15_000)

  it('replays a lost rollover response after a restart with the same successor ID and original declaration', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const key = `staging/owner/${id}`
    const next = await contentRequestId('attachment-upload-permit', id)
    const nextKey = `staging/owner/${next}`
    const message = { ...task(), pendingKey: key }
    const expired = { ...plan(key), expires_at: new Date(Date.now() - 1).toISOString() }
    const issued = new Set([id])
    server.plan.mockImplementation(async ({ request_id }) => {
      if (request_id === id) throw refuse(410, 'expired')
      expect(request_id).toBe(next)
      if (!issued.has(request_id)) { issued.add(request_id); throw new TypeError('response was lost') }
      return plan(nextKey)
    })
    await expect(beginAttachmentUpload(message, new Blob(['bytes']), expired)).rejects.toThrow('response was lost')
    queue.dispose()
    queue = createDeclaredUploads({ endpoint, copyOf: async () => new Blob(['bytes']), progress: vi.fn() })
    server.pending.mockResolvedValue({ uploads: [{ ...pending('message-1', message.sha256), staging_key: key }] })
    server.finish.mockRejectedValueOnce(refuse(410, 'expired'))
    await resumeAttachmentUploads()
    await vi.waitFor(() => expect(server.finish).toHaveBeenCalledTimes(2))
    expect(server.plan.mock.calls.map(([body]) => body.request_id)).toEqual([id, next, next])
    expect(issued.size).toBe(2)
    expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ staging_key: key, upload_key: nextKey, message_id: message.messageId }))
  })

  it('passes quota refusal through the failure surface and retries the same ID when requested', async () => {
    const stages = vi.fn()
    queue.dispose()
    queue = createDeclaredUploads({ endpoint, copyOf: async () => new Blob(['bytes']), progress: stages })
    const message = task()
    copies.set(message.sha256, new Blob(['bytes']))
    server.pending.mockResolvedValue({ uploads: [pending(message.messageId, message.sha256)] })
    server.plan.mockRejectedValue(refuse(429, 'account_storage_full'))
    await expect(beginAttachmentUpload(message, new Blob(['bytes']), null)).rejects.toMatchObject({ code: 'account_storage_full' })
    expect(stages).toHaveBeenLastCalledWith(message.messageId, expect.objectContaining({ failed: true, final: false, reason: 'account_storage_full' }))
    await queue.retry(message.messageId)
    await vi.waitFor(() => expect(server.plan).toHaveBeenCalledTimes(2))
    expect(server.plan.mock.calls.map(([body]) => body.request_id)).toEqual([message.messageId, message.messageId])
    expect(server.store).not.toHaveBeenCalled()
  })

  it('a connection that comes back during storage backoff is used without another upload plan', async () => {
    vi.useFakeTimers()
    try {
      server.store.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      void beginAttachmentUpload(task('message-5'), new Blob(['bytes']), plan('pending/message-5'))
      await vi.runAllTimersAsync()
      expect(server.store).toHaveBeenCalledTimes(2)
      expect(server.plan).not.toHaveBeenCalled()
      expect(progress.fail).not.toHaveBeenCalled()
      expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ staging_key: 'pending/message-5' }))
      expect(progress.set).toHaveBeenLastCalledWith('message-5')
    } finally { vi.useRealTimers() }
  })

  it.each(['upload_mismatch', 'too_large', 'storage 413'])('%s fails for good without scheduling another upload', async failure => {
    vi.useFakeTimers()
    try {
      if (failure === 'storage 413') server.store.mockRejectedValue(new AttachmentsError('upload', 413, 'failed', 'HTTP 413'))
      else server.finish.mockRejectedValue(refuse(failure === 'too_large' ? 413 : 409, failure))
      await beginAttachmentUpload(task(), new Blob(['other']), plan('pending/message-1')).catch(() => undefined)
      expect(progress.fail).toHaveBeenCalledExactlyOnceWith('message-1', undefined)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(server.store).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('a message discarded unsent stops its upload', async () => {
    let release!: () => void
    server.store.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const run = beginAttachmentUpload(task('message-4'), new Blob(['bytes']), plan('pending/message-4'))
    await vi.waitFor(() => expect(server.store).toHaveBeenCalledOnce())
    dropAttachmentUpload('message-4')
    release(); await run
    expect(server.finish).not.toHaveBeenCalled()
    expect(progress.fail).not.toHaveBeenCalled()
  })
})
