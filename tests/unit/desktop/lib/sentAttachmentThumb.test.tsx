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
  // Holds node:buffer Blobs: jsdom's Blob (and a Response's, here) has no stream(); the renderer's does.
  attachmentCache: async () => ({ match: async (key: string) => f.store.has(key) ? { blob: async () => f.store.get(key) } : undefined,
    put: async (key: string, response: Response) => { f.store.set(key, new NodeBlob([await response.arrayBuffer()])) } }),
  putAttachment: async (key: string, body: Blob) => { f.store.set(key, new NodeBlob([await body.arrayBuffer()])) },
  attachmentCacheOrigin: 'https://attachments.gugu.invalid',
  // Where a version is kept, asked after a failed read: these files are not on a machine.
  fileMetadata: async () => ({ status: 'gone' }),
}))

import { keepSentAttachment, useAttachmentObjectUrl } from '../../../../apps/desktop/src/lib/attachmentBytes'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'

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
