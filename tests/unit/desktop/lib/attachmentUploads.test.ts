import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'

// Owner 11-15: a message is its text and its files' index. The bytes go up behind the delivered message; what is still to
// upload is the server's answer (pending), and the bytes are this device's copy of what it sent, kept by content, so a
// restart resumes them. Their state is the attachment's, never the message's.
const api = vi.hoisted(() => ({ plan: vi.fn(), upload: vi.fn(), finish: vi.fn(), pending: vi.fn() }))
const progress = vi.hoisted(() => ({ set: vi.fn(), fail: vi.fn() }))
const copies = vi.hoisted(() => new Map<string, Blob>())
const changed = vi.hoisted(() => vi.fn())
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(),
  planAttachmentUpload: api.plan, uploadAttachmentPlan: api.upload, finishAttachment: api.finish, pendingAttachmentUploads: api.pending }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' }) }))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({ cachedAttachmentCopy: async (sha: string) => copies.get(sha) ?? null }))
vi.mock('../../../../apps/desktop/src/lib/attachmentChanges', () => ({ noteAttachmentChanged: changed }))
vi.mock('../../../../apps/desktop/src/lib/attachmentSendTiming', async original => ({ ...await original<object>(), attachmentAttemptEndpoint: (endpoint: unknown) => endpoint }))
vi.mock('../../../../apps/desktop/src/lib/attachmentUploadProgress', () => ({ setAttachmentUploadProgress: progress.set, failAttachmentUploadProgress: progress.fail }))

const { beginAttachmentUpload, resumeAttachmentUploads, dropAttachmentUpload, resumingCopy } = await import('../../../../apps/desktop/src/lib/attachmentUploads')

const plan = (key: string) => ({ staging_key: key, url: 'https://bucket.test', fields: {}, max_bytes: 100, expires_at: new Date(Date.now() + 600_000).toISOString() })
const task = (messageId = 'message-1', as = 'sender') => ({ messageId, chatId: 'chat', as, pendingKey: `pending/${messageId}`, name: 'photo.png', contentType: 'image/png', size: 5 })
const pending = (messageId: string, sha: string) => ({ staging_key: `pending/${messageId}`, message_id: messageId, chat_id: 'chat', as: 'sender', sha256: sha, size_bytes: 5, content_type: 'image/png' })
const notFound = () => new AttachmentsError('finish', 404, 'upload_not_found', 'no declared upload')

beforeEach(() => {
  copies.clear(); changed.mockReset()
  api.plan.mockReset(); api.upload.mockReset().mockResolvedValue(undefined); api.finish.mockReset().mockResolvedValue(undefined); api.pending.mockReset().mockResolvedValue([])
  progress.set.mockReset(); progress.fail.mockReset()
})

describe('attachment bytes go up behind their message', () => {
  it('uploads under the commit\'s plan, waits for the commit\'s declaration, then finishes it', async () => {
    api.upload.mockImplementation(async (_endpoint, _plan, _file, _existing, onProgress: (p: { loaded: number; total: number }) => void) => {
      onProgress({ loaded: 2, total: 5 }); onProgress({ loaded: 5, total: 5 })
    })
    // The bytes beat the message's commit: the server does not know the declaration yet, then it does.
    api.finish.mockRejectedValueOnce(notFound())
    await beginAttachmentUpload(task(), new Blob(['bytes']), plan('pending/message-1'))
    expect(api.finish).toHaveBeenCalledTimes(2)
    expect(api.finish).toHaveBeenLastCalledWith(expect.anything(), { staging_key: 'pending/message-1', file_name: 'photo.png', content_type: 'image/png', message_id: 'message-1' })
    expect(progress.set).toHaveBeenCalledWith('message-1', { loaded: 2, total: 5, attempt: 1 })
    expect(progress.set).toHaveBeenLastCalledWith('message-1')
    expect(progress.fail).not.toHaveBeenCalled()
  })

  it('an offline sender resumes after a restart: the server\'s list, this device\'s copy, a new plan, finished under the new key', async () => {
    copies.set('a'.repeat(64), new Blob(['bytes']))
    // Another device sent the second one: this device holds no copy and leaves it to that device.
    api.pending.mockResolvedValue([pending('message-1', 'a'.repeat(64)), pending('message-2', 'b'.repeat(64))])
    api.plan.mockResolvedValue(plan('upload/again'))
    await resumeAttachmentUploads()
    expect(changed, 'the sender\'s bubble draws its copy under the ring').toHaveBeenCalledExactlyOnceWith('message-1')
    expect(await resumingCopy('message-1')?.text()).toBe('bytes')
    await vi.waitFor(() => expect(api.finish).toHaveBeenCalledOnce())
    expect(api.plan).toHaveBeenCalledExactlyOnceWith(expect.anything(), { size: 5, contentType: 'image/png' }, { chat_id: 'chat', as: 'sender' }, expect.anything())
    expect(await (api.upload.mock.calls[0]![2] as { bytes: Blob }).bytes.text()).toBe('bytes')
    expect(api.finish).toHaveBeenCalledWith(expect.anything(), { staging_key: 'pending/message-1', upload_key: 'upload/again', file_name: '', content_type: 'image/png', message_id: 'message-1' })
    await vi.waitFor(() => expect(resumingCopy('message-1')).toBeNull())
  })

  it('bytes that do not go up fail the attachment (not the message) with a retry that uploads them again', async () => {
    api.upload.mockRejectedValue(new TypeError('connection lost'))
    api.plan.mockResolvedValue(plan('upload/retry'))
    void beginAttachmentUpload(task('message-3'), new Blob(['bytes']), plan('pending/message-3'))
    // Three attempts (1 s, then 2 s apart), each under a new plan after the first.
    await vi.waitFor(() => expect(progress.fail).toHaveBeenCalled(), { timeout: 8000 })
    expect(api.upload).toHaveBeenCalledTimes(3)
    expect(progress.fail).toHaveBeenCalledExactlyOnceWith('message-3', expect.any(Function))
    expect(api.finish).not.toHaveBeenCalled()
    api.upload.mockReset().mockResolvedValue(undefined)
    ;(progress.fail.mock.calls[0]![1] as () => void)()
    await vi.waitFor(() => expect(api.finish).toHaveBeenCalled())
    expect(api.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ staging_key: 'pending/message-3', upload_key: 'upload/retry' }))
  }, 15_000)

  it('bytes that are not the declared file fail for good: no retry', async () => {
    api.finish.mockRejectedValue(new AttachmentsError('finish', 409, 'upload_mismatch', 'not the declared file'))
    await beginAttachmentUpload(task(), new Blob(['other']), plan('pending/message-1')).catch(() => undefined)
    expect(progress.fail).toHaveBeenCalledExactlyOnceWith('message-1', undefined)
  })

  it('a message discarded unsent stops its upload', async () => {
    let release!: () => void
    api.upload.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const run = beginAttachmentUpload(task('message-4'), new Blob(['bytes']), plan('pending/message-4'))
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledOnce())
    dropAttachmentUpload('message-4')
    release(); await run
    expect(api.finish).not.toHaveBeenCalled()
    expect(progress.fail).not.toHaveBeenCalled()
  })
})
