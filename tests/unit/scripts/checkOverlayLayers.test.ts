import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM check script
import { hardCodedLayers } from '../../../scripts/checks/check-overlay-layers.mjs'

// Class names are assembled: Tailwind scans this file too, and a whole one would be compiled into the app.
const z = (value: string) => `z-${value}`

describe('overlay-layers gate (#3857)', () => {
  it('flags overlay-level hard-coded z-indices in Tailwind classes, style objects, vanilla-extract and CSS', () => {
    expect(hardCodedLayers(`className="fixed inset-0 ${z('50')} bg-black"`).map((hit: { line: number }) => hit.line)).toEqual([1])
    expect(hardCodedLayers(`className="${z('[51]')} rounded-2xl"`)).toHaveLength(1)
    expect(hardCodedLayers(`className="data-open:${z('50')}"`)).toHaveLength(1)
    expect(hardCodedLayers('const s = { zIndex: 500 }')).toHaveLength(1)
    expect(hardCodedLayers("style({ zIndex: '9999' })")).toHaveLength(1)
    expect(hardCodedLayers('.a {\n  z-index: 100;\n}')).toEqual([{ line: 2, text: 'z-index: 100' }])
  })

  it('allows layer tokens, the provider-computed layer and small local orders', () => {
    expect(hardCodedLayers(`className="isolate ${z('[var(--z-menu)]')}"`)).toEqual([])
    expect(hardCodedLayers("style={{ zIndex: useUiPopupZIndex() }}")).toEqual([])
    expect(hardCodedLayers("zIndex: 'var(--z-modal, 50)'")).toEqual([])
    expect(hardCodedLayers(`className="relative ${z('10')} ${z('[1]')}"`)).toEqual([])
    expect(hardCodedLayers('const s = { zIndex: 30 }')).toEqual([])
    expect(hardCodedLayers(`className="max-${z('50')}"`.replace('max-', 'size-'))).toEqual([])
  })

  it('ignores comments', () => {
    expect(hardCodedLayers(`// the old ${z('50')} lost to the sheet\nconst a = 1`)).toEqual([])
    expect(hardCodedLayers(`/* zIndex: 500 */\nconst a = 1`)).toEqual([])
  })
})
