import { act, createRef, useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page as browserPage } from 'vitest/browser'
import { PhoneChatPage, type PhoneChatPageHandle } from '@/mobile/PhoneChatPage'
import { MobileTabPager } from '@/mobile/MobileTabPager'
import { sheetStack } from '@/components/ui/sheetStack'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

const platform = vi.hoisted(() => ({ value: 'android' }))
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => platform.value } }))
let harness: ReturnType<typeof createReactHarness>
let show: (value: boolean) => void, cover: (value: boolean) => void
let backs = 0, mounts = 0
const controller = createRef<PhoneChatPageHandle>()
const detail = () => document.querySelector<HTMLElement>('[data-shell-chat-detail]')!
const list = () => document.querySelector<HTMLElement>('[data-mobile-tab-pager]')!
const visible = () => detail().checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })
function Draft() {
  useEffect(() => { mounts++ }, [])
  return <textarea defaultValue="Keep this unfinished draft" />
}
function Shell() {
  const [shown, setShown] = useState(false), [covered, setCovered] = useState(false)
  show = setShown; cover = setCovered
  return <div style={{ position: 'relative', display: 'flex', width: 390, height: 700 }}>
    <MobileTabPager mobile tabs={['chats', 'contacts']} activeTab="contacts" covered={shown}
      swipeable={!shown} onSettle={() => {}} tabBarRef={{ current: null }}
      pages={{ chats: <div>Messages</div>, contacts: <button>Actual origin: Partners</button> }} />
    <PhoneChatPage ref={controller} mobile shown={shown} covered={covered} enabled={!covered}
      desktopShown={false} place="chat-1" onBack={() => { backs++; setShown(false) }}><Draft /></PhoneChatPage>
  </div>
}
beforeEach(async () => {
  platform.value = 'android'; backs = mounts = 0
  await browserPage.viewport(390, 844)
  harness = createReactHarness()
  await harness.render(<Shell />)
  await act(async () => show(true))
  await until('chat entry spring settled', () => detail().style.transform === '')
})
afterEach(async () => { await harness?.cleanup(); vi.restoreAllMocks(); document.getSelection()?.removeAllRanges() })
function native(phase: string, progress = 0, edge = 0) {
  window.dispatchEvent(new CustomEvent('gugu:native-back-progress', { detail: { phase, progress, edge } }))
}
function touch(type: string, x: number, y: number, at: number, target: HTMLElement = detail()) {
  const point = new Touch({ identifier: 1, target, clientX: x, clientY: y })
  const event = new TouchEvent(type, { bubbles: true, cancelable: true,
    touches: type === 'touchend' || type === 'touchcancel' ? [] : [point], changedTouches: [point] })
  Object.defineProperty(event, 'timeStamp', { value: at })
  target.dispatchEvent(event)
  return event
}
async function reopenIOS() {
  await act(async () => show(false))
  await harness.cleanup()
  platform.value = 'ios'
  harness = createReactHarness()
  await harness.render(<Shell />)
  await act(async () => show(true))
  await until('iOS chat entry spring settled', () => detail().style.transform === '')
}

it('follows Android progress over the real origin, cancels without navigation, and commits once after its animation', async () => {
  const retained = detail(), draft = retained.querySelector('textarea')!
  draft.value = 'Draft survives back and reopen'
  expect(list().scrollLeft).toBe(390)
  expect(document.querySelector('[data-mobile-tab-page="contacts"]')?.hasAttribute('inert')).toBe(true)
  native('started'); native('progressed', 0.6)
  const frame = new DOMMatrix(getComputedStyle(detail()).transform)
  expect(frame.a).toBeCloseTo(0.94, 3)
  expect(frame.e).toBeGreaterThan(0)
  expect(new DOMMatrix(getComputedStyle(list()).transform).e).toBeLessThan(0)
  expect(visible()).toBe(true); expect(backs).toBe(0)
  native('cancelled')
  await until('cancel spring restored the existing page', () => detail().style.transform === '')
  expect(visible()).toBe(true); expect(backs).toBe(0)
  native('started', 0, 1); native('progressed', 0.8, 1)
  expect(new DOMMatrix(getComputedStyle(detail()).transform).e).toBeLessThan(0)
  expect(controller.current!.back()).toBe(true)
  expect(controller.current!.back()).toBe(true)
  expect(backs).toBe(0)
  await until('native commit returned to the origin', () => backs === 1)
  expect(visible()).toBe(false)
  expect(list().style.transform).toBe('')
  await act(async () => show(true))
  await until('retained chat reopened', () => detail().style.transform === '')
  expect(detail()).toBe(retained); expect(detail().querySelector('textarea')).toBe(draft)
  expect(draft.value).toBe('Draft survives back and reopen'); expect(mounts).toBe(1)
})

