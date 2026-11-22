// @vitest-environment jsdom
// @@@local-first: a preview whose version's bytes are already on this machine shows them without asking the server; only
// bytes that are not here are authorized (resolve) and read, so a file withdrawn (or a member removed) is refused to whoever
// does not have its bytes yet, and a preview that showed bytes whose read is then refused takes them down and says why.
import { createHash } from 'node:crypto'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileReadRevokedError } from '@gugu/core/shared/fileResolver'
import { createReactHarness } from '../../../support/testHarness'
import { freshReplicaAccount } from '../../../support/replicaAccount'

const io = vi.hoisted(() => ({
  resolves: 0, acknowledgements: 0, acknowledged: () => Promise.resolve() as Promise<void>, refused: false,
  sha: '', cache: new Map<string, Blob>(),
}))
vi.mock('@/lib/fileAccess', async (original) => ({
  ...await original<object>(),
  fileReader: () => ({ accountId: 'every-open-reader', actorId: 'every-open-reader' }),
  fileReadSignal: () => undefined,
  nativeLocalBytes: async () => null,
  // This account's Cache Storage: the kept copy and the remembered version live here across previews.
  attachmentCache: async () => ({
    match: async (key: string) => io.cache.has(key) ? new Response(io.cache.get(key)) : undefined,
    delete: async (key: string) => io.cache.delete(key),
  }),
  putAttachment: async (key: string, blob: Blob) => { io.cache.set(key, blob) },
  resolveFile: async () => {
    io.resolves += 1
    if (io.refused) return { status: 'gone', sha256: null }
    return { status: 'ready', dispose: async () => undefined, fromDisk: async () => false, reader: { accountId: 'every-open-reader' },
      revision: { sha256: io.sha, source: 'managed-object', item_id: 'notes', version: 3, file_name: 'notes.txt', content_type: 'text/plain', size_bytes: 5 } }
  },
}))
vi.mock('@gugu/core/shared/fileResolver', async (original) => ({
  ...await original<object>(),
  shownFileBlob: async () => {
    io.acknowledgements += 1
    return { blob: new Blob(['notes']), acknowledged: io.acknowledged() }
  },
}))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [] }) }))
vi.mock('@/components/chat/MessageFilePreviewPanel', () => ({
  MessageFilePreviewPanel: ({ content, error, loading, connection }: { content: unknown; error?: string; loading?: boolean; connection?: unknown }) =>
    createElement('aside', null, connection as never, error ?? (loading ? 'loading' : String(content))),
}))

const { MessageFilePreview } = await import('@/components/chat/MessageFilePreview')
const { i18n } = await import('@/i18n')

const file = { kind: 'file' as const, fileName: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5, source: { kind: 'item' as const, itemId: 'notes', version: 3 } }
const noAccess = () => i18n.getFixedT('zh-CN', 'messaging')('attachmentView.fileNoAccess')
let versions = 0

describe("a preview's bytes: here, shown at once; not here, authorized and read", () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    // A reader this machine has never seen and a version it has never read.
    await freshReplicaAccount(`every-open-reader-${++versions}`)
    io.resolves = 0
    io.acknowledgements = 0
    io.acknowledged = () => Promise.resolve()
    io.refused = false
    io.cache.clear()
    // Each case is a version of the same bytes this run has not read yet (the kept copy is checked against its digest).
    io.sha = createHash('sha256').update('notes').digest('hex')
    harness = createReactHarness()
  })
  afterEach(() => { harness.cleanup() })
  const open = async () => {
    await harness.render(createElement(MessageFilePreview, { file, readOnly: true, onClose: () => undefined }))
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const close = () => harness.render(null)

  it('opened again with its bytes here: shown without asking the server, even after it was withdrawn', async () => {
    await open()
    expect(harness.container.textContent).toBe('notes')
    expect(io.resolves).toBe(1)
    await close()
    io.refused = true
    await open()
    expect(harness.container.textContent).toBe('notes')
    expect(io.resolves).toBe(1)
    expect(io.acknowledgements).toBe(1)
  })

  it('a read refused after it was shown is taken down, keeps nothing, and the next opening asks again and is refused', async () => {
    io.acknowledged = () => Promise.reject(new FileReadRevokedError('access'))
    await open()
    expect(harness.container.textContent).toBe(noAccess())
    await close()
    io.refused = true
    await open()
    expect(io.resolves).toBe(2)
    expect(harness.container.textContent).not.toBe('notes')
  })

  it('a version never read here is authorized first: withdrawn, it is refused', async () => {
    io.refused = true
    await open()
    expect(io.resolves).toBe(1)
    expect(io.acknowledgements).toBe(0)
    expect(harness.container.textContent).not.toBe('notes')
  })
})
