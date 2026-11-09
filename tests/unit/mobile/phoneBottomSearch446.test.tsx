// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneTabBar } from '../../../apps/desktop/src/mobile/PhoneTabBar'
import type { PhoneViewport } from '../../../apps/desktop/src/mobile/usePhoneViewport'
import { commandRegistry } from '../../../apps/desktop/src/session/renderer/lib/commands/registry'
import { clickElement, createReactHarness } from '../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); vi.stubGlobal('innerHeight', 844) })
afterEach(() => { h.cleanup(); vi.unstubAllGlobals() })
const normal: PhoneViewport = { viewportHeight: 844, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null }

it('the bottom search opens the one global search panel from either tab, without moving focus off the page first', async () => {
  const opened = vi.fn()
  const off = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', hideFromPalette: true, execute: opened }] })
  try {
    for (const tab of ['chats', 'contacts'] as const) {
      await h.render(<PhoneTabBar activeTab={tab} onTabChange={vi.fn()} pendingContactsCount={0} barRef={createRef()} tabs={['chats', 'contacts']} viewport={normal} />)
      const search = h.container.querySelector<HTMLElement>('[data-testid="phone-list-search"]')!
      const down = new Event('pointerdown', { bubbles: true, cancelable: true })
      search.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
      await clickElement(search)
    }
    expect(opened).toHaveBeenCalledTimes(2)
  } finally { off() }
})

it('keeps the navigation anchor and DOM while focused or covered by the IME, then follows normal viewport changes', async () => {
  const ref = createRef<HTMLElement>()
  const render = (viewport: PhoneViewport) => h.render(<PhoneTabBar activeTab="contacts" onTabChange={vi.fn()} pendingContactsCount={2} barRef={ref} tabs={['chats', 'contacts']} viewport={viewport} />)
  await render(normal)
  const nav = ref.current!
  expect(nav.style.getPropertyValue('--phone-nav-selected-index')).toBe('1')
  vi.stubGlobal('innerHeight', 500)
  await render({ ...normal, inputFocused: true, keyboardVisible: true, viewportHeight: 500 })
  expect(ref.current).toBe(nav)
  expect(nav.style.getPropertyValue('--phone-nav-viewport-height')).toBe('844px')
  await render({ ...normal, inputFocused: true, keyboardVisible: false, viewportHeight: 500 })
  expect(nav.style.getPropertyValue('--phone-nav-viewport-height')).toBe('844px')
  await render({ ...normal, viewportHeight: 500 })
  expect(nav.style.getPropertyValue('--phone-nav-viewport-height')).toBe('500px')
})
