// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collapseSendGroups } from '../../../../apps/desktop/src/components/chat/messageAlbum'
import { sendAttachmentBatch } from '../../../../apps/desktop/src/components/chat/sendAttachmentBatch'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import type { MessageItem } from '@gugu/core/shared/types/chat'
// Preparing declares a file (its sha256, a plan) and starts its bytes behind the message; the batch only orders the commits.
const prepare = vi.hoisted(() => vi.fn())
const keep = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({ keepSentAttachment: keep }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/attachmentsEndpoint')>(),
  attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token' }),
  prepareChatAttachment: prepare,
}))
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
const declared = (name: string) => ({ staging_key: `staging/${name}`, sha256: 'sha', size_bytes: 3 })
const pdf = (name = 'second.pdf') => new File(['pdf'], name, { type: 'application/pdf' })
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  prepare.mockReset().mockImplementation(async (_endpoint, file: File) => declared(file.name))
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
    expect(f.stageAttachment.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0])
    expect(f.commitAttachment).toHaveBeenCalledWith(message, declared('photo.png'), expect.objectContaining({ message_id: id, to_user_ids: ['peer'] }), expect.anything(), undefined, expect.any(Function))
  })
  it('keeps the original whisper, reply, thread and caption on the queued commit', async () => {
    const f = fixture()
    await sendAttachmentBatch({ ...f.args, isWhisper: true, replyToMessageId: 'source', threadRootId: 'thread', caption: '① Move this' })
    expect(f.args.appendMessage.mock.calls[0][0]).toMatchObject({ is_whisper: true, reply_to_message_id: 'source', thread_root_id: 'thread' })
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ is_whisper: true, reply_to_message_id: 'source', thread_root_id: 'thread', caption: '① Move this' }), expect.anything(), undefined, expect.any(Function)))
  })
  it('returns the last row once every file is on screen, before any file is declared', async () => {
    const f = fixture()
    const finish: Array<(value: unknown) => void> = []
    prepare.mockImplementation(() => new Promise(resolve => { finish.push(resolve) }))
    const id = await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
    expect(f.args.appendMessage).toHaveBeenCalledTimes(2)
    expect(id, 'a text sent with the files waits for the last one').toBe(f.stageAttachment.mock.calls[1][0].id)
    expect(f.commitAttachment).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(finish).toHaveLength(2))
    finish[0](declared('photo')); finish[1](declared('second'))
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
  })
  it('keeps a local copy of a project chat image before its commit; a cloud file was kept as it was declared', async () => {
    const f = fixture()
    await sendAttachmentBatch(f.args)
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
    expect(keep).not.toHaveBeenCalled()
    prepare.mockImplementationOnce(async (_endpoint, file: File) => ({ local: file }))
    await sendAttachmentBatch(f.args)
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
    expect(keep).toHaveBeenCalledWith(f.args.files[0])
    expect(keep.mock.invocationCallOrder[0]).toBeLessThan(f.commitAttachment.mock.invocationCallOrder[1])
  })
  it('a refused declaration fails only its own row, and resending declares the same file under it', async () => {
    const f = fixture()
    prepare.mockRejectedValueOnce(new AttachmentsError('upload', 403, 'denied', 'quota denied'))
    await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
    const [first, second] = f.stageAttachment.mock.calls.map(([row]) => row)
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
    expect(f.commitAttachment.mock.calls[0][0], 'the next file still goes').toBe(second)
    expect(f.failAttachmentUpload).toHaveBeenCalledExactlyOnceWith(first.id, expect.any(AttachmentsError), expect.any(String), expect.any(Function))
    expect(f.discard, 'the failed row stays in the conversation').not.toHaveBeenCalled()
    f.failAttachmentUpload.mock.calls[0][3]()
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
    expect(f.commitAttachment.mock.calls[1][0]).toBe(first)
    expect(prepare.mock.calls.map(([, file]) => file.name)).toEqual(['photo.png', 'second.pdf', 'photo.png'])
    expect(prepare.mock.calls.map(([, , scope]) => scope.message_id), 'each under its own row').toEqual([first.id, second.id, first.id])
  })
  it('reuses the selected File and source message after a transient loss while declaring, publishing only once', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const file = f.args.files[0]
      prepare.mockRejectedValueOnce(new TypeError('upload connection lost'))
      const done = sendAttachmentBatch(f.args)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      expect(f.commitAttachment).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      const id = await done
      expect(prepare).toHaveBeenCalledTimes(2)
      for (const [, selected] of prepare.mock.calls) expect(selected).toBe(file)
      expect(f.stageAttachment).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
      expect(f.commitAttachment.mock.calls[0][0].id).toBe(id)
    } finally { vi.useRealTimers() }
  })
  it('cleans earlier upload markers if staging a later file fails', async () => {
    const f = fixture()
    f.stageAttachment.mockResolvedValueOnce().mockRejectedValueOnce(new Error('disk full'))
    await expect(sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })).rejects.toThrow('disk full')
    expect(f.discard.mock.calls).toEqual(f.stageAttachment.mock.calls.map(([row]) => [row.id]))
    expect(prepare).not.toHaveBeenCalled()
  })
  it('failed durable staging leaves ownership in the composer and sends no bytes', async () => {
    const f = fixture()
    f.stageAttachment.mockRejectedValueOnce(new Error('disk full'))
    await expect(sendAttachmentBatch(f.args)).rejects.toThrow('disk full')
    expect(f.args.appendMessage).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })
  it('refuses private-chat threads before staging or uploading', async () => {
    const f = fixture()
    await expect(sendAttachmentBatch({ ...f.args, chatId: 'dm', threadRootId: 'root' })).rejects.toThrow('private chats')
    expect(prepare).not.toHaveBeenCalled()
    expect(f.stageAttachment).not.toHaveBeenCalled()
  })
  it('#2581 sends the files as one send with the text on the last file, whatever its kind, in file order', async () => {
    const f = fixture()
    await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf('spec.pdf')], caption: 'look' })
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(2))
    expect(f.commitAttachment.mock.calls).toEqual([
      [expect.anything(), declared('photo.png'), expect.not.objectContaining({ caption: expect.anything() }), expect.anything(), undefined, expect.any(Function)],
      [expect.anything(), declared('spec.pdf'), expect.objectContaining({ caption: 'look' }), expect.anything(), undefined, expect.any(Function)],
    ])
    type Group = { send_group_id?: string; send_group_size?: number }
    const [first, second] = (f.commitAttachment.mock.calls as unknown as Array<[Group, unknown, Group]>).map(([row, , commit]) => ({ row, commit }))
    expect(first!.commit.send_group_id).toEqual(expect.any(String))
    expect([first!.commit.send_group_id, first!.commit.send_group_size]).toEqual([second!.commit.send_group_id, 2])
    expect([first!.row.send_group_id, second!.row.send_group_id]).toEqual([first!.commit.send_group_id, first!.commit.send_group_id])
  })
  it.each(['cloud', 'native'] as const)('#2581 four screenshots plus text keep one album after %s publication', async route => {
    const f = fixture()
    const files = Array.from({ length: 4 }, (_, index) => new File(['png'], `screen-${index}.png`, { type: 'image/png' }))
    prepare.mockImplementation(async (_endpoint, file: File) => route === 'native' ? { local: file } : declared(file.name))
    await sendAttachmentBatch({ ...f.args, files, caption: '你看看' })
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(4))
    type Commit = { send_group_id?: string; send_group_size?: number; caption?: string }
    const calls = f.commitAttachment.mock.calls as unknown as Array<[MessageItem, unknown, Commit]>
    const commits = calls.map(([, , commit]) => commit)
    const id = commits[0]!.send_group_id
    expect(id).toEqual(expect.any(String))
    expect(commits.map(commit => [commit.send_group_id, commit.send_group_size])).toEqual(Array(4).fill([id, 4]))
    expect(commits.map(commit => commit.caption)).toEqual([undefined, undefined, undefined, '你看看'])
    // A new reader has only authoritative rows. The SQL publication test separately proves these fields persist.
    const delivered = calls.map(([placeholder, , commit], index) => ({ type: 'message' as const, message: {
      ...placeholder, seq: index + 1, local_send_state: undefined,
      send_group_id: commit.send_group_id, send_group_size: commit.send_group_size,
    } }))
    const album = collapseSendGroups(delivered)
    expect(album.rows).toHaveLength(1)
    expect(album.albums.get(delivered[0]!.message.id)?.map(row => row.id)).toEqual(delivered.map(row => row.message.id))
  })
  it('more files than one send holds go as consecutive sends of at most ten, the text on the very last file', async () => {
    const f = fixture()
    const files = Array.from({ length: 21 }, (_, index) => pdf(`f${index}.pdf`))
    await sendAttachmentBatch({ ...f.args, files, caption: 'all' })
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(21))
    type Group = { send_group_id?: string; send_group_size?: number; caption?: string }
    const commits = (f.commitAttachment.mock.calls as unknown as Array<[unknown, unknown, Group]>).map(([, , commit]) => commit)
    const sends = [commits.slice(0, 10), commits.slice(10, 20)]
    for (const send of sends) expect(send.map(commit => [commit.send_group_id, commit.send_group_size])).toEqual(Array(10).fill([send[0]!.send_group_id, 10]))
    expect(sends[0]![0]!.send_group_id).not.toBe(sends[1]![0]!.send_group_id)
    expect(commits[20]).not.toHaveProperty('send_group_id')
    expect(commits.map(commit => commit.caption)).toEqual([...Array(20).fill(undefined), 'all'])
  })
  it('#2581 a file sent alone is not a send of several', async () => {
    const f = fixture()
    await sendAttachmentBatch({ ...f.args, caption: 'one' })
    await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledTimes(1))
    const [row, , commit] = f.commitAttachment.mock.calls[0] as unknown as [{ send_group_id?: string }, unknown, object]
    expect(commit).not.toHaveProperty('send_group_id')
    expect(row.send_group_id).toBeUndefined()
  })
})
it('a later file never commits before an earlier one that is still being declared', async () => {
  const f = fixture()
  let finishFirst!: (value: unknown) => void
  prepare.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
  await sendAttachmentBatch({ ...f.args, files: [...f.args.files, pdf()] })
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.commitAttachment).not.toHaveBeenCalled()
  finishFirst(declared('photo'))
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
