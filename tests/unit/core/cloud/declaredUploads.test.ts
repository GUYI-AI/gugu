import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Owner 11-15: a message is its text and its files' index. The bytes go up behind the delivered message; what is still to
// upload is the server's answer (pending), and the host supplies this device's verified stored originals.
// The server is faked here at the network; no renderer or Electron dependencies enter the queue.
const server = vi.hoisted(() => ({ plan: vi.fn(), store: vi.fn(), finish: vi.fn(), pending: vi.fn() }))
const progress = vi.hoisted(() => ({ set: vi.fn(), fail: vi.fn() }))
const copies = vi.hoisted(() => new Map<string, Blob>())
const refuse = (status: number, error: string) => Object.assign(new Error(error), { status, error })
import { createDeclaredUploads } from '@gugu/core/cloud/declaredUploads'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
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
      expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ upload_key: 'upload/recovered' }))
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

  it('an offline sender resumes after a restart: the server\'s list, this device\'s copy, a new plan, finished under the new key and the file\'s name', async () => {
    copies.set('a'.repeat(64), new Blob(['bytes']))
    // Another device sent the second one: this device holds no copy and leaves it to that device.
    server.pending.mockResolvedValue({ uploads: [pending('message-1', 'a'.repeat(64)), pending('message-2', 'b'.repeat(64))] })
    server.plan.mockResolvedValue(plan('upload/again'))
    await resumeAttachmentUploads()
    await vi.waitFor(() => expect(server.finish).toHaveBeenCalledOnce())
    expect(server.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ size_bytes: 5, content_type: 'text/plain', chat_id: 'chat', as: 'sender' }))
    expect(await (server.store.mock.calls[0]![1] as Blob).text()).toBe('bytes')
    // The name is what finish classifies the bytes by: a text file resumed is still a document.
    expect(server.finish).toHaveBeenCalledWith({ staging_key: 'pending/message-1', upload_key: 'upload/again', file_name: 'notes.txt', content_type: 'text/plain', message_id: 'message-1' })
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
    expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ staging_key: 'pending/message-3', upload_key: 'upload/retry' }))
  }, 15_000)

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
