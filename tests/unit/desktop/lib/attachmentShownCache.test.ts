// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshReplicaAccount } from '../../../support/replicaAccount'

/** A preview's bytes go through the attachment content cache: an immutable source is read once; a refusal drops it. */
const io = vi.hoisted(() => ({ resolves: 0, acknowledged: () => Promise.resolve() as Promise<void> }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', async (original) => ({
  ...await original<object>(),
  fileReader: () => ({ accountId: 'owner' }),
  fileReadSignal: () => undefined,
  resolveFile: async () => {
    io.resolves += 1
    return { status: 'ready', revision: { sha256: null, source: 'cloud', file_name: 'a.txt', content_type: 'text/plain', size_bytes: 1 }, reader: { accountId: 'owner' } }
  },
}))
vi.mock('@gugu/core/shared/fileResolver', async (original) => ({
  ...await original<object>(),
  shownFileBlob: async () => ({ blob: new Blob(['a']), acknowledged: io.acknowledged() }),
}))

beforeEach(async () => {
  io.resolves = 0
  io.acknowledged = () => Promise.resolve()
  await freshReplicaAccount('owner')
})

describe('attachment content cache', () => {
  it('reads a versioned file once for every preview that opens it', async () => {
    const { shownAttachmentBytes } = await import('../../../../apps/desktop/src/lib/attachmentBytes')
    const source = { kind: 'item', itemId: 'item-1', version: 3 } as const
    await shownAttachmentBytes(source)
    await shownAttachmentBytes(source)
    expect(io.resolves).toBe(1)
    // Another version is other content: read for itself.
    await shownAttachmentBytes({ kind: 'item', itemId: 'item-1', version: 4 })
    expect(io.resolves).toBe(2)
  })

  it('a refused acknowledgement drops the kept bytes: the next preview reads again', async () => {
    const { shownAttachmentBytes } = await import('../../../../apps/desktop/src/lib/attachmentBytes')
    const source = { kind: 'item', itemId: 'item-2', version: 1 } as const
    io.acknowledged = () => Promise.reject(new Error('refused'))
    const first = await shownAttachmentBytes(source)
    await expect(first.acknowledged).rejects.toThrow('refused')
    io.acknowledged = () => Promise.resolve()
    await shownAttachmentBytes(source)
    expect(io.resolves).toBe(2)
  })
})
