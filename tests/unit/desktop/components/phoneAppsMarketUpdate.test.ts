// @vitest-environment jsdom
// 161 10-15: a market App on the phone says where it came from, and when the market has a newer version for this phone the
// row offers 「更新到 vX」 — installed the one way (phoneApps.installFromMarket), asked only when it asks for more. Without
// it an App's fixes never reach the phone. The phone's App store is played here; its install is measured in phoneApps76.
import { act, createElement, Fragment, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const NOTHING_NEWER = { success: true, data: { checkedAt: '', updates: {}, yanked: {}, deprecated: {} } }
const phone = vi.hoisted(() => ({
  ready: vi.fn(async () => undefined),
  marketUpdates: vi.fn(async (): Promise<unknown> => ({ success: true, data: { checkedAt: '', updates: {}, yanked: {}, deprecated: {} } })),
  installFromMarket: vi.fn(async (): Promise<unknown> => ({ success: true, data: { installed: true, outcome: 'confirmed', id: 'notes', name: 'Notes', version: '1.1.0' } })),
  uninstall: vi.fn(async () => ({ success: true, data: null })),
  // The shell's switch: phoneApps keeps the list and tells the store (tell → applyList); played here on the store below.
  setEnabled: vi.fn(async (_id: string, _enabled: boolean): Promise<unknown> => ({ success: true, data: null })),
  setAutoUpdate: vi.fn(async (_id: string, _on: boolean): Promise<unknown> => ({ success: true, data: null })),
  originOf: (id: string) => (id === 'notes' ? 'market' : 'attachment'),
  // The index in hand (market-snapshot.ts): the page asks the download site once it opens; `heard` is who listens.
  market: {
    heard: [] as ((refreshed: { outcome: string; fetchedAt: string | null }) => void)[],
    refresh: vi.fn(async () => ({ outcome: 'unchanged', fetchedAt: '2026-10-16T01:00:00.000Z' })),
    history: vi.fn(async (): Promise<unknown> => []),
    onRefreshed(listener: (refreshed: { outcome: string; fetchedAt: string | null }) => void) {
      phone.market.heard.push(listener)
      return () => {
        phone.market.heard = phone.market.heard.filter((other) => other !== listener)
      }
    },
  },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({ phoneApps: phone, PHONE_CAPABILITIES: [] }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', async () => {
  const { observable } = await import('mobx')
  const app = (id: string, name: string) => ({ id, name, version: '1.0.0', apiVersion: 4, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: name }] } })
  return {
    installedExtensionsStore: observable({
      manifests: [app('notes', 'Notes'), app('vote', 'Vote')],
      origins: {} as Record<string, string>,
      isPreinstalled(id: string) {
        return this.origins[id] === 'preinstalled'
      },
      disabled: [] as string[],
      isEnabled(id: string) {
        return !this.disabled.includes(id)
      },
      // Notes is the market's: it has a 「自动更新」 switch; Vote came from a chat and has none.
      autoUpdateOff: [] as string[],
      autoUpdates(id: string) {
        return id === 'notes' ? !this.autoUpdateOff.includes(id) : null
      },
      invalid: [] as unknown[],
      appIcons: {} as Record<string, string>,
      publishers: { notes: { id: 'gugu' }, vote: { id: 'alice', name: 'Alice' } },
      // Notes has a page of its own; Vote only opens its files.
      mainTabOf(id: string) {
        return id === 'notes' ? { kind: 'notes.main' } : null
      },
    }),
  }
})
const { followLink } = vi.hoisted(() => ({ followLink: vi.fn(() => true) }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ followLink }))
const { AppsSection } = await import('../../../../apps/desktop/src/components/settings/AppsSection')
const { useOfferedVersions } = await import('../../../../apps/desktop/src/components/settings/phoneMarketPage')
const { PhoneAppManage } = await import('../../../../apps/desktop/src/components/settings/PhoneAppManage')
const { installedExtensionsStore: store } = (await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')) as unknown as {
  installedExtensionsStore: { disabled: string[]; autoUpdateOff: string[] }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  followLink.mockClear()
  // Nothing newer unless a case says so (an answer set in one case is not left for the next).
  phone.marketUpdates.mockReset().mockResolvedValue(NOTHING_NEWER)
  phone.installFromMarket.mockClear()
  phone.market.refresh.mockClear()
  phone.market.heard = []
  phone.setEnabled.mockReset().mockImplementation(async (id: string, enabled: boolean) => {
    store.disabled = enabled ? store.disabled.filter((one) => one !== id) : [...store.disabled, id]
    return { success: true, data: null }
  })
  store.disabled = []
  store.autoUpdateOff = []
  phone.installFromMarket.mockClear()
  phone.setAutoUpdate.mockReset().mockImplementation(async (id: string, on: boolean) => {
    store.autoUpdateOff = on ? store.autoUpdateOff.filter((one) => one !== id) : [...store.autoUpdateOff, id]
    return { success: true, data: null }
  })
  phone.market.history.mockReset().mockResolvedValue([])
})
afterEach(() => harness.cleanup())