it('waits for release on Android without progress and leaves system edge touches unclaimed', async () => {
  touch('touchstart', 12, 200, 0); const move = touch('touchmove', 240, 200, 100)
  touch('touchend', 240, 200, 140)
  expect(move.defaultPrevented).toBe(false); expect(detail().style.transform).toBe(''); expect(backs).toBe(0)
  controller.current!.back()
  expect(backs).toBe(0)
  await until('release-only fallback returned to origin', () => backs === 1)
})

it('lets a sheet or a covering page own back, and discards stale progress when it is covered', async () => {
  native('started'); native('progressed', 0.5)
  await act(async () => cover(true))
  expect(detail().inert).toBe(true)
  // covered changes enabled, so a half-complete gesture is reset rather than kept behind Settings.
  expect(detail().style.transform).toBe('')
  expect(controller.current!.back()).toBe(false)
  await act(async () => cover(false))
  const sheet = Symbol('test sheet'); sheetStack.push(sheet)
  try {
    native('started'); native('progressed', 0.8)
    expect(detail().style.transform).toBe(''); expect(controller.current!.back()).toBe(false)
  } finally { sheetStack.splice(sheetStack.indexOf(sheet), 1) }
  expect(backs).toBe(0)
})

it('follows an iOS left edge, cancels a short release and accepts a quick short flick', async () => {
  await reopenIOS()
  touch('touchstart', 12, 200, 0); touch('touchmove', 92, 200, 300)
  expect(new DOMMatrix(getComputedStyle(detail()).transform).e).toBeCloseTo(80, 1)
  touch('touchend', 92, 200, 500)
  await until('short iOS swipe cancelled', () => detail().style.transform === '')
  expect(backs).toBe(0)
  touch('touchstart', 12, 200, 1000); const move = touch('touchmove', 52, 200, 1040)
  expect(move.defaultPrevented).toBe(true)
  touch('touchend', 72, 200, 1060)
  await until('quick iOS flick committed', () => backs === 1)
})

it('does not take vertical scrolling, mid-page swipes, composer touches or cancelled iOS gestures', async () => {
  await reopenIOS()
  touch('touchstart', 150, 200, 0); touch('touchmove', 300, 200, 60); touch('touchend', 300, 200, 80)
  touch('touchstart', 12, 200, 100); const vertical = touch('touchmove', 20, 280, 200); touch('touchend', 20, 280, 210)
  const textarea = detail().querySelector('textarea')!
  touch('touchstart', 12, 200, 300, textarea); touch('touchmove', 300, 200, 340, textarea); touch('touchend', 300, 200, 350, textarea)
  expect(vertical.defaultPrevented).toBe(false); expect(detail().style.transform).toBe('')
  touch('touchstart', 12, 200, 500); touch('touchmove', 300, 200, 600); touch('touchcancel', 300, 200, 620)
  await until('iOS cancellation restored the page', () => detail().style.transform === '')
  expect(visible()).toBe(true); expect(backs).toBe(0)
})

it('honors reduced motion without keeping a hidden page transformed into view', async () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  native('started'); native('progressed', 0.8)
  expect(detail().style.transform).toBe('')
  await act(async () => { controller.current!.back() })
  expect(backs).toBe(1); expect(visible()).toBe(false)
  expect(detail().style.transform).toBe('scale(0)')
})
