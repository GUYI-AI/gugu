import { beforeEach, describe, expect, it, vi } from 'vitest'

// Owner 11-15: a message is its text and its files' index. The bytes go up behind the delivered message; what is still to
// upload is the server's answer (pending), and the bytes are this device's copy of what it sent, kept by content, so a
// restart resumes them. Their state is the attachment's, never the message's. The upload itself is core's one path
// (finishDeclaredAttachment), the same agents take: the server is faked here at the network.
const server = vi.hoisted(() => ({ plan: vi.fn(), store: vi.fn(), finish: vi.fn(), pending: vi.fn() }))
const progress = vi.hoisted(() => ({ set: vi.fn(), fail: vi.fn() }))
const copies = vi.hoisted(() => new Map<string, Blob>())
const changed = vi.hoisted(() => vi.fn())
const refuse = (status: number, error: string) => Object.assign(new Error(error), { status, error })
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't',
  fetch: async (url: string, init: { body: string }) => {
    const route = url.split('/').at(-1)!, body = JSON.parse(init.body) as Record<string, unknown>
    try {
      const answer = await (route === 'upload' ? server.plan : route === 'finish' ? server.finish : server.pending)(body)
      return new Response(JSON.stringify(answer ?? {}), { status: 200 })
    } catch (error) {
      const said = error as { status?: number; error?: string }
      if (!said.status) throw error
      return new Response(JSON.stringify({ error: said.error, message: said.error }), { status: said.status })
    }
  },
  upload: async (url: string, init: { body: Blob | FormData }, onProgress?: (p: { loaded: number; total: number }) => void) => {
    await server.store(url, init.body instanceof FormData ? init.body.get('file') : init.body, onProgress)
    return { status: 200 }
  } }) }))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({ cachedAttachmentCopy: async (sha: string) => copies.get(sha) ?? null }))
vi.mock('../../../../apps/desktop/src/lib/attachmentChanges', () => ({ noteAttachmentChanged: changed }))
vi.mock('../../../../apps/desktop/src/lib/attachmentSendTiming', async original => ({ ...await original<object>(), attachmentAttemptEndpoint: (endpoint: unknown) => endpoint }))
vi.mock('../../../../apps/desktop/src/lib/attachmentUploadProgress', () => ({ setAttachmentUploadProgress: progress.set, failAttachmentUploadProgress: progress.fail }))

const { beginAttachmentUpload, resumeAttachmentUploads, dropAttachmentUpload, resumingCopy } = await import('../../../../apps/desktop/src/lib/attachmentUploads')

const plan = (key: string) => ({ staging_key: key, url: `https://bucket.test/${key}`, fields: {}, max_bytes: 100, expires_at: new Date(Date.now() + 600_000).toISOString() })
const task = (messageId = 'message-1', as = 'sender') => ({ messageId, chatId: 'chat', as, pendingKey: `pending/${messageId}`, name: 'photo.png', contentType: 'image/png', size: 5 })
const pending = (messageId: string, sha: string, file_name: string | null = 'notes.txt') => ({ staging_key: `pending/${messageId}`, message_id: messageId, chat_id: 'chat', as: 'sender', sha256: sha, size_bytes: 5, content_type: 'text/plain', file_name })
const notFound = () => refuse(404, 'upload_not_found')

beforeEach(() => {
  copies.clear(); changed.mockReset()
  server.plan.mockReset(); server.store.mockReset().mockResolvedValue(undefined); server.finish.mockReset().mockResolvedValue({}); server.pending.mockReset().mockResolvedValue({ uploads: [] })
  progress.set.mockReset(); progress.fail.mockReset()
})