const row = (id: string) => harness.container.querySelector<HTMLElement>(`[data-app-id="${id}"]`)
const page = (selector: string) => harness.container.ownerDocument.querySelector<HTMLElement>(selector)
/** The section as the phone's App page holds it: the list, and an App's settings page over it. */
function Apps() {
  const offered = useOfferedVersions()
  const [manage, setManage] = useState<string | null>(null)
  return createElement(Fragment, null,
    createElement(AppsSection, { updates: offered.updates, gone: offered.gone, onManage: setManage }),
    manage ? createElement(PhoneAppManage, { extensionId: manage, updateVersion: offered.updates[manage], gone: offered.gone.includes(manage), onClose: () => setManage(null), onViewInMarket: () => setManage(null) }) : null)
}
const open = async (id: string) => {
  await act(async () => { row(id)!.click() })
  await until(`${id}'s settings page`, () => page('[data-testid="app-manage-page"]') !== null)
}
/** React and the pending answers flushed until `fact` holds — a bounded number of turns, never a clock; red names the step. */
async function until(step: string, fact: () => boolean) {
  for (let turn = 0; turn < 50 && !fact(); turn++) await act(async () => { await Promise.resolve() })
  if (!fact()) throw new Error(`[awaiting-fact] ${step}: still not so after 50 turns of React and the pending answers`)
}
/** The market's answer for this render has come and been drawn: what the rows say about updates is final. */
async function marketAnswered(calls: number) {
  await until(`the market was asked ${calls} time(s)`, () => phone.marketUpdates.mock.calls.length >= calls)
  await act(async () => { await phone.marketUpdates.mock.results[calls - 1]!.value })
}

describe('「App」 on the phone: a row is a name and how it stands', () => {
  it('a market App with a newer version says so on its row; its settings page installs that version the one way', async () => {
    phone.marketUpdates.mockResolvedValue({ success: true, data: { checkedAt: '', updates: { notes: { version: '1.1.0', releaseNotes: '' } }, yanked: {}, deprecated: {} } })
    await harness.render(createElement(Apps))
    await until('notes offers its update', () => row('notes')?.textContent?.includes('1.1.0') === true)
    expect(row('vote')?.textContent).toContain('1.0.0 · 来自 Alice')
    expect(row('notes')?.querySelector('button')).toBeNull()
    await open('notes')
    await act(async () => { page('[data-testid="app-manage-notice"] .xp-link')!.click() })
    await until('the update installed from the market', () => phone.installFromMarket.mock.calls.length === 1)
    expect(phone.installFromMarket).toHaveBeenCalledWith({ ref: { extensionId: 'notes', version: '1.1.0' } })
  })

  // owner 10-16「本地有缓存啊」: what it says comes from the index in hand at once; the download site is asked behind it.
  it('opened: asks the download site once; an index that came back changed is read again, and leaving stops listening', async () => {
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    expect(phone.market.refresh).toHaveBeenCalledTimes(1)
    expect(row('notes')?.textContent).toContain('1.0.0 · 来自咕咕市场')
    phone.marketUpdates.mockResolvedValue({ success: true, data: { checkedAt: '', updates: { notes: { version: '1.1.0', releaseNotes: '' } }, yanked: {}, deprecated: {} } })
    await act(async () => { for (const listener of phone.market.heard) listener({ outcome: 'unchanged', fetchedAt: '2026-10-16T01:00:00.000Z' }) })
    expect(phone.marketUpdates).toHaveBeenCalledTimes(1)
    await act(async () => { for (const listener of phone.market.heard) listener({ outcome: 'changed', fetchedAt: '2026-10-16T01:01:00.000Z' }) })
    await until('notes says the update the new index brought', () => row('notes')?.textContent?.includes('1.1.0') === true)
    await harness.render(null)
    expect(phone.market.heard).toHaveLength(0)
  })

  // owner 10-19: an App updated by itself while the page is open.
  it('the installed version changing reads the market again: the row no longer offers the version it now has', async () => {
    phone.marketUpdates.mockResolvedValue({ success: true, data: { checkedAt: '', updates: { notes: { version: '1.1.0', releaseNotes: '' } }, yanked: {}, deprecated: {} } })
    await harness.render(createElement(Apps))
    await until('notes offers its update', () => row('notes')?.textContent?.includes('1.1.0') === true)
    phone.marketUpdates.mockResolvedValue(NOTHING_NEWER)
    const manifests = (store as unknown as { manifests: { id: string; version: string }[] }).manifests
    await act(async () => { manifests[0]!.version = '1.1.0' })
    await until('the offer is gone', () => phone.marketUpdates.mock.calls.length >= 2)
    manifests[0]!.version = '1.0.0'
  })
})

