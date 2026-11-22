// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * A project folder's file beside an App holds that folder's workspace while it is shown. A call that fails (the machine did
 * not answer, its arguments routed nowhere) is that file's failure: said in its place, or — when the file is already gone —
 * logged; ❌ thrown out of the effect's cleanup into the page's error boundary.
 */
const rpc = vi.hoisted(() => ({
  folderRuntime: { openFolder: vi.fn(), acquireFolderWorkspace: vi.fn(), releaseFolderWorkspace: vi.fn() },
}))
const warn = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', async (importOriginal) => ({ ...(await importOriginal<object>()), rpc }))
vi.mock('../../../../apps/desktop/src/session/renderer/utils/logger', () => ({ log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/open-with', () => ({ pickSessionOpener: async () => ({ preview: true }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/sessions/workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/sessions/file-view/workspace-file-view', () => ({ WorkspaceFileView: () => <div data-testid="preview" /> }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/extension-tab-pane', () => ({ ExtensionTabPane: () => null }))

const { PeekFolderFile } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/peek-folder-file')

let h: ReturnType<typeof createReactHarness>
beforeEach(() => {
  h = createReactHarness()
  warn.mockReset()
  rpc.folderRuntime.openFolder.mockReset().mockResolvedValue({ success: true })
  rpc.folderRuntime.acquireFolderWorkspace.mockReset().mockResolvedValue({ success: true })
  rpc.folderRuntime.releaseFolderWorkspace.mockReset().mockResolvedValue({ success: true })
})
afterEach(() => h.cleanup())

const target = { kind: 'folder' as const, place: { workspace: 'folder:dev-b/w1' } as never, deviceId: 'dev-b', projectId: 'p1', workspaceId: 'w1', path: 'hello.txt', absolutePath: '/srv/hello.txt', name: 'hello.txt', ask: false }

it('a release that fails when the file closes is logged, and the page stays', async () => {
  rpc.folderRuntime.releaseFolderWorkspace.mockRejectedValue(new Error('the arguments point at several machines'))
  await h.render(<PeekFolderFile target={target} tabId="t1" />)
  await vi.waitFor(() => expect(h.container.querySelector('[data-testid="preview"]')).not.toBeNull())
  await act(async () => { await h.render(<div data-testid="closed" />) })
  expect(h.container.querySelector('[data-testid="closed"]')).not.toBeNull()
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[peek] the folder was not let go', expect.objectContaining({ project: 'w1', workspaceId: 'w1' })))
  expect(rpc.folderRuntime.releaseFolderWorkspace).toHaveBeenCalledWith('w1', 'w1')
})

it('holding the folder fails: the file says why in its place', async () => {
  rpc.folderRuntime.acquireFolderWorkspace.mockRejectedValue(new Error('that machine did not answer'))
  await h.render(<PeekFolderFile target={target} tabId="t1" />)
  await vi.waitFor(() => expect(h.container.textContent).toContain('that machine did not answer'))
  expect(h.container.querySelector('[data-testid="preview"]')).toBeNull()
  expect(rpc.folderRuntime.releaseFolderWorkspace).not.toHaveBeenCalled()
})
