// @vitest-environment jsdom
// 资源库「主题」 on the desktop shell (main's app settings + the imported pack list main keeps): a refresh of the imported list
// that fails over the list read before is said with a retry, the cards staying (❌ shown as current).
import { act } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceSettingsHandover } from '../../../../apps/desktop/shared/device-preferences'
import { createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'

const ipc = vi.hoisted(() => ({
  fail: false,
  imported: [] as unknown[],
}))
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    appSettings: { getWithMeta: async () => ({ value: {}, defaults: {}, overrides: {} }), getAll: async () => ({}), update: async () => undefined },
    themePacks: { imported: async () => { if (ipc.fail) throw new Error('main unreachable'); return ipc.imported } },
  },
  rpcOn: () => ({ appSettings: { getWithMeta: async () => ({ value: {}, defaults: {}, overrides: {} }) } }),
  events: { on: () => () => undefined },
}))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => undefined }))

const paper = {
  id: 'obsidian:someone/paper',
  name: 'Paper',
  modes: { light: { bg: '#fbf7ef', fg: '#2b2a28' } },
  source: { kind: 'obsidian', url: 'https://github.com/someone/paper', author: 'someone', license: '' },
}
const meta = (value: unknown) => ({ value, defaults: value, overrides: {} })
const handover = (): DeviceSettingsHandover => ({
  settings: Object.fromEntries(Object.entries({
    theme: 'light', locale: 'en-US', interface: { sidebarTint: true, trayBadge: false, hideContextBar: false }, themePackSlots: {},
    chatNotifications: { chatMessages: true, sound: false }, assistant: { meetingReminder: true, hiddenIdeasEntries: [] },
  }).map(([key, value]) => [key, meta(value)])) as DeviceSettingsHandover['settings'],
  themePackCss: '',
})

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  vi.resetModules()
  ipc.fail = false
  ipc.imported = [paper]
  window.guguDeviceSettings = { handover: handover() } as never
  harness = createReactHarness()
})
afterEach(async () => {
  harness.cleanup()
  delete (window as { guguDeviceSettings?: unknown }).guguDeviceSettings
  ;(await import('../../../../apps/desktop/src/lib/replica')).queryClient.clear()
  vi.resetModules()
})

describe('theme packs, desktop shell', () => {
  it('a refresh of the imported packs that fails is said with a retry; the cards read before stay', async () => {
    const { ThemesLibraryPage } = await import('../../../../apps/desktop/src/session/renderer/features/library/themes/themes-library-page')
    const { importedThemePacksModel } = await import('../../../../apps/desktop/src/session/renderer/lib/theme/theme-pack-store')
    await renderWithAppProviders(harness, createNode(ThemesLibraryPage))
    await waitForCondition(() => (harness.container.textContent ?? '').includes('Paper'), 'imported pack not drawn')
    expect(harness.container.querySelector('[data-refresh-failed]')).toBeNull()
    ipc.fail = true
    await act(async () => { await importedThemePacksModel.refresh().catch(() => undefined) })
    await waitForCondition(() => harness.container.querySelector('[data-refresh-failed]') !== null, 'failed refresh not said')
    expect(harness.container.textContent).toContain('Paper')
    ipc.fail = false
    await act(async () => { (harness.container.querySelector('[data-refresh-failed] button') as HTMLButtonElement).click() })
    await waitForCondition(() => harness.container.querySelector('[data-refresh-failed]') === null, 'retry did not read again')
  })
})
