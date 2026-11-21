// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/** A folder's file beside an App, while what is installed cannot be read: said with a retry (❌ a blank pane, an unhandled rejection). */
const pick = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/open-with', () => ({ pickSessionOpener: pick }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/sessions/workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/sessions/file-view/workspace-file-view', () => ({ WorkspaceFileView: () => <div data-testid="preview" /> }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/extension-tab-pane', () => ({ ExtensionTabPane: () => null }))

const { PeekFolderFile } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/peek-folder-file')

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); pick.mockReset() })
afterEach(() => h.cleanup())

const target = { kind: 'folder' as const, place: { workspace: 'session:s1' } as never, projectId: 'p1', workspaceId: 'w1', path: 'notes.md', absolutePath: '/w/notes.md', name: 'notes.md', ask: false }

it('the installed list unreadable: the failure is said, and its retry asks again', async () => {
  pick.mockRejectedValue(new Error('installed list unreadable'))
  await h.render(<PeekFolderFile target={target} tabId="t1" />)
  const failed = () => h.container.querySelector('[data-read-failed]')
  await vi.waitFor(() => expect(failed()).not.toBeNull())
  pick.mockResolvedValue({ preview: true })
  await act(async () => { (failed()!.querySelector('button') as HTMLButtonElement).click() })
  await vi.waitFor(() => expect(h.container.querySelector('[data-testid="preview"]')).not.toBeNull())
  expect(pick).toHaveBeenCalledTimes(2)
})
