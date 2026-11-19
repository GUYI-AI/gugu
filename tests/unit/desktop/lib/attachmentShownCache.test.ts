// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshReplicaAccount } from '../../../support/replicaAccount'

/** A preview's bytes are read and acknowledged on every open: nothing withdrawn keeps showing from an earlier read. */
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

describe('a preview asks the server on every open', () => {
  it('a versioned file is resolved and acknowledged again each time a preview opens it (❌ bytes kept from an earlier open)', async () => {
    const { shownAttachmentBytes } = await import('../../../../apps/desktop/src/lib/attachmentBytes')
    const source = { kind: 'item', itemId: 'item-1', version: 3 } as const
    await shownAttachmentBytes(source)
    // Withdrawn since (or the member removed): the server now refuses what it acknowledged before.
    io.acknowledged = () => Promise.reject(new Error('withdrawn'))
    const again = await shownAttachmentBytes(source)
    expect(io.resolves).toBe(2)
    await expect(again.acknowledged).rejects.toThrow('withdrawn')
  })
})
