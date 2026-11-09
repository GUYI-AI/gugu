// @vitest-environment jsdom
// Every attachment source reads through its own path; a file kept in a task's session never reaches the file resolver.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachmentFileRef, parseAttachmentContent, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { attachmentBytes, attachmentMetadata, sourceKeyOf } from '@/lib/attachmentBytes'
import { lendSessionFileReader } from '@/lib/sessionFileReaders'

const io = vi.hoisted(() => ({ resolve: vi.fn(), blob: vi.fn(), put: vi.fn(), dispose: vi.fn() }))
vi.mock('@/lib/fileAccess', () => ({
  resolveFile: io.resolve, fileReader: () => ({ accountId: 'account', actorId: 'account' }), fileReadSignal: () => undefined,
  attachmentCache: async () => ({ put: io.put, delete: vi.fn() }), putAttachment: io.put, attachmentCacheOrigin: 'https://attachments.test',
}))
vi.mock('@gugu/core/shared/fileResolver', async original => ({ ...await original<typeof import('@gugu/core/shared/fileResolver')>(), fileBlob: io.blob }))

const revision = { source: 'managed-object', file_name: 'a.png', content_type: 'image/png', size_bytes: 4, sha256: 'a'.repeat(64) }
const pixels = 'data:image/png;base64,iVBORw0KGgo='
const url: AttachmentSource = { kind: 'url', url: 'https://x/a.png' }
const item: AttachmentSource = { kind: 'item', itemId: 'file', version: 2 }
const message: AttachmentSource = { kind: 'message', messageId: 'msg' }
const attachment: AttachmentSource = { kind: 'attachment', attachmentId: 'att' }
const session: AttachmentSource = { kind: 'session-file', sessionId: 'session-1', path: '/home/a/chart.png', sha256: 'b'.repeat(64) }
const gone: AttachmentSource = { kind: 'gone' }

beforeEach(() => {
  vi.clearAllMocks()
  io.blob.mockResolvedValue(new Blob(['full']))
  io.resolve.mockResolvedValue({ status: 'ready', revision, reader: { accountId: 'account' }, dispose: io.dispose, content: async () => new Blob(['thumb']) })
})

describe('sources the file resolver reads', () => {
  it.each([[item, { item_id: 'file', version: 2 }], [message, { message_id: 'msg' }], [attachment, { attachment_id: 'att' }]] as const)('%j resolves by its own reference', async (source, ref) => {
    expect(attachmentFileRef(source)).toEqual(ref)

    expect(await attachmentBytes(source, 'full')).toMatchObject({ status: 'ready', link: revision })
    expect(io.resolve.mock.calls.at(-1)![0]).toEqual(ref)

    expect(await attachmentBytes(source, 'thumb')).toMatchObject({ status: 'ready', link: revision })
    expect(io.resolve.mock.calls.at(-1)![0]).toEqual(ref)
    expect(io.resolve.mock.calls.at(-1)![2]).toMatchObject({ purpose: 'preview' })

    expect(await attachmentMetadata(source)).toEqual({ status: 'ready', revision })
    expect(io.resolve.mock.calls.at(-1)![0]).toEqual(ref)
  })

  it.each([url, gone])('%j has no reference: it is gone without asking the resolver', async source => {
    expect(attachmentFileRef(source)).toBeNull()
    expect(await attachmentBytes(source, 'full')).toEqual({ status: 'gone', sha256: null })
    expect(await attachmentBytes(source, 'thumb')).toEqual({ status: 'gone', sha256: null })
    expect(await attachmentMetadata(source)).toEqual({ status: 'gone', sha256: null })
    expect(io.resolve).not.toHaveBeenCalled()
  })

  it('names each source apart, so one never shows another\'s cached picture', () => {
    const keys = [url, item, message, attachment, session, gone].map(sourceKeyOf)
    expect(new Set(keys).size).toBe(keys.length)
    expect(sourceKeyOf({ ...session, sha256: 'c'.repeat(64) })).not.toBe(sourceKeyOf(session))
  })
})

describe('a file kept in a task\'s session', () => {
  it.each(['full', 'thumb'] as const)('reads its %s bytes with the reader its timeline lends, never the file resolver', async variant => {
    const read = vi.fn(async () => pixels)
    const giveBack = lendSessionFileReader('session-1', read)
    const bytes = await attachmentBytes(session, variant)
    giveBack()
    expect(read).toHaveBeenCalledWith('/home/a/chart.png')
    expect(bytes).toMatchObject({ status: 'ready', link: { source: 'local', file_name: 'chart.png', sha256: 'b'.repeat(64) } })
    expect(io.resolve).not.toHaveBeenCalled()
    expect(io.put).not.toHaveBeenCalled()
  })

  it('is missing when the machine cannot read it, and says so loudly when no timeline lends a reader', async () => {
    const giveBack = lendSessionFileReader('session-1', async () => null)
    expect(await attachmentBytes(session, 'thumb')).toEqual({ status: 'missing' })
    giveBack()
    await expect(attachmentBytes(session, 'thumb')).rejects.toThrow()
    await expect(attachmentBytes({ ...session, sessionId: null }, 'thumb')).rejects.toThrow()
  })

  it('a timeline giving back its reader does not take away a newer one', async () => {
    const first = lendSessionFileReader('session-1', async () => pixels)
    const second = lendSessionFileReader('session-1', async () => pixels)
    first()
    expect((await attachmentBytes(session, 'thumb')).status).toBe('ready')
    second()
  })

  it('needs no read to draw its file card', async () => {
    expect(await attachmentMetadata(session)).toMatchObject({ status: 'ready', revision: { sha256: 'b'.repeat(64) } })
    expect(io.resolve).not.toHaveBeenCalled()
  })

  it('only applies to a row with no chat pointer: a folder item or message bytes still win', () => {
    const envelope = '[附件] a.png (image/png)\n[Size] 1\n[Kind] image'
    const kept = { path: '/home/a/a.png', sha256: 's' }
    expect(parseAttachmentContent(envelope, { id: 'msg', session_file: { ...kept, session_id: 'session-1' } })?.source).toEqual({ kind: 'session-file', sessionId: 'session-1', path: '/home/a/a.png', sha256: 's' })
    expect(parseAttachmentContent(envelope, { id: 'msg', file_item_id: 'item', file_version: 1, session_file: kept })?.source).toEqual({ kind: 'item', itemId: 'item', version: 1 })
    expect(parseAttachmentContent(envelope, { id: 'msg', file_blob_id: 'blob', session_file: kept })?.source).toEqual({ kind: 'message', messageId: 'msg' })
    expect(parseAttachmentContent(envelope, { id: 'msg' })?.source).toEqual({ kind: 'gone' })
  })
})
