// @vitest-environment jsdom
// A preview's bytes are read, and the read acknowledged by the server, on every opening: nothing is kept once
// the preview closes, so a file withdrawn since (or a member removed) is refused on the next opening, and the preview that
// showed it takes it down and says why.
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileReadRevokedError } from '@gugu/core/shared/fileResolver'
import { createReactHarness } from '../../../support/testHarness'
import { freshReplicaAccount } from '../../../support/replicaAccount'

const io = vi.hoisted(() => ({ resolves: 0, acknowledgements: 0, acknowledged: () => Promise.resolve() as Promise<void> }))
vi.mock('@/lib/fileAccess', async (original) => ({
  ...await original<object>(),
  fileReader: () => ({ accountId: 'every-open-reader' }),
  fileReadSignal: () => undefined,
  resolveFile: async () => {
    io.resolves += 1
    return { status: 'ready', revision: { sha256: null, source: 'cloud', file_name: 'notes.txt', content_type: 'text/plain', size_bytes: 5 }, reader: { accountId: 'every-open-reader' } }
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
  MessageFilePreviewPanel: ({ content, error, loading }: { content: unknown; error?: string; loading?: boolean }) =>
    createElement('aside', null, error ?? (loading ? 'loading' : String(content))),
}))

const { MessageFilePreview } = await import('@/components/chat/MessageFilePreview')
const { i18n } = await import('@/i18n')

const file = { kind: 'file' as const, fileName: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5, source: { kind: 'item' as const, itemId: 'notes', version: 3 } }

describe('a preview reads and acknowledges its bytes on every opening', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    await freshReplicaAccount('every-open-reader')
    io.resolves = 0
    io.acknowledgements = 0
    io.acknowledged = () => Promise.resolve()
    harness = createReactHarness()
  })
  afterEach(() => { harness.cleanup() })
  const open = async () => {
    await harness.render(createElement(MessageFilePreview, { file, readOnly: true, onClose: () => undefined }))
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const close = () => harness.render(null)

  it('opened again, it reads and acknowledges again; a refusal then takes it down and says why (❌ bytes kept from the first opening)', async () => {
    await open()
    expect(harness.container.textContent).toBe('notes')
    await close()
    // Withdrawn since: the server now refuses what it acknowledged before.
    io.acknowledged = () => Promise.reject(new FileReadRevokedError('access'))
    await open()
    expect(io.resolves).toBe(2)
    expect(io.acknowledgements).toBe(2)
    expect(harness.container.textContent).toBe(i18n.getFixedT('zh-CN', 'messaging')('attachmentView.fileNoAccess'))
  })
})
