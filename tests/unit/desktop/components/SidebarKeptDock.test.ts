// @vitest-environment jsdom
// PLAN v2 C4 / acceptance X4: the rail's dock on a cold start. What is installed is not kept across restarts, only the dock
// (`installedExtensions` carries `{dock}`): before the list is read the rail draws the kept Apps' places — each App's monogram
// with its name, an App left out of what was kept as an icon-sized placeholder — and the real items take those places in the
// same order when the list lands. Control (the parent commit): the dock drew nothing until the list was read, then the Apps
// were inserted, pushing nothing but appearing late.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { layOutRailDock } from '../../../support/railDockLayout'

vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, capabilities: { ...actual.platform.capabilities, agentRuntime: true } } }
})
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/snapshot-registry', () => ({
  snapshotRegistry: { register: vi.fn(() => () => undefined) },
}))

const { Sidebar } = await import('../../../../apps/desktop/src/components/Sidebar')
const { installedExtensions, tellInstalled } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions')
const { queryClient } = await import('../../../../apps/desktop/src/lib/replica')

const app = (id: string) => ({
  id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: id }] },
})
const dock = (root: ParentNode) => root.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.sidebarDock}"]`)
const kept = (root: ParentNode) => Array.from(dock(root)?.querySelectorAll('[data-dock-kept]') ?? [])
const real = (root: ParentNode) => Array.from(dock(root)?.querySelectorAll('[data-dock-app]') ?? []).map((node) => node.getAttribute('data-dock-app'))

describe('the dock on a cold start', () => {
  let harness: ReturnType<typeof createReactHarness>
  let restoreLayout: () => void
  beforeEach(() => {
    restoreLayout = layOutRailDock()
    queryClient.removeQueries({ queryKey: installedExtensions.key('local')!, exact: true })
    harness = createReactHarness()
  })
  afterEach(() => { harness.cleanup(); restoreLayout() })

  it('draws the kept places before the list is read, and the real Apps take them in the same order', async () => {
    // As restored from the snapshot: two Apps kept whole, one left out (its name too long), one past the kept slots.
    installedExtensions.set(['local'], { dock: { slots: [{ extensionId: 'alpha', name: 'Alpha' }, null, { extensionId: 'gamma', name: 'Gamma' }], count: 4 } })
    await renderWithAppProviders(harness, createNode(Sidebar, { activeTab: 'chats', onTabChange: vi.fn() }), { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } })
    const places = kept(harness.container)
    expect(places).toHaveLength(4)
    expect(places[0]!.getAttribute('aria-label')).toBe('Alpha')
    expect(places[0]!.textContent).toBe('A')
    expect(places[1]!.querySelector('[data-unknown]')).not.toBeNull()
    expect(places[2]!.getAttribute('aria-label')).toBe('Gamma')
    expect(places[3]!.querySelector('[data-unknown]')).not.toBeNull()
    // Not opened yet: the App behind it is not known to be openable.
    expect((places[0] as HTMLButtonElement).disabled).toBe(true)
    expect(real(harness.container)).toEqual([])

    await act(async () => {
      tellInstalled('local', { extensions: ['alpha', 'beta', 'gamma', 'delta'].map(app), invalid: [], dock: ['alpha', 'beta', 'gamma', 'delta'] } as never)
    })
    expect(kept(harness.container)).toEqual([])
    expect(real(harness.container)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })

  it('with nothing kept and nothing read, draws no dock (as before)', async () => {
    await renderWithAppProviders(harness, createNode(Sidebar, { activeTab: 'chats', onTabChange: vi.fn() }), { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } })
    expect(dock(harness.container)).toBeNull()
  })
})
