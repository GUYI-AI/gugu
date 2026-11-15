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

it('the held results are not dimmed within 150 ms: the dimming is an animation that starts after a 150 ms delay', () => {
  const stale = declarations(rule('.gg-stale'))
  // Nothing applies at once: no opacity of its own, no transition (that would start moving at 0 ms).
  expect(stale.opacity).toBeUndefined()
  expect(stale.transition).toBeUndefined()
  const [name, duration, , delay, fill] = stale.animation!.split(/\s+/)
  expect(delay).toBe('150ms')
  expect(fill).toBe('forwards')
  expect(duration).toBe('0s')
  const end = keyframes(name!).nodes!.find((node): node is Rule => node.type === 'rule' && node.selector === 'to')!
  expect(declarations(end).opacity).toBe('0.6')
})

it('uses the same delay as the unknown slot (one rule for "a value on its way")', () => {
  const unknownDelay = declarations(rule('.gg-unknown')).animation!.split(/\s+/)[3]
  expect(declarations(rule('.gg-stale')).animation!.split(/\s+/)[3]).toBe(unknownDelay)
})
