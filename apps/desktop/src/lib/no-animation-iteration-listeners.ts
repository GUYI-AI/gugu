// @@@no-iteration-listener — React adds a capture and a bubble `animationiteration` listener to every root and portal
// container. Once any node in a document has one, Blink wakes the main thread at every iteration boundary of every
// running CSS animation to dispatch the event, compositor-driven ones included, and the flag never clears. With the
// running-bar shimmer and the avatar pulses that was ~12 whole-page style + layerize frames a second while idle.
// Only React's own registration is dropped: React marks a container `_reactListening<random>` before it adds its
// listeners, so other code that listens for the event still gets it. Nothing here uses `onAnimationIteration`
// (guarded by noAnimationIterationListeners.test.ts); a React that stops marking fails no-animation-iteration-listener.test.tsx.
// Stays installed for the renderer's life so later portals and roots are covered. Import before any root is created.
const ITERATION = 'animationiteration'
const INSTALLED = Symbol.for('gugu.noAnimationIterationListeners')
const isReactContainer = (target: EventTarget) => Object.keys(target).some((key) => key.startsWith('_reactListening'))

export function installNoAnimationIterationListeners(target: EventTarget = EventTarget.prototype): void {
  const host = target as EventTarget & { [INSTALLED]?: true }
  if (host[INSTALLED]) return
  const add = host.addEventListener
  host.addEventListener = function (this: EventTarget, type, listener, options) {
    if (type === ITERATION && isReactContainer(this)) return
    add.call(this, type, listener, options)
  }
  host[INSTALLED] = true
}

installNoAnimationIterationListeners()
