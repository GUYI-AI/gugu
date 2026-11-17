/** @jsxImportSource solid-js */
/**
 * A width change re-measures every block of a stack (the width is in measureBlockCached's fingerprint). A transcript
 * html block's DOM depends on its content only, so a re-measure must not rebuild it: one sidebar fold changes the
 * transcript width a few times, and each rebuild re-parsed every paragraph of every card (`innerHTML`, mention icons,
 * highlight). Its frame still follows the new measure. New content (a streaming tail chunk, an edit) still repaints.
 */

import { BlockStackView } from '@session-chat/components/primitives/BlockStackView'
import { CachesContext } from '@session-chat/components/contexts/CachesContext'
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext'
import { layoutBlockStack } from '@session-chat/components/rows/markdown/block-stack'
import { createChatCaches } from '@session-chat/core/caches'
import type { Measured } from '@session-chat/core/define'
import type { StackLayout } from '@session-chat/core/compose'
import type { Block } from '@session-chat/core/markdown/document'
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { makeContractCtx } from '@session-chat/tests/contract'

const PROSE = Array.from({ length: 3 }, (_, i) => `Paragraph ${i} of a long answer, wide enough to wrap differently at another width. `.repeat(4)).join('\n\n')

let dispose: (() => void) | undefined
let host: HTMLElement | undefined
afterEach(() => {
  dispose?.()
  host?.remove()
  dispose = host = undefined
})

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

function mount(blocks: Block[], width: number) {
  const ctx = (w: number) => makeContractCtx({ width: w })
  const [stack, setStack] = createSignal<Measured<StackLayout>>(layoutBlockStack(blocks, ctx(width)))
  host = document.createElement('div')
  host.style.width = `${width}px`
  document.body.appendChild(host)
  dispose = render(
    () => (
      <ThemeContext.Provider value={() => DEFAULT_THEME}>
        <CachesContext.Provider value={createChatCaches()}>
          <BlockStackView node={stack()} />
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ),
    host
  )
  return {
    relayout(next: Block[], w: number) {
      host!.style.width = `${w}px`
      setStack(layoutBlockStack(next, ctx(w)))
    },
    stack,
    bodies: () => [...host!.querySelectorAll<HTMLElement>('.gg-md')],
  }
}

describe('a transcript html block keeps its DOM when only the width changes', () => {
  it('keeps every paragraph across a width change, and its frame follows the new measure', async () => {
    const blocks = parseMarkdownToBlocks('m1', PROSE)
    expect(blocks.every((b) => b.kind === 'html'), 'fixture: prose parses to html blocks').toBe(true)
    const view = mount(blocks, 520)
    await frame()
    const before = view.bodies()
    const paragraphs = before.flatMap((el) => [...el.querySelectorAll('p')])
    expect(paragraphs.length).toBeGreaterThan(0)

    view.relayout(blocks, 360)
    await frame()

    const after = view.bodies()
    // Identity, not structure: a rebuilt body has the same markup.
    expect(after.length).toBe(before.length)
    expect(after.filter((el, i) => el !== before[i]).length, 'html block bodies rebuilt by a width change').toBe(0)
    const nowParagraphs = after.flatMap((el) => [...el.querySelectorAll('p')])
    expect(nowParagraphs.filter((p, i) => p !== paragraphs[i]).length, 'paragraphs re-parsed by a width change').toBe(0)
    const heights = view.stack().layout.placed.map((p) => p.child.height)
    const frames = after.map((el) => el.parentElement!.getBoundingClientRect().height)
    expect(frames, 'frames kept the old width’s heights').toEqual(heights)
    expect(heights.some((h, i) => h !== layoutBlockStack(blocks, makeContractCtx({ width: 520 })).layout.placed[i].child.height),
      'fixture: the narrower width must change some height').toBe(true)
  })

  it('still repaints a block whose content changed (a streaming tail chunk is a new block)', async () => {
    const first = parseMarkdownToBlocks('m2', 'Streaming answer, first chunk')
    const view = mount(first, 520)
    await frame()
    const [before] = view.bodies()

    const grown = parseMarkdownToBlocks('m2', 'Streaming answer, first chunk and the second')
    view.relayout(grown, 520)
    await frame()

    const [after] = view.bodies()
    expect(after.textContent).toBe('Streaming answer, first chunk and the second')
    expect(after, 'a new source block is a new block: it mounts, as before').not.toBe(before)
  })
})
