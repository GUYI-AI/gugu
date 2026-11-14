import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM check script
import { wideInvalidation, wideInvalidationIn } from '../../../scripts/checks/check-css-parses.mjs'

describe('css wide-invalidation gate', () => {
  it('flags a sibling combinator whose left compound has no class, id or attribute', () => {
    expect(wideInvalidation('.mg .tool-app-fields > * + *:not(.tool-app-saved)')).toEqual(['universal-sibling'])
    expect(wideInvalidation('.a > :not(.b) ~ .c')).toEqual(['universal-sibling'])
    expect(wideInvalidation('.a > :hover + .c')).toEqual(['universal-sibling'])
    // a bare tag is no key either: the rule joins the same catch-all set, and any insertion re-styles every
    // following sibling's descendants that match the right-hand side
    expect(wideInvalidation('.gg-md li + li')).toEqual(['tag-sibling'])
    expect(wideInvalidation('.t :is(th, td) + :is(th, td)')).toEqual(['tag-sibling'])
    expect(wideInvalidation('svg ~ .x')).toEqual(['tag-sibling'])
    expect(wideInvalidation('.a :is(li, :hover) ~ .c')).toEqual(['universal-sibling'])
  })

  it('accepts sibling combinators with a class, id, attribute or :is() of them on the left', () => {
    expect(wideInvalidation('.a + .b')).toEqual([])
    expect(wideInvalidation('[data-x] ~ *')).toEqual([])
    expect(wideInvalidation('li.item + li')).toEqual([])
    expect(wideInvalidation(':is(.a, [data-b]) + .c')).toEqual([])
    expect(wideInvalidation('.a > :not(:first-child, .b)')).toEqual([])
    expect(wideInvalidation(':nth-child(2n + 1)')).toEqual([])
  })

  it('flags :has() anywhere but on the styled element', () => {
    expect(wideInvalidation('[data-chat-surface]:has(.card) [data-running-bar-content]')).toEqual(['has-off-subject'])
    expect(wideInvalidation('.row:has(> .quote) > .name')).toEqual(['has-off-subject'])
    expect(wideInvalidation('.slot:has([data-active]) + .slot::before')).toEqual(['has-off-subject'])
    expect(wideInvalidation('.row:is(:hover, :has([data-highlighted])) .pin')).toEqual(['has-off-subject'])
    // Tailwind's group-has-* / in-has-*: the :has() sits on an ancestor inside :is()
    expect(wideInvalidation('.x:is(:where(.group):has(:disabled) *)')).toEqual(['has-off-subject'])
    expect(wideInvalidation('.a, .b:has(.c) .d')).toEqual(['has-off-subject'])
  })

  it('accepts :has() on the styled element itself, also through :is(), :not() and before a pseudo-element', () => {
    expect(wideInvalidation('.slot:has([data-active])')).toEqual([])
    expect(wideInvalidation('.slot:has([data-active])::before')).toEqual([])
    expect(wideInvalidation('.name:has(~ .quote)')).toEqual([])
    expect(wideInvalidation('.list > .slot:not(:has(~ .slot))::after')).toEqual([])
    expect(wideInvalidation('.row:is(:hover, :has([data-highlighted]))')).toEqual([])
    expect(wideInvalidation('button:has([data-slot="x"]):not(:has(> svg:only-child))')).toEqual([])
    expect(wideInvalidation('[title=":has(a) b"] .c')).toEqual([])
  })

  it('resolves native nesting before judging, and reports the offending selector of a list', () => {
    const hits = wideInvalidationIn(postcss.parse('.a:has(.b) { .c { color: red } &::after { color: red } }\n.ok, .x:has(.y) > .z { color: red }'))
    expect(hits).toEqual([
      { line: 1, selector: '.c', outermost: '.a:has(.b)', reason: 'has-off-subject' },
      { line: 2, selector: '.x:has(.y) > .z', outermost: '.x:has(.y) > .z', reason: 'has-off-subject' },
    ])
  })
})
