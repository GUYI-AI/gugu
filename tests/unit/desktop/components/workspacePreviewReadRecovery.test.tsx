// @vitest-environment jsdom
import { act, createElement } from 'react'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import { queryClient } from '@/lib/replica'
import { WorkspaceFileView } from '@/session/renderer/features/sessions/file-view/workspace-file-view'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const io = vi.hoisted(() => ({ read: vi.fn(), watch: vi.fn(), release: vi.fn() }))
vi.mock('@/session/renderer/features/sessions/workspace-backend/workspace-backend', () => ({
  workspaceBackend: () => ({ elsewhere: true }),
  workspaceEvents: { on: () => () => {} },
  workspaceRpc: () => ({ files: {
    readFile: io.read, readExternalFile: io.read,
    watchDirectory: io.watch, releaseDirectoryWatch: io.release,
  } }),
}))
vi.mock('@/session/renderer/features/sessions/stores/open-file-in-file-editor', () => ({ openPathWithFailureToast: vi.fn() }))
vi.mock('@/session/renderer/features/sessions/stores/session-selectors', () => ({ getSessionView: vi.fn() }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }))
vi.mock('@renderer/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/features/remote-hosts/workspace/remote-file-actions', () => ({ downloadSessionFile: vi.fn() }))
vi.mock('@renderer/lib/editor/quote-workspace-file', () => ({ quoteWorkspaceFile: vi.fn() }))
vi.mock('@/session/renderer/features/sessions/file-view/file-view-kinds', () => ({ FOLDER_APP_FILE_TAB: 'folder', openFolderInTab: vi.fn() }))

const defaults = queryClient.getDefaultOptions()
const translate = i18n.getFixedT('zh-CN', 'messaging')
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retryDelay: 0 } })
  await i18n.changeLanguage('zh-CN')
  vi.stubGlobal('Blob', NodeBlob)
  io.read.mockReset()
  io.watch.mockReset().mockResolvedValue({ success: true, data: { leaseId: 'preview-read-test' } })
  io.release.mockReset().mockResolvedValue(undefined)
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); queryClient.setDefaultOptions(defaults); vi.unstubAllGlobals() })
const draw = (inWorkspace = true) => renderWithAppProviders(harness, createElement(WorkspaceFileView, {
  projectId: 'p', workspaceId: 'w', path: 'notes.txt', absolutePath: '/task/notes.txt', inWorkspace, onClose: vi.fn(),
}))
const settled = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() })

describe('workspace hosted-preview read recovery', () => {
  it.each([true, false])('reads a structured truncated result once and offers the fallback (inside workspace: %s)', async inside => {
    io.read.mockResolvedValue({ success: true, data: { content: 'partial bytes must not appear', truncated: true, totalSize: 30_000_000 } })
    await draw(inside)
    await settled(() => expect(harness.container.textContent).toContain(translate('attachmentView.fileUnavailable')))
    expect(io.read).toHaveBeenCalledTimes(1)
    expect(harness.container.textContent).not.toContain('partial bytes must not appear')
    expect([...harness.container.querySelectorAll('button')].some(button => button.textContent === 'file.downloadInstead')).toBe(true)
  })

  it.each(['Temporary IPC failure', 'File too large: transient transport failure'])('retains automatic recovery for an ordinary transient error: %s', async reason => {
    io.read.mockRejectedValueOnce(new Error(reason)).mockResolvedValue({ success: true, data: { content: 'recovered workspace text', truncated: false, totalSize: 24 } })
    await draw()
    await settled(() => expect(harness.container.querySelector('pre')?.textContent).toBe('recovered workspace text'))
    expect(io.read).toHaveBeenCalledTimes(2)
    expect(harness.container.textContent).not.toContain(translate('attachmentView.fileUnavailable'))
  })
})
