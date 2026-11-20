import { animate } from 'framer-motion'
import { flushSync } from 'react-dom'
import { isSheetOpen } from '../components/ui/sheetStack'
import { completesPhoneBack, GestureVelocity } from './gestureVelocity'
import { skipMobileTransition } from './navigateMobile'

export type PhoneChatMotionState = { shown: boolean; enabled: boolean; place: string | null; onBack: () => void }
export const NATIVE_BACK_PROGRESS_EVENT = 'gugu:native-back-progress'

/** One interaction drives the existing page and its actual root underneath; no copied chat tree. */
export function installPhoneChatMotion(page: HTMLElement, underlay: HTMLElement, dim: HTMLElement,
  state: () => PhoneChatMotionState, ios: boolean) {
  let controls: { stop(): void } | undefined
  let generation = 0
  let mode: 'idle' | 'slide' | 'native' | 'ios' = 'idle'
  let distance = 0, progress = 0, edge = 0, finishing = false
  let touch: { id: number; x: number; y: number; moved: boolean; velocity: GestureVelocity } | null = null
  const canBack = () => state().shown && state().enabled && !isSheetOpen() && document.visibilityState !== 'hidden'
  const width = () => page.offsetWidth || page.parentElement?.clientWidth || window.innerWidth
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const stop = () => { generation++; controls?.stop(); controls = undefined }
  const reset = () => {
    stop(); mode = 'idle'; finishing = false; touch = null; distance = progress = 0
    for (const property of ['border-radius', 'opacity']) page.style.removeProperty(property)
    if (state().shown) page.style.removeProperty('transform')
    else page.style.transform = 'scale(0)'
    underlay.style.removeProperty('transform'); dim.style.removeProperty('opacity'); dim.style.removeProperty('display')
  }
  const backdrop = (x: number, opacity: number) => {
    underlay.style.transform = `translateX(${x}px)`
    dim.style.display = 'block'; dim.style.opacity = String(opacity)
  }
  const paintSlide = (x: number) => {
    distance = x
    page.style.transform = `translateX(${x}px)`
    page.style.opacity = '1'; page.style.borderRadius = '0'
    const ratio = Math.max(0, Math.min(1, x / width()))
    backdrop(-0.3 * width() * (1 - ratio), 1 - ratio)
  }
  const paintNative = (q: number, commit = 0) => {
    progress = q
    const direction = edge === 0 ? 1 : -1
    page.style.transform = `translateX(${direction * width() * (0.03 * q + 0.09 * commit)}px) scale(${1 - 0.1 * q - 0.04 * commit})`
    page.style.borderRadius = `${width() * 0.075 * q}px`
    page.style.opacity = String(1 - commit)
    backdrop(-0.3 * width() * (1 - q) * (1 - commit), (1 - q) * (1 - commit))
  }
  const spring = (from: number, to: number, paint: (value: number) => void, done: () => void, velocity = 0) => {
    stop()
    const ownGeneration = generation
    if (reduced()) { done(); return }
    controls = animate(from, to, { type: 'spring', stiffness: 320, damping: 34, velocity,
      restDelta: 0.001, restSpeed: 0.01, onUpdate: paint,
      onComplete: () => { if (generation === ownGeneration) { controls = undefined; done() } },
    })
  }
  const commit = (place: string | null) => {
    if (canBack() && state().place === place) flushSync(state().onBack)
    reset()
  }
  const slideBack = (velocity = 0) => {
    const place = state().place
    finishing = true
    spring(distance, width(), paintSlide, () => commit(place), velocity)
  }
  const back = () => {
    if (!canBack()) return false
    if (finishing) return true
    skipMobileTransition()
    if (mode === 'native') {
      const place = state().place, initial = progress
      finishing = true
      spring(0, 1, value => paintNative(initial, Math.max(0, Math.min(1, value))), () => commit(place))
    } else { mode = 'slide'; slideBack() }
    return true
  }
  const nativeProgress = (event: Event) => {
    const data = (event as CustomEvent<{ phase?: string; progress?: number; edge?: number }>).detail
    if (!data) return
    if (data.phase === 'cancelled') {
      if (mode === 'native' && !finishing) spring(progress, 0, paintNative, reset)
      return
    }
    if (!canBack() || finishing || typeof data.progress !== 'number' || !Number.isFinite(data.progress) || (data.edge !== 0 && data.edge !== 1)) return
    if (data.phase === 'started') { reset(); skipMobileTransition(); mode = 'native'; edge = data.edge }
    if (mode !== 'native' || (data.phase !== 'started' && data.phase !== 'progressed')) return
    progress = Math.max(0, Math.min(1, data.progress!))
    if (!reduced()) paintNative(progress)
  }
  const startTouch = (event: TouchEvent) => {
    if (!canBack() || finishing || event.touches.length !== 1) return
    const point = event.touches[0], x = point.clientX - page.getBoundingClientRect().left
    const selection = window.getSelection()
    if (x < 0 || x > 24 || (selection && !selection.isCollapsed)) return
    if ((event.target as Element).closest('input, textarea, [contenteditable="true"]')) return
    const velocity = new GestureVelocity(); velocity.add(point.clientX, point.clientY, event.timeStamp)
    touch = { id: point.identifier, x: point.clientX, y: point.clientY, moved: false, velocity }
  }
  const moveTouch = (event: TouchEvent) => {
    if (!touch) return
    const point = Array.from(event.touches).find(item => item.identifier === touch!.id)
    if (!point || event.touches.length !== 1 || !canBack()) { reset(); return }
    const dx = point.clientX - touch.x, dy = point.clientY - touch.y
    if (!touch.moved && Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { touch = null; return }
    if (!touch.moved && (dx <= 8 || dx <= Math.abs(dy))) return
    if (!event.cancelable) { reset(); return }
    event.preventDefault()
    if (!touch.moved) { stop(); skipMobileTransition(); touch.moved = true; mode = 'ios' }
    touch.velocity.add(point.clientX, point.clientY, event.timeStamp)
    if (!reduced()) paintSlide(Math.max(0, Math.min(width(), dx)))
    else distance = Math.max(0, Math.min(width(), dx))
  }
  const endTouch = (event: TouchEvent) => {
    const drag = touch
    if (!drag) return
    touch = null
    const point = Array.from(event.changedTouches).find(item => item.identifier === drag.id)
    if (!drag.moved || !point) return
    if (event.cancelable) event.preventDefault()
    drag.velocity.add(point.clientX, point.clientY, event.timeStamp)
    const velocity = drag.velocity.read().x
    if (canBack() && completesPhoneBack(Math.max(0, point.clientX - drag.x), width(), velocity)) slideBack(velocity)
    else spring(distance, 0, paintSlide, reset, velocity)
  }
  const cancelTouch = () => { if (touch?.moved) spring(distance, 0, paintSlide, reset); touch = null }
  const hidden = () => { if (document.visibilityState === 'hidden') reset() }
  window.addEventListener(NATIVE_BACK_PROGRESS_EVENT, nativeProgress)
  window.addEventListener('resize', reset)
  document.addEventListener('visibilitychange', hidden)
  if (ios) {
    page.addEventListener('touchstart', startTouch, { passive: true })
    page.addEventListener('touchmove', moveTouch, { passive: false })
    page.addEventListener('touchend', endTouch, { passive: false })
    page.addEventListener('touchcancel', cancelTouch)
  }
  return {
    back, reset,
    open() {
      if (!canBack()) return
      reset(); skipMobileTransition(); mode = 'slide'
      if (!reduced()) paintSlide(width())
      spring(width(), 0, paintSlide, reset)
    },
    destroy() {
      reset()
      window.removeEventListener(NATIVE_BACK_PROGRESS_EVENT, nativeProgress)
      window.removeEventListener('resize', reset)
      document.removeEventListener('visibilitychange', hidden)
      page.removeEventListener('touchstart', startTouch); page.removeEventListener('touchmove', moveTouch)
      page.removeEventListener('touchend', endTouch); page.removeEventListener('touchcancel', cancelTouch)
    },
  }
}
