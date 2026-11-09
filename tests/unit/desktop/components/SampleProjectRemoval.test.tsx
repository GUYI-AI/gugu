// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { clickElement, createNode, createReactHarness, fireContextMenu, waitForCondition } from '../../../support/testHarness'

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failWrite: false, toast: vi.fn() }))
vi.mock('@/lib/supabase', async () => {
  const { versionedSettingsClient } = await import('../../../support/versionedSettingsTestDouble')
  return { identityDb: versionedSettingsClient(io) }
})
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => ({ ownerId: 'u', ownerName: 'Ana', ownerAvatar: null }) }))
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { currentViewId: 'home' } }, sidebarStore: { sidebarProjects: [{ id: 'actual-project' }] },
}))
vi.mock('@renderer/app/screen-layout', () => ({ screenLayout: { focusedBlockId: null, blocks: new Map() } }))
vi.mock('@renderer/app/screen-layout-actions', () => ({ isScreenView: () => false, showOnScreen: vi.fn(), showBesideOnScreen: vi.fn() }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: io.toast }))

const { SampleProjectSidebar } = await import('@/session/renderer/features/sidebar/sample-project-row')
beforeEach(() => {
  io.rows.clear(); io.failWrite = false; io.toast.mockReset()
  io.rows.set('u/user', { user_id: 'u', scope: 'user', config: { sampleProject: { version: 1, dismissed: false }, keep: 'preference' }, updated_at: '2026-11-07T00:00:00.000Z' })
})

async function removeFromRow(harness: ReturnType<typeof createReactHarness>) {
  await harness.render(createNode(SampleProjectSidebar))
  await waitForCondition(() => !!harness.container.querySelector('[role="treeitem"]'), 'sample row shown')
  await fireContextMenu(harness.container.querySelector<HTMLElement>('[role="treeitem"]')!)
  const item = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent === 'projects.sample.remove')
  await waitForCondition(() => !!item(), 'sample removal action shown')
  await clickElement(item()!)
}

describe('removing the sample from its actual sidebar row', () => {
  it('anchors the menu to the source row instead of the pointer over its name', async () => {
    const harness = createReactHarness()
    try {
      await harness.render(createNode(SampleProjectSidebar))
      await waitForCondition(() => !!harness.container.querySelector('[role="treeitem"]'), 'sample row shown')
      const row = harness.container.querySelector<HTMLElement>('[role="treeitem"]')!
      const bounds = new DOMRect(100, 120, 240, 36)
      vi.spyOn(row.parentElement!, 'getBoundingClientRect').mockReturnValue(bounds)
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 130 })) })
      const positioner = () => document.querySelector<HTMLElement>('.gg-menu-positioner')
      await waitForCondition(() => !!positioner(), 'removal menu positioned')
      await waitForCondition(() => {
        const popup = positioner()!
        return popup.style.getPropertyValue('--anchor-width') === `${bounds.width}px`
          && popup.style.getPropertyValue('--anchor-height') === `${bounds.height}px`
      }, 'removal menu uses the row bounds')
    } finally { harness.cleanup() }
  })

  it('exposes the usual row menu and removes the row after its account save succeeds', async () => {
    const harness = createReactHarness()
    try {
      await removeFromRow(harness)
      await waitForCondition(() => !harness.container.querySelector('[role="treeitem"]'), 'sample row removed')
      expect(io.rows.get('u/user')?.config).toEqual({ sampleProject: { version: 1, dismissed: true }, keep: 'preference' })
      expect(io.toast).not.toHaveBeenCalled()
    } finally { harness.cleanup() }
  })

  it('keeps the row and reports the failed save instead of pretending removal succeeded', async () => {
    io.failWrite = true
    const harness = createReactHarness()
    try {
      await removeFromRow(harness)
      expect(harness.container.querySelector('[role="treeitem"]')).not.toBeNull()
      expect(io.rows.get('u/user')?.config).toMatchObject({ sampleProject: { dismissed: false } })
      expect(io.toast).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error', title: 'projects.sample.removeFailed' }))
    } finally { harness.cleanup() }
  })
})
