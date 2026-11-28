/**
 * A tab's words follow the app's language when it is switched, without a reload: the tab items are `observer`s (memoized),
 * so they redraw only when one of their inputs changes — the language has to be one. Each case reads what the tab item
 * hands the tab chip, switches the language through the app's own setting, and waits for the other language's words.
 * The chip is stubbed to print those props: it subscribes on its own, which would hide a stale label it was handed.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { setLocalePreference } from '@/i18n'
import { i18n } from '@/i18n'
import { registerSessionLocaleResources } from '@renderer/localization/locale-store'
import type { ReactNode } from 'react'
import type { TabBarItemProps } from '@renderer/features/tabs/core/tab-host'
import type { TabResource } from '@renderer/features/tabs/core/tab-provider'

vi.mock('@renderer/features/tabs/tab-bar/generic-tab-item', () => {
  const Chip = ({ label, kindCommands }: { label?: string; kindCommands?: readonly { label: string }[] }) =>
    <div data-chip>{[label ?? '', ...(kindCommands ?? []).map((command) => command.label)].join('|')}</div>
  return { GenericTabItem: Chip, GenericTabDragPreview: Chip }
})

// The providers load through the registry, as the app loads them (each alone meets the registry half-built).
await import('@renderer/features/sessions/session-tab-registry')
const { sessionDetailsTabProvider } = await import('@renderer/features/sessions/session-details-tab')
const { createExtensionTabProvider } = await import('@renderer/features/extensions/extension-tab-provider')

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined; setLocalePreference('system') })

const host = { resolvedTabs: [], requestRename: () => {}, renameRequest: null, clearRenameRequest: () => {} } as unknown as TabBarItemProps<TabResource>['host']
const ctx = { place: { kind: 'session', sessionId: 'locale-session' } } as unknown as TabBarItemProps<TabResource>['ctx']
const tabOf = (resource: unknown) => ({ tabId: 'locale-tab', kind: 'x', isActive: false, resource }) as unknown as TabBarItemProps<TabResource>['tab']
registerSessionLocaleResources()
/** A session word in a given language (the session namespace interpolates `{x}`). */
const say = (key: string, locale: 'en-US' | 'zh-CN', values: Record<string, string> = {}) =>
  i18n.t(key, { ns: 'session', lng: locale, ...values, interpolation: { prefix: '{', suffix: '}' } })

async function switches(Item: (props: TabBarItemProps<TabResource>) => ReactNode, tab: TabBarItemProps<TabResource>['tab'], words: (locale: 'en-US' | 'zh-CN') => string) {
  setLocalePreference('en-US')
  harness = createReactHarness()
  await harness.render(<Item tab={tab} host={host} ctx={ctx} />)
  const chip = () => harness!.container.querySelector('[data-chip]')?.textContent
  expect(chip()).toBe(words('en-US'))
  setLocalePreference('zh-CN')
  await until('the tab item hands the chip the new language\'s words', chip, (text) => text === words('zh-CN'))
  setLocalePreference('en-US')
  await until('and back', chip, (text) => text === words('en-US'))
}

it('a session\'s Details tab', async () => {
  await switches(sessionDetailsTabProvider.TabBarItem as never, tabOf({ state: { sessionId: 'locale-session' } }), (locale) => say('details.title', locale))
})

it('an App tab\'s menu entries', async () => {
  const provider = createExtensionTabProvider('locale.app', 'main')
  await switches(provider.TabBarItem as never, tabOf({}),
    (locale) => `main|${say('extensions.reloadPage', locale)}|${say('extensions.appSettings', locale)}`)
})
