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

/** The shared timing (@@@placeholder-reveal): `--gg-placeholder-delay` / `--gg-placeholder-duration` on :root. */
function timing(): { delay: string; duration: string } {
  const root = declarations(rule(':root'))
  return { delay: root['--gg-placeholder-delay']!, duration: root['--gg-placeholder-duration']! }
}

it('the held results are not dimmed within 150 ms, then dim over 250 ms: an animation after a delay', () => {
  const stale = declarations(rule('.gg-stale'))
  // Nothing applies at once: no opacity of its own, no transition (that would start moving at 0 ms).
  expect(stale.opacity).toBeUndefined()
  expect(stale.transition).toBeUndefined()
  expect(timing()).toEqual({ delay: '150ms', duration: '250ms' })
  const [name, duration, , delay, fill] = stale.animation!.split(/\s+/)
  expect([duration, delay, fill]).toEqual(['var(--gg-placeholder-duration)', 'var(--gg-placeholder-delay)', 'both'])
  const frames = keyframes(name!).nodes!.filter((node): node is Rule => node.type === 'rule')
  expect(declarations(frames.find((node) => node.selector === 'from')!).opacity).toBe('1')
  expect(declarations(frames.find((node) => node.selector === 'to')!).opacity).toBe('0.6')
})

it('the placeholder, the loading lines and the held results share one timing (one rule for "a value on its way")', () => {
  const placeholder = declarations(rule('.gg-unknown, .gg-loading-line'))
  const stale = declarations(rule('.gg-stale'))
  const timingOf = (animation: string) => animation.split(/\s+/).filter((part) => part.startsWith('var('))
  expect(timingOf(placeholder.animation!)).toEqual(timingOf(stale.animation!))
  const [name] = placeholder.animation!.split(/\s+/)
  const frames = keyframes(name!).nodes!.filter((node): node is Rule => node.type === 'rule')
  expect(declarations(frames.find((node) => node.selector === 'from')!).opacity).toBe('0')
})
