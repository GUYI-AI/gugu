/** Desktop keeps backgroundThrottling disabled; the host reports minimize/tray visibility. */
export const ANIMATION_WINDOW_SEEN_EVENT = '__window_seen'

type Viewport = {
  observer: IntersectionObserver | null
  changed: Map<Element, (visible?: boolean) => void>
}

type WindowVisibility = {
  seen: boolean
  listeners: Set<() => void>
  viewports: Map<string, Viewport>
  /** Animations stopped because the window is not seen, with the playback rate each one goes back to. */
  held: Map<Animation, number>
}

// Retained surfaces and blocks moved to their own window use the document that owns them.
const windows = new WeakMap<Document, WindowVisibility>()

/**
 * @@@window-pause-by-animation — a window nobody sees stops its motion on the animations themselves: every one of the
 * document's animations (CSS animations, transitions and scripted ones; shadow trees are not part of a document's
 * animations, and no host document of ours has one) is set to playback
 * rate 0 and gets its own rate back when the window is seen again. Time stands still for it, so it resumes where it
 * was, and it asks for no frames meanwhile.
 *
 * ❌ An inherited custom property on <html> read by `animation-play-state` (what this was): changing it re-styles every
 * element of the document, once when the window hides and once more, in front of the user, when it comes back
 * (22k elements on an 18k-node page).
 * ❌ `animation.pause()` / `.play()`: after either, Chromium ignores `animation-play-state` for that animation, so the
 * surface and viewport pauses in animation-visibility.css would stop reaching it. The playback rate leaves that alone.
 */
function holdAnimations(doc: Document, state: WindowVisibility, hold: boolean): void {
  if (!hold) {
    for (const [animation, rate] of state.held) animation.playbackRate = rate
    state.held.clear()
    return
  }
  for (const animation of doc.getAnimations?.() ?? []) {
    // Only what is moving: a finished animation would start counting as running at rate 0.
    if (animation.playState !== 'running' || animation.playbackRate === 0 || state.held.has(animation)) continue
    state.held.set(animation, animation.playbackRate)
    animation.playbackRate = 0
  }
}

function listen(doc: Document): WindowVisibility {
  const existing = windows.get(doc)
  if (existing) return existing
  const state: WindowVisibility = { seen: true, listeners: new Set(), viewports: new Map(), held: new Map() }
  windows.set(doc, state)
  const sync = () => {
    holdAnimations(doc, state, !isAnimationWindowVisible(doc))
    for (const changed of state.listeners) changed()
    for (const viewport of state.viewports.values())
      for (const changed of viewport.changed.values()) changed()
  }
  doc.addEventListener('visibilitychange', sync)
  doc.defaultView?.addEventListener(ANIMATION_WINDOW_SEEN_EVENT, (event) => {
    state.seen = (event as CustomEvent<boolean>).detail
    sync()
  })
  // Motion that begins while the window is not seen is held as it begins.
  const begun = () => { if (!isAnimationWindowVisible(doc)) holdAnimations(doc, state, true) }
  doc.addEventListener('animationstart', begun, true)
  doc.addEventListener('transitionrun', begun, true)
  sync()
  return state
}

export function isAnimationWindowVisible(doc: Document = document): boolean {
  const state = listen(doc)
  return !doc.hidden && state.seen
}

export function subscribeAnimationWindowVisibility(changed: () => void, doc: Document = document): () => void {
  const state = listen(doc)
  state.listeners.add(changed)
  return () => { state.listeners.delete(changed) }
}

/** One observer per owning document/margin; one callback combines window and viewport visibility. */
export function observeAnimationViewport(element: HTMLElement, changed: (visible: boolean) => void, rootMargin = '0px'): () => void {
  const doc = element.ownerDocument
  const state = listen(doc)
  const Observer = doc.defaultView?.IntersectionObserver
  let viewport = state.viewports.get(rootMargin)
  if (!viewport) {
    const callbacks = new Map<Element, (visible?: boolean) => void>()
    viewport = {
      changed: callbacks,
      observer: Observer ? new Observer((entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      }, { rootMargin }) : null,
    }
    state.viewports.set(rootMargin, viewport)
  }
  // Without IO, preserve the existing on-screen assumption, while still honoring window hide.
  let inViewport = !Observer
  const update = (visible = inViewport) => {
    inViewport = visible
    changed(visible && isAnimationWindowVisible(doc))
  }
  viewport.changed.set(element, update)
  viewport.observer?.observe(element)
  if (!viewport.observer) update()
  return () => {
    viewport.changed.delete(element)
    viewport.observer?.unobserve(element)
  }
}

/** Every looping animation keeps the document clock, so stepped motion changes on one shared beat: a frame per beat
 *  however many are on screen, where independent clocks would each add their own. Stepping the clock with
 *  `currentTime` leaves `animation-play-state` in charge of pausing, which `startTime` would take over. */
export function joinSharedBeat(element: HTMLElement): void {
  for (const animation of element.getAnimations?.({ subtree: true }) ?? []) {
    const now = animation.timeline?.currentTime
    if (now != null && animation.effect?.getComputedTiming().iterations === Infinity) animation.currentTime = now
  }
}

/** Pauses CSS motion inside `element` while it is off screen (animation-visibility.css also pauses retained
 *  surfaces; a hidden window holds its animations itself, see holdAnimations). It starts paused, so motion that never reaches the viewport never runs. */
export function pauseAnimationsOffscreen(element: HTMLElement, rootMargin?: string): () => void {
  const paused = (pause: boolean) => {
    if (pause) { element.style.setProperty('--gugu-animation-viewport-paused', 'paused'); return }
    element.style.removeProperty('--gugu-animation-viewport-paused')
    joinSharedBeat(element)
  }
  paused(true)
  const stop = observeAnimationViewport(element, (visible) => paused(!visible), rootMargin)
  return () => { stop(); element.style.removeProperty('--gugu-animation-viewport-paused') }
}
