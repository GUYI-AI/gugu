/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility'
import '@gugu/session-shared/animation-visibility.css'
import '@gugu/session-shared/running-glyph.css'
import { RunningGlyph } from '@session-chat/components/primitives/RunningGlyph'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cdp } from 'vitest/browser'
import { until } from '../../../../tests/support/awaitCondition'
// The loop joins the document clock when it starts (animationstart), a frame after it reports running.
const onBeat = (animation: Animation) => Math.abs(Number(animation.currentTime) - Number(animation.timeline!.currentTime)) < 50

/**
 * Root contract: the transcript's running mark is the shared four-state glyph. One stepped compositor transform,
 * four changes a second on the document clock; nothing on the main thread steps it, and it holds still whenever it
 * cannot be seen.
 */
const teardown: Array<() => void> = []
beforeEach(async () => {
  // Pin the test baseline instead of inheriting the runner's system Reduce Motion preference.
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
})
afterEach(async () => {
  while (teardown.length) teardown.pop()?.()
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
  vi.restoreAllMocks()
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
})

function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  teardown.push(render(() => <RunningGlyph />, host), () => host.remove())
  const strip = () => host.querySelector<HTMLElement>('.gg-running-glyph__strip')!
  return { host, strip, animations: () => strip().getAnimations() }
}

it('turns four steps a second on CSS alone and stops while its window is not seen', async () => {
  const timers = vi.spyOn(window, 'setInterval')
  const { strip, animations } = mount()
  // The frames are generated content: the glyph carries no DOM text to copy or read.
  expect(getComputedStyle(strip(), '::before').content.replace(/[^\u2800-\u28ff]/gu, '')).toBe('⠚⠓⠋⠙')
  expect(strip().textContent).toBe('')
  await until('the glyph turns', () => animations().length === 1 && animations()[0]!.playState === 'running')
  const timing = animations()[0]!.effect!.getComputedTiming()
  expect(timing.iterations).toBe(Infinity)
  expect(timing.duration).toBe(1000)
  expect(getComputedStyle(strip()).animationTimingFunction).toBe('steps(4)')
  expect(timers).not.toHaveBeenCalled()
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }))
  await until('it stops with the window', () => animations().length === 0)
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }))
  await until('and turns again when it is seen', () => animations()[0]?.playState === 'running')
})

it('stops offscreen and starts again on the shared beat', async () => {
  const { host, animations } = mount()
  await until('the glyph turns', () => animations()[0]?.playState === 'running')
  host.style.cssText = 'position:fixed;top:20000px'
  await until('offscreen glyph has no animation', () => animations().length === 0)
  host.style.cssText = ''
  await until('visible glyph turns again', () => animations()[0]?.playState === 'running')
  const animation = animations()[0]!
  await until('it is back on the shared beat', () => onBeat(animation))
})

it('keeps its boxes inside the one line it shows, on every frame', async () => {
  const { host, strip, animations } = mount()
  await until('the glyph turns', () => animations()[0]?.playState === 'running')
  const glyph = host.querySelector<HTMLElement>('.gg-running-glyph')!.getBoundingClientRect()
  for (const frame of [0, 250, 500, 750]) {
    animations()[0]!.currentTime = frame
    expect(strip().getBoundingClientRect().bottom).toBeLessThanOrEqual(glyph.bottom + 0.5)
  }
})

it('holds the first frame under reduced motion', async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const { strip, animations } = mount()
  expect(animations()).toHaveLength(0)
  expect(getComputedStyle(strip()).transform).toBe('none')
})
