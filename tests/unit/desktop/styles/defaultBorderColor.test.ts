import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwind from '@tailwindcss/postcss'
import postcss, { type AcceptedPlugin, type AtRule, type Root, type Node, type Rule } from 'postcss'
import { beforeAll, expect, it } from 'vitest'
import { rendererHtmlEntries } from '../../../../scripts/build/product-build-entries.mts'
// @ts-expect-error -- plain ESM check script
import { HAS_OFF_SUBJECT_KNOWN_UTILITIES, wideInvalidation, wideInvalidationIn } from '../../../../scripts/checks/check-css-parses.mjs'

const entries = ['apps/desktop/src/styles/tokens.css', 'apps/desktop/src/session/renderer/index.css']
const compiled: Root[] = []
beforeAll(async () => {
  for (const entry of entries) {
    const from = resolve(entry)
    const result = await postcss([tailwind({ base: process.cwd(), optimize: false }) as unknown as AcceptedPlugin]).process(readFileSync(from, 'utf8'), { from })
    compiled.push(postcss.parse(result.css))
  }
})
function isAtRule(node: Node): node is AtRule {
  return node.type === 'atrule'
}
function isRule(node: Node): node is Rule {
  return node.type === 'rule'
}
function layers(node: Node): string[] {
  const chain: string[] = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isAtRule(parent) && parent.name === 'layer') chain.unshift(parent.params)
  }
  return chain
}
it.each([0, 1])('keeps entry %i Preflight below ordinary base rules', index => {
  let found = 0
  compiled[index].walkDecls('border', decl => {
    if (decl.value !== '0 solid') return
    found++
    expect(layers(decl).join('.')).toBe('base.preflight')
  })
  expect(found).toBeGreaterThan(0)
})
it.each([0, 1])('gives entry %i a color-only semantic base default', index => {
  let found = 0
  compiled[index].walkDecls('border-color', decl => {
    if (decl.value !== 'var(--border-color, var(--border, currentColor))') return
    found++
    expect(layers(decl)).toEqual(['base'])
    const rule = decl.parent
    if (!rule || !isRule(rule)) throw new Error('The semantic border default must belong to a CSS rule')
    expect(rule.selector).toContain('::before')
    expect(rule.selector).toContain('::backdrop')
    expect(rule.selector).toContain('::file-selector-button')
    expect(rule.nodes.filter(node => node.type === 'decl')).toHaveLength(1)
  })
  expect(found).toBe(1)
})
function flatSelector(rule: Rule): string {
  const chain = [rule.selector]
  for (let parent: Node | undefined = rule.parent; parent; parent = parent.parent) {
    if (isRule(parent)) chain.unshift(parent.selector)
  }
  return chain.join(' ')
}
// @@@wide-invalidation — the Tailwind utilities used in TSX only exist in the compiled sheet, so the selector gate
// (scripts/checks/check-css-parses.mjs) reads it here too: `has-[…]:[&>x]:…` and `group-has-*` compile to a `:has()`
// off the styled element, `[svg~&]:…` to a sibling rule keyed by a bare tag.
// Rules written in .css files are judged where they are written (the lint gate); here only the utilities: Tailwind
// emits each as one outermost rule whose selector is the escaped class.
it('keeps the compiled Tailwind utilities free of selectors that widen style invalidation', () => {
  expect(wideInvalidation(':is(:where(.group\\/field):has(:disabled) *)')).toEqual(['has-off-subject'])
  const utility = (selector: string) => /^\.(?:\\.|[\w-])+$/.test(selector) && selector.includes('\\') ? selector.slice(1).replace(/\\(.)/g, '$1') : null
  const hits = new Set<string>()
  for (const root of compiled) {
    for (const hit of wideInvalidationIn(root) as { reason: string; outermost: string }[]) {
      const name = utility(hit.outermost)
      if (name) hits.add(hit.reason === 'has-off-subject' ? name : `${hit.reason}: ${name}`)
    }
  }
  expect(utility('.has-\\[\\>svg\\]\\:p-0')).toBe('has-[>svg]:p-0')
  expect([...hits].sort()).toEqual(HAS_OFF_SUBJECT_KNOWN_UTILITIES)
})
// @@@mark-on-the-focused-element — the input-modality mark (lib/focus-modality.ts) sits on the focused element. A rule
// that reads it from an ancestor or sibling through `:is(… *)` (Tailwind's group- / peer- compounds of focus-visible)
// makes that element re-style its whole subtree whenever the mark changes: a click on the message list re-styled the chat.
it.each([0, 1])('keeps entry %i free of rules that read the focus mark through a universal selector', index => {
  const throughUniversal = /\[data-pointer-focus\]\)?\s*[>+~]?\s*\*/
  expect(throughUniversal.test(':is(:where(.group\\/row):focus-visible:not([data-pointer-focus]) *)')).toBe(true)
  expect(throughUniversal.test(':is(:where(.peer):focus-visible:not([data-pointer-focus])~*)')).toBe(true)
  expect(throughUniversal.test(':where(.group\\/row):focus-visible:not([data-pointer-focus]) .x')).toBe(false)
  const hits: string[] = []
  compiled[index].walkRules(rule => {
    if (throughUniversal.test(flatSelector(rule))) hits.push(flatSelector(rule))
  })
  expect(hits).toEqual([])
})
// Portals append to <body>; if #root could flip :last-child, the first portal would restyle the whole app.
it.each(Object.values(rendererHtmlEntries))('keeps a fixed element after #root in %s', entry => {
  const body = readFileSync(entry, 'utf8').replace(/<!--.*?-->/gs, '')
  expect(body).toMatch(/<div id="root"><\/div>\s*<div data-root-sibling hidden><\/div>/)
})
