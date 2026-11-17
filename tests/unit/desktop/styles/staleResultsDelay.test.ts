import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss, { type AtRule, type Rule } from 'postcss'
import { expect, it } from 'vitest'

/**
 * Review 5: a search surface's held results (`.gg-stale`) follow the unknown slot's rule — no visible change for the first
 * 150 ms (a read that answers sooner changes nothing on screen), dimmed after that. Done in CSS, ❌ a JS timer: the rule
 * itself is what is checked (an animation that only starts after its delay, ending at the dimmed opacity).
 */
const css = postcss.parse(readFileSync(resolve('apps/desktop/src/styles/tokens.css'), 'utf8'))

function rule(selector: string): Rule {
  let found: Rule | undefined
  css.walkRules((node) => { if (node.selector === selector && node.parent?.type === 'root') found = node })
  if (!found) throw new Error(`no ${selector} rule`)
  return found
}

function keyframes(name: string): AtRule {
  let found: AtRule | undefined
  css.walkAtRules('keyframes', (node) => { if (node.params === name) found = node })
  if (!found) throw new Error(`no @keyframes ${name}`)
  return found
}

const declarations = (node: Rule) => Object.fromEntries(node.nodes.flatMap((child) => child.type === 'decl' ? [[child.prop, child.value]] : []))

/** The shared timing (@@@placeholder-reveal): `--gg-placeholder-delay` / `-duration` / `-easing` on :root. */
function timing(): { delay: string; duration: string; easing: string } {
  const root = declarations(rule(':root'))
  return { delay: root['--gg-placeholder-delay']!, duration: root['--gg-placeholder-duration']!, easing: root['--gg-placeholder-easing']! }
}

/** The opacity a placeholder has `ms` after it is drawn, by the tokens (CSS cubic-bezier, solved for x). */
function placeholderOpacityAt(ms: number): number {
  const { delay, duration, easing } = timing()
  const progress = Math.min(1, Math.max(0, (ms - parseFloat(delay)) / parseFloat(duration)))
  const [x1, y1, x2, y2] = easing.match(/[\d.]+/g)!.map(Number) as [number, number, number, number]
  const at = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
  let lo = 0, hi = 1
  for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (at(mid, x1, x2) < progress) lo = mid; else hi = mid }
  return at(lo, y1, y2)
}

it('the held results are not dimmed within 150 ms, then dim slowly: an animation after a delay', () => {
  const stale = declarations(rule('.gg-stale'))
  // Nothing applies at once: no opacity of its own, no transition (that would start moving at 0 ms).
  expect(stale.opacity).toBeUndefined()
  expect(stale.transition).toBeUndefined()
  expect(timing()).toMatchObject({ delay: '150ms', duration: '450ms' })
  const [name, duration, easing, delay, fill] = stale.animation!.split(/\s(?![^(]*\))/)
  expect([duration, easing, delay, fill]).toEqual(['var(--gg-placeholder-duration)', 'var(--gg-placeholder-easing)', 'var(--gg-placeholder-delay)', 'both'])
  const frames = keyframes(name!).nodes!.filter((node): node is Rule => node.type === 'rule')
  expect(declarations(frames.find((node) => node.selector === 'from')!).opacity).toBe('1')
  expect(declarations(frames.find((node) => node.selector === 'to')!).opacity).toBe('0.6')
})

it('the placeholder, the loading lines and the held results share one timing (one rule for "a value on its way")', () => {
  const placeholder = declarations(rule('.gg-unknown, .gg-loading-line'))
  const stale = declarations(rule('.gg-stale'))
  const timingOf = (animation: string) => animation.split(/\s(?![^(]*\))/).filter((part) => part.startsWith('var('))
  expect(timingOf(placeholder.animation!)).toEqual(timingOf(stale.animation!))
  const [name] = placeholder.animation!.split(/\s/)
  const frames = keyframes(name!).nodes!.filter((node): node is Rule => node.type === 'rule')
  expect(declarations(frames.find((node) => node.selector === 'from')!).opacity).toBe('0')
})

it('a placeholder is still under half visible 450 ms after it is drawn (a read answering within ~half a second leaves a faint bar)', () => {
  expect(placeholderOpacityAt(150)).toBe(0)
  expect(placeholderOpacityAt(450)).toBeLessThan(0.5)
  expect(placeholderOpacityAt(600)).toBeCloseTo(1)
})
