// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, typeInto } from '../../../support/testHarness'
import { BrowserToolbar } from '@/session/renderer/features/browser/browser-toolbar'
import { PhoneBrowserToolbar } from '@/mobile/agent-watch/PhoneBrowserToolbar'
import { BrowserStartPage } from '@/session/renderer/features/browser/browser-start-page'
import { SessionLocalizationProvider } from '@/session/renderer/localization/localization-provider'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { enUSProjectMessages, zhCNProjectMessages } from '@/session/renderer/localization/messages-projects'
import { enUSCapabilityMessages, zhCNCapabilityMessages } from '@/session/renderer/localization/messages-capabilities'
import { BROWSER_ISOLATED_PROFILE_ID, browserProfileLabel, createBrowserSessionSnapshot } from '@/session/shared/browser'

// Only the IPC boundary is replaced; settings reads and all UI remain real.
vi.mock('@renderer/lib/ipc', () => {
  const pending = () => new Promise(() => {})
  return { events: { on: () => () => {} }, rpc: new Proxy({}, { get: () => new Proxy({}, { get: () => pending }) }) }
})
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
const session = () => createBrowserSessionSnapshot({ identity: { browserId: 'browser-ui-test', projectId: 'project', workspaceId: 'workspace', sessionId: 'agent' }, currentUrl: 'https://example.test/' })
async function toolbar(width: number, phone: boolean, onNavigate = vi.fn()) {
  vi.stubGlobal('innerWidth', width)
  await harness.render(createNode(SessionLocalizationProvider, null, createNode(phone ? PhoneBrowserToolbar : BrowserToolbar, { session: session(), adapter: null, onNavigate })))
  return onNavigate
}

it.each([{ width: 390, phone: true }, { width: 800, phone: false }])('exposes invalid addresses and clears them after valid navigation ($width, phone=$phone)', async ({ width, phone }) => {
  const navigate = await toolbar(width, phone)
  const input = harness.container.querySelector('input')!
  await typeInto(input, 'javascript:alert(1)')
  await act(async () => harness.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  const error = harness.container.querySelector<HTMLElement>('[role="alert"]')!
  expect(error.textContent).toBe(translateSessionMessage('browser.urlRejected.protocol'))
  expect(error.classList.contains('sr-only')).toBe(false)
  expect(input.value).toBe('javascript:alert(1)')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')).toBe(error.id)
  expect(navigate).not.toHaveBeenCalled()
  await typeInto(input, 'https://example.test/next')
  await act(async () => harness.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(navigate).toHaveBeenCalledWith('https://example.test/next')
  expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  expect(input.hasAttribute('aria-invalid')).toBe(false)
  await typeInto(input, 'javascript:alert(1)')
  await act(async () => harness.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  await harness.render(createNode(SessionLocalizationProvider, null, createNode(phone ? PhoneBrowserToolbar : BrowserToolbar, { session: { ...session(), currentUrl: 'https://example.test/back' }, adapter: null, onNavigate: navigate })))
  expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  expect(input.value).toBe('https://example.test/back')
})

it.each([{ phone: true, loading: false }, { phone: true, loading: true }, { phone: false, loading: false }, { phone: false, loading: true }])('keeps navigation controls connected (phone=$phone, loading=$loading)', async ({ phone, loading }) => {
  const back = vi.fn(), forward = vi.fn(), reload = vi.fn()
  const current = { ...session(), canGoBack: true, canGoForward: true, isLoading: loading }
  await harness.render(createNode(SessionLocalizationProvider, null, createNode(phone ? PhoneBrowserToolbar : BrowserToolbar, { session: current, adapter: null, remote: true, onGoBack: back, onGoForward: forward, onReload: reload })))
  const buttons = [...harness.container.querySelectorAll('button')].slice(0, 3)
  expect(buttons).toHaveLength(3)
  for (const button of buttons) {
    expect(button.querySelector('svg')?.classList.contains('size-4')).toBe(true)
  }
  expect(buttons[2]!.getAttribute('aria-label')).toBe(translateSessionMessage(loading ? 'browser.stop' : 'browser.reload'))
  await act(async () => { for (const button of buttons) button.click() })
  expect(back).toHaveBeenCalledTimes(1)
  expect(forward).toHaveBeenCalledTimes(1)
  expect(reload).toHaveBeenCalledTimes(1)
})

it('opens a discovered local address without claiming that it is online', async () => {
  const open = vi.fn()
  await harness.render(createNode(SessionLocalizationProvider, null, createNode(BrowserStartPage, { devServerUrls: ['http://localhost:5173'], onOpenUrl: open })))
  expect(harness.container.textContent).toContain('localhost:5173')
  expect(harness.container.querySelector('.bg-foreground-info')).toBeNull()
  await act(async () => harness.container.querySelector('button')!.click())
  expect(open).toHaveBeenCalledWith('http://localhost:5173')
})

it('uses localized agent labels without changing the isolated profile identity', () => {
  for (const [projects, settings, expected] of [[enUSProjectMessages, enUSCapabilityMessages, 'agent'], [zhCNProjectMessages, zhCNCapabilityMessages, '智能体']] as const) {
    const label = projects['browser.isolatedPerTask']
    expect(label).toContain(expected)
    expect(browserProfileLabel(BROWSER_ISOLATED_PROFILE_ID, [], label)).toBe(label)
    expect(settings['browserSettings.isolatedPerTask']).toBe(label)
    expect(settings['browserSettings.profilesDescription']).toContain(expected)
    expect(settings['browserSettings.importLoginsNeedsProfile']).toContain(label)
  }
  expect(browserProfileLabel('named', [{ id: 'named', name: 'Research' }])).toBe('Research')
})
