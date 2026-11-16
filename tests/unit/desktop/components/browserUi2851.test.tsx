// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, typeInto } from '../../../support/testHarness'
import { BrowserToolbar } from '@/session/renderer/features/browser/browser-toolbar'
import { BrowserStartPage } from '@/session/renderer/features/browser/browser-start-page'
import { SessionLocalizationProvider } from '@/session/renderer/localization/localization-provider'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { enUSProjectMessages, zhCNProjectMessages } from '@/session/renderer/localization/messages-projects'
import { enUSCapabilityMessages, zhCNCapabilityMessages } from '@/session/renderer/localization/messages-capabilities'
import { BROWSER_ISOLATED_PROFILE_ID, browserProfileLabel, createBrowserSessionSnapshot } from '@/session/shared/browser'

const host = vi.hoisted(() => ({ kind: 'web' }))
vi.mock('@/platform', () => ({ platform: host }))
// Only the IPC boundary is replaced; settings reads and all UI remain real.
vi.mock('@renderer/lib/ipc', () => {
  const pending = () => new Promise(() => {})
  return { events: { on: () => () => {} }, rpc: new Proxy({}, { get: () => new Proxy({}, { get: () => pending }) }) }
})
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { host.kind = 'web'; harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
const session = () => createBrowserSessionSnapshot({ identity: { browserId: 'browser-ui-test', projectId: 'project', workspaceId: 'workspace', sessionId: 'agent' }, currentUrl: 'https://example.test/' })
async function toolbar(width: number, onNavigate = vi.fn()) {
  vi.stubGlobal('innerWidth', width)
  await harness.render(createNode(SessionLocalizationProvider, null, createNode(BrowserToolbar, { session: session(), adapter: null, onNavigate })))
  return onNavigate
}

it.each([390, 800])('exposes invalid addresses in place and clears the error after valid navigation at %ipx', async width => {
  const navigate = await toolbar(width)
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
})

it.each([{ kind: 'web', width: 360, touch: true }, { kind: 'web', width: 390, touch: true }, { kind: 'electron', width: 390, touch: false }, { kind: 'web', width: 800, touch: false }])('keeps the real shell sizing rule for $kind at $width', async ({ kind, width, touch }) => {
  host.kind = kind
  await toolbar(width)
  const buttons = [...harness.container.querySelectorAll('button')].slice(0, 3)
  expect(buttons).toHaveLength(3)
  for (const button of buttons) {
    expect(button.classList.contains('size-11')).toBe(touch)
    expect(button.querySelector('svg')?.classList.contains('size-4')).toBe(true)
  }
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