describe('「App」 on the phone: an App’s settings page', () => {
  const toggleEnabled = async () => { await act(async () => { (page('[data-testid="app-manage-switch"]') ?? page('[data-testid="app-manage-action"]'))!.click() }) }

  it('its switch asks phoneApps, the row says it is off; off is not gone; turned on again, the same way back', async () => {
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    await open('vote')
    await toggleEnabled()
    await until('vote was switched off', () => store.disabled.includes('vote'))
    expect(phone.setEnabled).toHaveBeenLastCalledWith('vote', false)
    expect(row('vote')?.textContent).toContain('1.0.0 · 来自 Alice · 未启用')
    expect(page('[data-testid="app-manage-uninstall-action"]')).not.toBeNull()
    await toggleEnabled()
    await until('vote was switched on', () => !store.disabled.includes('vote'))
    expect(phone.setEnabled).toHaveBeenLastCalledWith('vote', true)
  })

  it('a switch the phone refuses says so, and it stays as it was', async () => {
    phone.setEnabled.mockResolvedValueOnce({ success: false, error: '"vote" is not installed' })
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    await open('vote')
    await toggleEnabled()
    await until('the refusal is said', () => page('[data-testid="settings-apps-failed"]') !== null)
    expect(page('[data-testid="settings-apps-failed"]')?.textContent).toContain('"vote" is not installed')
    expect(store.disabled).toEqual([])
  })

  it('「打开」 asks the common opener for its own page; switched off it switches on instead', async () => {
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    await open('notes')
    await act(async () => { page('[data-testid="app-manage-action"]')!.click() })
    expect(followLink).toHaveBeenCalledExactlyOnceWith({ kind: 'app', extensionId: 'notes', tab: 'main', path: '', query: {}, place: null })
    store.disabled = ['notes']
    await act(async () => { await Promise.resolve() })
    await act(async () => { page('[data-testid="app-manage-action"]')!.click() })
    expect(phone.setEnabled).toHaveBeenLastCalledWith('notes', true)
  })

  it('one gugu ships has no switch and no uninstall: its link opens the page, and pressing nothing can only fail', async () => {
    const origins = (store as unknown as { origins: Record<string, string> }).origins
    origins.vote = 'preinstalled'
    try {
      await harness.render(createElement(PhoneAppManage, { extensionId: 'vote', gone: false, onClose: () => undefined, onViewInMarket: () => undefined }))
      await until('its settings page', () => page('[data-testid="app-manage-page"]') !== null)
      expect(page('[data-testid="app-manage-switch"]')).toBeNull()
      expect(page('[data-testid="app-manage-uninstall"]')).toBeNull()
      expect(page('[data-testid="app-manage-version"]')).toBeNull()
      expect(page('[data-testid="app-manage-origin"]')?.textContent).toContain('咕咕自带')
    } finally {
      delete origins.vote
    }
  })

  it('it has no agents or per-permission take-back on the phone', async () => {
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    await open('notes')
    expect(page('[data-testid="app-manage-agents"]')?.querySelector('[data-testid="given"]') ?? null).toBeNull()
    expect(page('[data-testid="app-manage-permissions"]')?.querySelector('button')).toBeNull()
    expect(page('[data-testid="app-manage-data"]')).toBeNull()
    expect(page('[data-testid="app-manage-pages"]')?.querySelector('[role="switch"]') ?? null).toBeNull()
  })

  it('uninstalling says what goes, asks once, and returns to the list', async () => {
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    await open('notes')
    await act(async () => { page('[data-testid="app-manage-uninstall-action"]')!.click() })
    await act(async () => { page('[data-testid="settings-apps-uninstall-confirm"]')!.click() })
    await until('uninstalled', () => phone.uninstall.mock.calls.length === 1)
    await until('back on the list', () => page('[data-testid="app-manage-page"]') === null)
  })
})

