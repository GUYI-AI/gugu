import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM check script
import { ungatedFocusVisible } from '../../../scripts/checks/check-focus-modality.mjs'

describe('focus-modality gate', () => {
  it('flags a plain :focus-visible rule in CSS, a vanilla-extract selector and a Tailwind arbitrary variant', () => {
    expect(ungatedFocusVisible('.a:focus-visible { outline: 2px solid red; }', 'css')).toEqual([1])
    expect(ungatedFocusVisible("selectors: { '&:focus-visible': { outline: 'none' } }", 'ts')).toEqual([1])
    expect(ungatedFocusVisible("className='[&:focus-visible]:bg-red-500'", 'ts')).toEqual([1])
    expect(ungatedFocusVisible('.a {}\n.b:hover, .b:focus-visible { color: red }', 'css')).toEqual([2])
  })

  it('accepts the gated spellings, the absence of focus, the global switch-off, text fields, JS reads and comments', () => {
    expect(ungatedFocusVisible('.a:focus-visible:not([data-pointer-focus] *) { outline: 0 }', 'css')).toEqual([])
    expect(ungatedFocusVisible("className='[&:focus-visible:not([data-pointer-focus]_*)]:bg-red-500'", 'ts')).toEqual([])
    expect(ungatedFocusVisible(':focus:not(:focus-visible) { outline: none; }', 'css')).toEqual([])
    expect(ungatedFocusVisible('[data-pointer-focus] :focus-visible { outline: none; }', 'css')).toEqual([])
    expect(ungatedFocusVisible("'has-[[data-slot=input-group-control]:focus-visible]:ring-0'", 'ts')).toEqual([])
    expect(ungatedFocusVisible("if (el.matches(':focus-visible')) open()", 'ts')).toEqual([])
    expect(ungatedFocusVisible('/* the old :focus-visible ring */ .a {}', 'css')).toEqual([])
    expect(ungatedFocusVisible('// a plain :focus-visible would draw after a click\nconst x = 1', 'ts')).toEqual([])
  })
})
