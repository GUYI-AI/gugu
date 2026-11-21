// @vitest-environment jsdom
// 本机刚发出去的图:按内容(sha256)存一份本地完整副本,确认后的那一行直接用它画缩略图,不再签名、下载一遍。
import { createElement } from 'react'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import type { FileMetadata } from '@gugu/core/shared/fileResolver'

const f = vi.hoisted(() => ({ resolve: vi.fn(), store: new Map<string, unknown>() }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({
  resolveFile: f.resolve,
  fileReader: () => ({ accountId: 'account-1', actorId: 'account-1' }),
  fileReadSignal: () => undefined,
  nativeLocalCopy: async () => null,
  // Holds node:buffer Blobs: jsdom's Blob (and a Response's, here) has no stream(); the renderer's does.
  attachmentCache: async () => ({ match: async (key: string) => f.store.has(key) ? { blob: async () => f.store.get(key) } : undefined,
    put: async (key: string, response: Response) => { f.store.set(key, new NodeBlob([await response.arrayBuffer()])) } }),
  putAttachment: async (key: string, body: Blob) => { f.store.set(key, new NodeBlob([await body.arrayBuffer()])) },
  attachmentCacheOrigin: 'https://attachments.gugu.invalid',
  // Where a version is kept, asked after a failed read: these files are not on a machine.
  fileMetadata: async () => ({ status: 'gone' }),
}))

import { attachmentBytes, keepSentAttachment, useAttachmentObjectUrl } from '../../../../apps/desktop/src/lib/attachmentBytes'
import { queryClient as attachmentQueryClient } from '../../../../apps/desktop/src/lib/replica'
// The replica reads for the signed-in account, as the product publishes it.
;(await import('../../../../apps/desktop/src/lib/replica')).followRendererSession('SIGNED_IN', 'owner')

const file = new NodeBlob(['local png bytes'], { type: 'image/png' }) as unknown as Blob
const sha256 = 'c31ecc1f113b9873b72782c15123e0215c6d6f616964d5b3a27ce230d584bd77'
const source: AttachmentSource = { kind: 'item', itemId: 'item-1', version: 1 }
const metadataFor = (sha: string): FileMetadata => ({ status: 'ready', revision: {
  source: 'managed-object', item_id: 'item-1', version: 1, file_name: 'a.png', content_type: 'image/png', size_bytes: file.size, sha256: sha, width: 4, height: 3,
} as never })

let shownText: Promise<string> | null = null
function Thumb({ metadata }: { metadata: FileMetadata }) {
  const view = useAttachmentObjectUrl(source, 'thumb', true, metadata)
  return createElement('span', { 'data-status': view.status })
}

describe('a sent image after its commit', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    attachmentQueryClient.clear(); f.store.clear(); shownText = null
    f.resolve.mockReset().mockImplementation(async () => { throw new Error('network read') })
    URL.createObjectURL = vi.fn((blob: Blob) => { shownText = blob.text(); return 'blob:thumb' })
    URL.revokeObjectURL = vi.fn()
    harness = createReactHarness()
  })
  afterEach(() => harness.cleanup())
  const status = () => harness.container.querySelector('span')?.getAttribute('data-status')

  it('draws the kept local copy: no file resolve, no download', async () => {
    await keepSentAttachment(file)
    expect([...f.store.keys()]).toEqual([`https://attachments.gugu.invalid/account/account-1/sha256/${sha256}`])
    await harness.render(createElement(Thumb, { metadata: metadataFor(sha256) }))
    await vi.waitFor(() => expect(status()).toBe('ready'))
    expect(await shownText).toBe('local png bytes')
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it('a committed sha256 the local copy does not match reads the file as before', async () => {
    await keepSentAttachment(file)
    await harness.render(createElement(Thumb, { metadata: metadataFor('b'.repeat(64)) }))
    await vi.waitFor(() => expect(status()).toBe('failed'))
    expect(f.resolve).toHaveBeenCalledTimes(1)
  })
})

// Opened again (or opened after sending it): the read is authorized afresh, and its bytes are the copy kept here.
describe('a kept copy opened in full', () => {
  beforeEach(() => { f.store.clear(); f.resolve.mockReset() })
  it('reads no bytes once the read is authorized', async () => {
    await keepSentAttachment(file)
    const read = vi.fn(), dispose = vi.fn(async () => {})
    f.resolve.mockResolvedValue({ status: 'ready', purpose: 'file', reader: { accountId: 'account-1' }, revision: (metadataFor(sha256) as Extract<FileMetadata, { status: 'ready' }>).revision, read, stream: read, dispose })
    const bytes = await attachmentBytes(source, 'shown')
    expect(bytes.status).toBe('ready')
    expect(await (bytes as { blob: Blob }).blob.text()).toBe('local png bytes')
    expect(read).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
  it('keeps bytes that came over the network, and none of bytes read from this machine\'s disk', async () => {
    for (const here of [false, true]) {
      f.store.clear()
      const chunk = new Uint8Array(await file.arrayBuffer())
      f.resolve.mockResolvedValue({ status: 'ready', purpose: 'file', reader: { accountId: 'account-1' }, revision: (metadataFor(sha256) as Extract<FileMetadata, { status: 'ready' }>).revision,
        read: async () => chunk, stream: async function* () { yield chunk }, dispose: async () => {}, fromDisk: async () => here })
      expect((await attachmentBytes(source, 'full')).status).toBe('ready')
      expect(f.store.size).toBe(here ? 0 : 1)
    }
  })
  it('a read no longer authorized is not answered from the copy', async () => {
    await keepSentAttachment(file)
    f.resolve.mockResolvedValue({ status: 'gone', sha256 })
    expect(await attachmentBytes(source, 'full')).toEqual({ status: 'gone', sha256 })
  })
})
