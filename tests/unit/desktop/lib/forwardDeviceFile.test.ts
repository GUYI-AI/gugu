// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { metadata, bytes } = vi.hoisted(() => ({ metadata: vi.fn(), bytes: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({ attachmentMetadata: metadata, attachmentBytes: bytes }))
vi.mock('../../../../apps/desktop/src/lib/fileHost', () => ({ holderOfflineText: ({ machine }: { machine: string }) => `${machine} offline` }))
vi.mock('../../../../apps/desktop/src/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/i18n')>()
  return { ...actual, i18n: { ...actual.i18n, t: (key: string) => key } }
})

import { deviceFileCopy } from '../../../../apps/desktop/src/lib/forwardDeviceFile'
import { forwardingDeviceFiles } from '../../../../apps/desktop/src/store/chatOutboxWiring'
import { FORWARD_MAX_BYTES } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels'

const file = { itemId: 'i', version: 2, name: 'a.png', document: false }
const local = (over = {}) => ({ status: 'ready', revision: { source: 'local', file_name: 'a.png', content_type: 'image/png', size_bytes: 3, host_online: true, host_label: 'box', ...over } })

describe('deviceFileCopy', () => {
  beforeEach(() => { metadata.mockReset(); bytes.mockReset() })

  it('reads a file kept on a machine into a new file of the same name and type', async () => {
    metadata.mockResolvedValue(local())
    bytes.mockResolvedValue({ status: 'ready', blob: new Blob(['abc']) })
    const copy = await deviceFileCopy(file)
    expect(metadata).toHaveBeenCalledWith({ kind: 'item', itemId: 'i', version: 2 })
    expect([copy?.name, copy?.type, copy?.size]).toEqual(['a.png', 'image/png', 3])
  })

  it('reads an attachment message by its message', async () => {
    metadata.mockResolvedValue(local())
    bytes.mockResolvedValue({ status: 'ready', blob: new Blob(['abc']) })
    await deviceFileCopy({ id: 'm', content_type: 'attachment' } as never)
    expect(bytes).toHaveBeenCalledWith({ kind: 'message', messageId: 'm' })
  })

  it('leaves everything else to go by reference', async () => {
    expect(await deviceFileCopy({ id: 'm', content_type: 'text' } as never)).toBeNull()
    expect(await deviceFileCopy({ ...file, document: true })).toBeNull()
    expect(metadata).not.toHaveBeenCalled()
    metadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object' } })
    expect(await deviceFileCopy(file)).toBeNull()
    metadata.mockResolvedValue({ status: 'expired' })
    expect(await deviceFileCopy(file)).toBeNull()
    expect(bytes).not.toHaveBeenCalled()
  })

  it('says it is too large before reading', async () => {
    metadata.mockResolvedValue(local({ size_bytes: FORWARD_MAX_BYTES + 1 }))
    await expect(deviceFileCopy(file)).rejects.toThrow('forward.fileTooLarge')
    expect(bytes).not.toHaveBeenCalled()
  })

  it('names the machine when the read fails because it is off, and keeps any other failure as it is', async () => {
    metadata.mockResolvedValue(local({ host_online: false }))
    bytes.mockRejectedValue(new Error('no copy'))
    await expect(deviceFileCopy(file)).rejects.toThrow('box offline')
    metadata.mockResolvedValue(local())
    await expect(deviceFileCopy(file)).rejects.toThrow('no copy')
  })

  it('reads a copy while its machine is off', async () => {
    metadata.mockResolvedValue(local({ host_online: false }))
    bytes.mockResolvedValue({ status: 'ready', blob: new Blob(['abc']) })
    expect((await deviceFileCopy(file))?.size).toBe(3)
  })

  it('sends the copy instead of forwarding by reference, and anything else by reference', async () => {
    const forwardMessage = vi.fn(async (_source: unknown, _targetChatId: string, _opts?: { toUserIds?: string[] }) => undefined), send = vi.fn(async (_chatId: string, _files: File[]) => undefined)
    const { forwardMessage: forward } = forwardingDeviceFiles({ forwardMessage }, send)
    metadata.mockResolvedValue(local())
    bytes.mockResolvedValue({ status: 'ready', blob: new Blob(['abc']) })
    await forward(file, 'target')
    expect(send).toHaveBeenCalledWith('target', [expect.objectContaining({ name: 'a.png' })], undefined)
    expect(forwardMessage).not.toHaveBeenCalled()
    metadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object' } })
    await forward(file, 'target', { toUserIds: ['bot'] })
    expect(forwardMessage).toHaveBeenCalledWith(file, 'target', { toUserIds: ['bot'] })
    expect(send).toHaveBeenCalledOnce()
  })

  it('sends a captioned message as its file with the same caption, and each message of a batch as its own file', async () => {
    const forwardMessage = vi.fn(async (_source: unknown, _targetChatId: string, _opts?: { toUserIds?: string[] }) => undefined), send = vi.fn(async (_chatId: string, _files: File[], _opts?: { caption?: string }) => undefined)
    const { forwardMessage: forward } = forwardingDeviceFiles({ forwardMessage }, send)
    const message = (id: string, name: string, caption?: string) => ({ id, content_type: 'attachment', file_item_id: id, file_version: 1,
      content: `${attachmentEnvelope(name, 3, 'image/png')}${caption ? `\n[Caption]\n${caption}` : ''}` }) as never
    metadata.mockImplementation(async ({ messageId }: { messageId: string }) => local({ file_name: `${messageId}.png` }))
    bytes.mockResolvedValue({ status: 'ready', blob: new Blob(['abc']) })
    // A batch forward is one forward per message: three files, the last with the caption they were sent with.
    for (const source of [message('a', 'a.png'), message('b', 'b.png'), message('c', 'c.png', 'the **three** shots')]) await forward(source, 'target')
    expect(send.mock.calls.map(([chat, files, opts]) => [chat, files.map((file) => file.name), opts])).toEqual([
      ['target', ['a.png'], undefined], ['target', ['b.png'], undefined], ['target', ['c.png'], { caption: 'the **three** shots' }]])
    expect(bytes.mock.calls.map(([source]) => source)).toEqual(['a', 'b', 'c'].map((messageId) => ({ kind: 'message', messageId })))
    expect(forwardMessage).not.toHaveBeenCalled()
  })
})