// owner 10-19: a market App's versions — its 「自动更新」 switch and every version, any of which installs.
describe('「App」 on the phone: a market App’s versions and its 「自动更新」', () => {
  const versionRow = (version: string) => page(`[data-testid="extension-history-notes-${version}"]`)
  const history = [
    { version: '1.2.0', publishedAt: '2026-10-18T00:00:00Z', releaseNotes: 'Needs more', apiVersion: 4, minAppVersion: '9.0.0', yanked: null, compat: { reason: 'needs-newer-app', gate: 'semver', minAppVersion: '9.0.0' } },
    { version: '1.1.0', publishedAt: '2026-10-17T00:00:00Z', releaseNotes: '- Faster', apiVersion: 4, minAppVersion: '0.1.0', yanked: null, compat: null },
    { version: '1.0.0', publishedAt: '2026-10-16T00:00:00Z', releaseNotes: 'First', apiVersion: 4, minAppVersion: '0.1.0', yanked: null, compat: null },
    { version: '0.9.0', publishedAt: '2026-10-15T00:00:00Z', releaseNotes: 'Old', apiVersion: 4, minAppVersion: '0.1.0', yanked: { reason: 'broken' }, compat: null },
  ]

  it('only a market App has version history; it lists every version, the rest installable or saying why not', async () => {
    phone.market.history.mockResolvedValue(history)
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    await open('vote')
    expect(page('[data-testid="app-manage-history"]')).toBeNull()
    await act(async () => { page('[data-testid="app-manage-back"]')!.click() })
    await open('notes')
    await act(async () => { page('[data-testid="app-manage-history"] button')!.click() })
    await until('the versions are drawn', () => versionRow('1.1.0') !== null)
    expect(phone.market.history).toHaveBeenCalledWith('notes')
    expect(versionRow('1.2.0')?.querySelector('button.xp-link')).toBeNull()
    expect(versionRow('1.0.0')?.querySelector('.xp-state')).not.toBeNull()
    expect(versionRow('0.9.0')?.querySelector('button.xp-link')).toBeNull()
    await act(async () => { versionRow('1.1.0')!.querySelector<HTMLElement>('button.xp-link')!.click() })
    await until('that version was installed', () => phone.installFromMarket.mock.calls.length === 1)
    expect(phone.installFromMarket).toHaveBeenCalledWith({ ref: { extensionId: 'notes', version: '1.1.0' } })
  })

  it('「自动更新」 says what an older version does; turned off, phoneApps is asked and it says it is pinned', async () => {
    await harness.render(createElement(Apps))
    await marketAnswered(1)
    await open('notes')
    const row = () => page('[data-testid="app-manage-auto-update"]')
    expect(row()?.textContent).toContain('安装旧版本后，此 App 的自')
    await act(async () => { row()!.querySelector<HTMLElement>('[role="switch"]')!.click() })
    await until('switched off', () => store.autoUpdateOff.includes('notes'))
    expect(phone.setAutoUpdate).toHaveBeenLastCalledWith('notes', false)
    await until('it says it is pinned', () => row()?.textContent?.includes('已固定在 v1.0.0') === true)
  })
})
