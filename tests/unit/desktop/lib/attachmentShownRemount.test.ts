// A file preview mounted again (its group left and come back to, its tab out of the retained window) is authorized again
// (file-resolve on every opening) and then shows the bytes of that version it already read; one mounted while they are on
// their way joins that read and its progress instead of reading the version again from the start.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import type { FileProgress } from '@gugu/core/shared/fileResolver'

const f = vi.hoisted(() => ({ resolve: vi.fn(), reads: 0 }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({
  resolveFile: f.resolve,
  fileReader: () => ({ accountId: 'account-1', actorId: 'account-1' }),
  fileReadSignal: () => undefined,
  attachmentCache: async () => ({ match: async () => undefined, put: async () => undefined, delete: async () => true }),
  putAttachment: async () => undefined,
  nativeLocalBytes: async () => null,
  attachmentCacheOrigin: 'https://attachments.gugu.invalid',
}))

import { attachmentBytes, SHOWN_KEEP_BYTES } from '../../../../apps/desktop/src/lib/attachmentBytes'

type Options = { progress?: FileProgress }
let sha = 0
const nextSha = () => (++sha).toString(16).padStart(64, '0')
/** A version's handle: its bytes come when `arrive` is called (at once unless held), saying their progress as they do. */
function version(digest: string | null, options: { size?: number; acknowledged?: () => Promise<void>; hold?: boolean } = {}) {
  let arrive!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve })
  if (!options.hold) arrive()
  const size = options.size ?? 3
  const handle = (opts: Options) => ({
    status: 'ready', purpose: 'file', reader: { accountId: 'account-1', actorId: 'account-1' },
    revision: { sha256: digest, size_bytes: size, content_type: 'text/html', source: 'managed-object' as const },
    read: async () => new Uint8Array(size), dispose: async () => undefined, fromDisk: async () => false,
    acknowledgement: options.acknowledged ?? (() => Promise.resolve()),
    async *stream() { f.reads += 1; opts.progress?.(1, 3); await arrived; opts.progress?.(3, 3); yield new Uint8Array(size) },
  })
  return { arrive: () => arrive(), handle }
}
const serve = (v: ReturnType<typeof version>) => f.resolve.mockImplementation(async (_ref: unknown, _reader: unknown, opts: Options) => v.handle(opts))

describe("a preview's bytes across openings", () => {
  beforeEach(() => { f.reads = 0; f.resolve.mockReset() })

  it('every opening is authorized again; the bytes of a version are read once', async () => {
    serve(version(nextSha()))
    const source: AttachmentSource = { kind: 'item', itemId: 'i-1', version: 2 }
    const first = await attachmentBytes(source, 'shown')
    const again = await attachmentBytes(source, 'shown')
    expect(f.resolve).toHaveBeenCalledTimes(2)
    expect(f.reads).toBe(1)
    expect(first.status === 'ready' && again.status === 'ready' && again.blob === first.blob).toBe(true)
  })

  it('an opening refused by its authorization shows nothing of what was read before', async () => {
    serve(version(nextSha()))
    const source: AttachmentSource = { kind: 'message', messageId: 'm-refused' }
    expect((await attachmentBytes(source, 'shown')).status).toBe('ready')
    f.resolve.mockResolvedValueOnce({ status: 'gone', sha256: null })
    expect((await attachmentBytes(source, 'shown')).status).toBe('gone')
  })

  it('a preview opened during the read joins it, and hears its progress from where it is', async () => {
    const v = version(nextSha(), { hold: true })
    serve(v)
    const source: AttachmentSource = { kind: 'message', messageId: 'm-1' }
    const firstProgress = vi.fn(), secondProgress = vi.fn()
    const first = attachmentBytes(source, 'shown', undefined, undefined, firstProgress)
    await vi.waitFor(() => expect(firstProgress).toHaveBeenCalledWith(1, 3))
    const second = attachmentBytes(source, 'shown', undefined, undefined, secondProgress)
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0)) // its authorization answered: it is waiting on the first read
    v.arrive()
    const [a, b] = await Promise.all([first, second])
    expect(f.reads).toBe(1)
    expect(secondProgress).toHaveBeenCalledWith(3, 3)
    expect(a.status === 'ready' && b.status === 'ready' && a.blob === b.blob).toBe(true)
  })

  it('another version is another read', async () => {
    serve(version(nextSha()))
    await attachmentBytes({ kind: 'item', itemId: 'i-2', version: 2 }, 'shown')
    serve(version(nextSha()))
    await attachmentBytes({ kind: 'item', itemId: 'i-2', version: 3 }, 'shown')
    expect(f.reads).toBe(2)
  })

  it('bytes whose read acknowledgement fails are read again next time', async () => {
    let refuse!: (error: Error) => void
    const refused = new Promise<void>((_resolve, reject) => { refuse = reject })
    serve(version(nextSha(), { acknowledged: () => refused }))
    const source: AttachmentSource = { kind: 'attachment', attachmentId: 'a-1' }
    const first = await attachmentBytes(source, 'shown')
    refuse(new Error('revoked'))
    await expect(first.status === 'ready' ? first.acknowledged : undefined).rejects.toThrow('revoked')
    await vi.waitFor(async () => {
      await attachmentBytes(source, 'shown')
      expect(f.reads).toBe(2)
    })
  })

  it('a version without a digest is read on every opening', async () => {
    serve(version(null))
    const source: AttachmentSource = { kind: 'message', messageId: 'm-no-sha' }
    await attachmentBytes(source, 'shown')
    await attachmentBytes(source, 'shown')
    expect(f.reads).toBe(2)
  })

  it('keeps at most SHOWN_KEEP_BYTES: the least recently opened goes first, a file larger than that is not kept', async () => {
    const third = Math.floor(SHOWN_KEEP_BYTES / 3) + 1
    const [a, b, c] = [nextSha(), nextSha(), nextSha()].map(digest => version(digest, { size: third }))
    const open = async (v: typeof a, id: string) => { serve(v); await attachmentBytes({ kind: 'message', messageId: id }, 'shown') }
    await open(a, 'a'); await open(b, 'b')
    await open(a, 'a') // a is the most recent now
    expect(f.reads).toBe(2)
    await open(c, 'c') // over the cap: b goes
    await open(a, 'a'); await open(c, 'c')
    expect(f.reads).toBe(3)
    await open(b, 'b')
    expect(f.reads).toBe(4)
    const big = version(nextSha(), { size: SHOWN_KEEP_BYTES + 1 })
    await open(big, 'big'); await open(big, 'big')
    expect(f.reads).toBe(6)
  })
})
