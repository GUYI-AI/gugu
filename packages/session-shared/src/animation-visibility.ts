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
 * was (a loop resumes on the shared beat), and it asks for no frames meanwhile.
 *
 * ❌ An inherited custom property on <html> read by `animation-play-state` (what this was): changing it re-styles every
 * element of the document, once when the window hides and once more, in front of the user, when it comes back
 * (22k elements on an 18k-node page).
 * ❌ `animation.pause()` / `.play()`: after either, Chromium ignores `animation-play-state` for that animation, so the
 * surface pause in animation-visibility.css would stop reaching it. The playback rate leaves that alone.
 */
function holdAnimations(doc: Document, state: WindowVisibility, hold: boolean): void {
  if (!hold) {
    for (const [animation, rate] of state.held) {
      animation.playbackRate = rate
      // A loop stood still while the document clock ran on: back on the shared beat, with what starts after it.
      // ❌ one removed meanwhile (idle): a time written to it would bring it back, paused.
      if (animation.playState !== 'idle' && animation.effect?.getComputedTiming().iterations === Infinity && animation.timeline?.currentTime != null) animation.currentTime = animation.timeline.currentTime
    }
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

/**
 * @@@shared-beat - every looping CSS animation runs on the document clock, so stepped motion changes on one shared beat:
 * a frame per beat however many are on screen, where independent clocks would each add their own. It is set the moment
 * the loop starts, for every loop of the document, wherever it was created (a mount, a row coming back into view, a
 * removed animation put back): joining from each component's own mount path missed some (running glyphs
 * started 60-95 s into the page sat at their own phases, 15 changes a second instead of 4). Stepping the clock with
 * `currentTime` leaves `animation-play-state` in charge of pausing, which `startTime` would take over.
 */
function joinSharedBeat(event: AnimationEvent): void {
  const target = event.target as Element
  // A ::before / ::after loop is the element's animation with that pseudo-element (subtree lists them).
  for (const animation of target.getAnimations?.({ subtree: true }) ?? []) {
    const effect = animation.effect as KeyframeEffect | null
    if (effect?.target !== target || (effect.pseudoElement ?? '') !== event.pseudoElement) continue
    if ((animation as CSSAnimation).animationName !== event.animationName || effect.getComputedTiming().iterations !== Infinity) continue
    const now = animation.timeline?.currentTime
    if (now != null) animation.currentTime = now
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
  const begun = (event: Event) => {
    if (!isAnimationWindowVisible(doc)) holdAnimations(doc, state, true)
    else if (event.type === 'animationstart') joinSharedBeat(event as AnimationEvent)
  }
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

/** Removes CSS motion inside `element` while it is off screen or its window is unseen (animation-visibility.css,
 *  data-animation-off; retained surfaces pause instead). It starts removed, so motion that never reaches the viewport
 *  never exists. */
export function stopAnimationsOffscreen(element: HTMLElement, rootMargin?: string): () => void {
  const off = (stop: boolean) => {
    if (stop) element.setAttribute('data-animation-off', '')
    else element.removeAttribute('data-animation-off')
  }
  off(true)
  const stop = observeAnimationViewport(element, (visible) => off(!visible), rootMargin)
  return () => { stop(); element.removeAttribute('data-animation-off') }
}
