// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendAttachmentBatch } from '../../../../apps/desktop/src/components/chat/sendAttachmentBatch'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const upload = vi.hoisted(() => vi.fn())
const keep = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({ keepSentAttachment: keep }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/attachmentsEndpoint')>(),
  attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token' }),
}))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(), uploadAttachmentBytes: upload }))
vi.mock('../../../../apps/desktop/src/lib/chatThreadGate', () => ({ requireThreadCapableChat: async (id: string) => { if (id === 'dm') throw new Error('private chats do not support threads') } }))
function fixture() {
  const stageAttachment = vi.fn(async (_message: MessageItem) => {})
  const commitAttachment = vi.fn(async (_message: MessageItem, _prepared: unknown, _commit: unknown, _timing?: unknown) => {})
  const failAttachmentUpload = vi.fn(async (_id: string, _error: unknown, _reason: string, _retry: () => void) => {})
  const discard = vi.fn(async () => {})
  const outbox = { stageAttachment, commitAttachment, failAttachmentUpload, outbox: { discard } }
  const appendMessage = vi.fn()
  return { stageAttachment, commitAttachment, failAttachmentUpload, discard, args: {
    chatId: 'group', senderId: 'user', toUserIds: ['peer'], appendMessage, outbox,
    files: [new File(['png'], 'photo.png', { type: 'image/png' })],
  } }
}
const pdf = (name = 'second.pdf') => new File(['pdf'], name, { type: 'application/pdf' })
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  upload.mockReset().mockImplementation(async (_endpoint, file) => `staging/${file.name}`)
  keep.mockClear()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('attachment ownership transfers to the durable chat outbox', () => {
  it('persists its source id before showing a placeholder or starting an upload', async () => {
    const f = fixture()
    const id = await sendAttachmentBatch(f.args)
    const message = f.stageAttachment.mock.calls[0][0]
    expect(id).toBe(message.id)
    expect(f.args.appendMessage).toHaveBeenCalledWith(message)
    expect(f.stageAttachment.mock.invocationCallOrder[0]).toBeLessThan(f.args.appendMessage.mock.invocationCallOrder[0])
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
    expect(f.stageAttachment.mock.invocationCallOrder[0]).toBeLessThan(upload.mock.invocationCallOrder[0])
    expect(f.commitAttachment).toHaveBeenCalledWith(message, { staging_key: 'staging/photo.png' }, expect.objectContaining({ message_id: id, to_user_ids: ['peer'] }), expect.anything())
  })
  it('keeps the original whisper, reply, thread and caption on the queued commit', async () => {
    const f = fixture()
    await sendAttachmentBatch({ ...f.args, isWhisper: true, replyToMessageId: 'source', threadRootId: 'thread', caption: '① Move this' })
    expect(f.args.appendMessage.mock.calls[0][0]).toMatchObject({ is_whisper: true, reply_to_message_id: 'source', thread_root_id: 'thread' })
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ is_whisper: true, reply_to_message_id: 'source', thread_root_id: 'thread', caption: '① Move this' }), expect.anything()))
  })
  it('returns the last row once every file is on screen, before any byte has gone up', async () => {
    const f = fixture()
    const finish: Array<(key: string) => void> = []
    upload.mockImplementation(() => new Promise<string>(resolve => { finish.push(resolve) }))
    const id = await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
    expect(f.args.appendMessage).toHaveBeenCalledTimes(2)
    expect(id, 'a text sent with the files waits for the last one').toBe(f.stageAttachment.mock.calls[1][0].id)
    expect(f.commitAttachment).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(finish).toHaveLength(2))
    finish[0]('staging/photo'); finish[1]('staging/second')
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
  })
  it('keeps a local copy of an image only once its upload succeeded', async () => {
    const f = fixture()
    upload.mockRejectedValueOnce(new AttachmentsError('upload', 403, 'denied', 'quota denied'))
    await sendAttachmentBatch(f.args)
    await vi.waitFor(() => expect(f.failAttachmentUpload).toHaveBeenCalledOnce())
    expect(keep).not.toHaveBeenCalled()
    await sendAttachmentBatch(f.args)
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
    expect(keep).toHaveBeenCalledWith(f.args.files[0])
    expect(keep.mock.invocationCallOrder[0]).toBeLessThan(f.commitAttachment.mock.invocationCallOrder[0])
  })
  it('an upload failure fails only its own row, and resending uploads the same bytes under it', async () => {
    const f = fixture()
    upload.mockRejectedValueOnce(new AttachmentsError('upload', 403, 'denied', 'quota denied'))
    await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
    const [first, second] = f.stageAttachment.mock.calls.map(([row]) => row)
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
    expect(f.commitAttachment.mock.calls[0][0], 'the next file still goes').toBe(second)
    expect(f.failAttachmentUpload).toHaveBeenCalledExactlyOnceWith(first.id, expect.any(AttachmentsError), expect.any(String), expect.any(Function))
    expect(f.discard, 'the failed row stays in the conversation').not.toHaveBeenCalled()
    f.failAttachmentUpload.mock.calls[0][3]()
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
    expect(f.commitAttachment.mock.calls[1][0]).toBe(first)
    expect(upload.mock.calls.map(([, file]) => file.name)).toEqual(['photo.png', 'second.pdf', 'photo.png'])
  })
  it('cleans earlier upload markers if staging a later file fails', async () => {
    const f = fixture()
    f.stageAttachment.mockResolvedValueOnce().mockRejectedValueOnce(new Error('disk full'))
    await expect(sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })).rejects.toThrow('disk full')
    expect(f.discard.mock.calls).toEqual(f.stageAttachment.mock.calls.map(([row]) => [row.id]))
    expect(upload).not.toHaveBeenCalled()
  })
  it('failed durable staging leaves ownership in the composer and sends no bytes', async () => {
    const f = fixture()
    f.stageAttachment.mockRejectedValueOnce(new Error('disk full'))
    await expect(sendAttachmentBatch(f.args)).rejects.toThrow('disk full')
    expect(f.args.appendMessage).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
  it('refuses private-chat threads before staging or uploading', async () => {
    const f = fixture()
    await expect(sendAttachmentBatch({ ...f.args, chatId: 'dm', threadRootId: 'root' })).rejects.toThrow('private chats')
    expect(upload).not.toHaveBeenCalled()
    expect(f.stageAttachment).not.toHaveBeenCalled()
  })
  it('puts the caption on the last image, preserving file order at commit readiness', async () => {
    const f = fixture()
    await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf('spec.pdf')], caption: 'look' })
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
    expect(f.commitAttachment.mock.calls).toEqual([
      [expect.anything(), { staging_key: 'staging/photo.png' }, expect.objectContaining({ caption: 'look', content_type: 'image/png' }), expect.anything()],
      [expect.anything(), { staging_key: 'staging/spec.pdf' }, expect.not.objectContaining({ caption: expect.anything() }), expect.anything()],
    ])
  })
})
it('a later file never commits before an earlier one that is still uploading', async () => {
  const f = fixture()
  let finishFirst!: (key: string) => void
  upload.mockImplementationOnce(() => new Promise<string>(resolve => { finishFirst = resolve }))
  await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.commitAttachment).not.toHaveBeenCalled()
  finishFirst('staging/photo')
  await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
  expect(f.commitAttachment.mock.calls.map(([row]) => row.id)).toEqual(f.stageAttachment.mock.calls.map(([row]) => row.id))
})
it('waits for publication before committing the next file in the batch', async () => {
  const f = fixture()
  let finish!: () => void
  f.commitAttachment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
  await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
  finish()
  await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
})
it('a refused native publication fails that row; the next file still commits', async () => {
  const f = fixture()
  f.commitAttachment.mockRejectedValueOnce(new Error('native publish refused'))
  await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
  await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(f.failAttachmentUpload).toHaveBeenCalledOnce())
  expect(f.failAttachmentUpload.mock.calls[0][0]).toBe(f.stageAttachment.mock.calls[0][0].id)
  expect(f.discard).not.toHaveBeenCalled()
})