describe('attachment bytes go up behind their message', () => {
  it('uploads under the commit\'s plan, waits for the commit\'s declaration, then finishes it', async () => {
    server.store.mockImplementation(async (_url, _file, onProgress: (p: { loaded: number; total: number }) => void) => {
      onProgress({ loaded: 2, total: 5 }); onProgress({ loaded: 5, total: 5 })
    })
    // The bytes beat the message's commit: the server does not know the declaration yet, then it does.
    server.finish.mockRejectedValueOnce(notFound())
    await beginAttachmentUpload(task(), new Blob(['bytes']), plan('pending/message-1'))
    expect(server.finish).toHaveBeenCalledTimes(2)
    expect(server.finish).toHaveBeenLastCalledWith({ staging_key: 'pending/message-1', file_name: 'photo.png', content_type: 'image/png', message_id: 'message-1' })
    expect(progress.set).toHaveBeenCalledWith('message-1', { loaded: 2, total: 5, attempt: 1 })
    expect(progress.set).toHaveBeenLastCalledWith('message-1')
    expect(progress.fail).not.toHaveBeenCalled()
  })

  it('an offline sender resumes after a restart: the server\'s list, this device\'s copy, a new plan, finished under the new key and the file\'s name', async () => {
    copies.set('a'.repeat(64), new Blob(['bytes']))
    // Another device sent the second one: this device holds no copy and leaves it to that device.
    server.pending.mockResolvedValue({ uploads: [pending('message-1', 'a'.repeat(64)), pending('message-2', 'b'.repeat(64))] })
    server.plan.mockResolvedValue(plan('upload/again'))
    await resumeAttachmentUploads()
    expect(changed, 'the sender\'s bubble draws its copy under the ring').toHaveBeenCalledExactlyOnceWith('message-1')
    expect(await resumingCopy('message-1')?.text()).toBe('bytes')
    await vi.waitFor(() => expect(server.finish).toHaveBeenCalledOnce())
    expect(server.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ size_bytes: 5, content_type: 'text/plain', chat_id: 'chat', as: 'sender' }))
    expect(await (server.store.mock.calls[0]![1] as Blob).text()).toBe('bytes')
    // The name is what finish classifies the bytes by: a text file resumed is still a document.
    expect(server.finish).toHaveBeenCalledWith({ staging_key: 'pending/message-1', upload_key: 'upload/again', file_name: 'notes.txt', content_type: 'text/plain', message_id: 'message-1' })
    await vi.waitFor(() => expect(resumingCopy('message-1')).toBeNull())
  })

  it('bytes that do not go up fail the attachment (not the message) with a retry that uploads them again', async () => {
    server.store.mockRejectedValue(new TypeError('connection lost'))
    server.plan.mockResolvedValue(plan('upload/retry'))
    void beginAttachmentUpload(task('message-3'), new Blob(['bytes']), plan('pending/message-3'))
    // Three attempts (1 s, then 2 s apart), each under a new plan after the first.
    await vi.waitFor(() => expect(progress.fail).toHaveBeenCalled(), { timeout: 8000 })
    expect(server.store).toHaveBeenCalledTimes(3)
    expect(progress.fail).toHaveBeenCalledExactlyOnceWith('message-3', expect.any(Function))
    expect(server.finish).not.toHaveBeenCalled()
    server.store.mockReset().mockResolvedValue(undefined)
    ;(progress.fail.mock.calls[0]![1] as () => void)()
    await vi.waitFor(() => expect(server.finish).toHaveBeenCalled())
    expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ staging_key: 'pending/message-3', upload_key: 'upload/retry' }))
  }, 15_000)

  it('a connection that comes back right after the failure is used without anyone pressing retry', async () => {
    vi.useFakeTimers()
    try {
      server.store.mockRejectedValue(new TypeError('connection lost'))
      server.plan.mockResolvedValue(plan('upload/later'))
      void beginAttachmentUpload(task('message-5'), new Blob(['bytes']), plan('pending/message-5'))
      await vi.advanceTimersByTimeAsync(3_100)
      expect(progress.fail).toHaveBeenCalledOnce()
      server.store.mockReset().mockResolvedValue(undefined) // back within 3 s of the failure
      await vi.advanceTimersByTimeAsync(5_000)
      expect(server.finish).toHaveBeenCalledWith(expect.objectContaining({ staging_key: 'pending/message-5', upload_key: 'upload/later' }))
      expect(progress.set).toHaveBeenLastCalledWith('message-5')
    } finally { vi.useRealTimers() }
  })

  it('bytes that are not the declared file fail for good: no retry', async () => {
    server.finish.mockRejectedValue(refuse(409, 'upload_mismatch'))
    await beginAttachmentUpload(task(), new Blob(['other']), plan('pending/message-1')).catch(() => undefined)
    expect(progress.fail).toHaveBeenCalledExactlyOnceWith('message-1', undefined)
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
