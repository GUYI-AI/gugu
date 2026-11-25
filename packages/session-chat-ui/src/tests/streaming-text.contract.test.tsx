/** @jsxImportSource solid-js */
/**
 * streaming-text.contract — what the stream fade owes, measured on the real DOM
 * rather than asserted in a comment.
 *
 * While a message streams, an html text run wraps the text appended since the
 * last paint in `.gg-md-fresh` spans that fade in. That is a real change to the
 * box tree of an already-measured block, and this transcript positions every
 * row from a height computed offscreen *before* the row mounts. So the fade owes
 * two things:
 *
 *   ① It must not move anything. Measured here as: the same text mounted
 *      streaming and committed puts every text box in the same place at the same
 *      width, and each mode agrees with its own `measure()`.
 *
 *   ② It must stop when the reader asked animation to stop. Every other motion
 *      in this package reads `prefers-reduced-motion`.
 *
 * ① is NOT measured by the row height. A message row carries its measured height
 * as an inline style, and every block frame inside it is given its height too —
 * so `offsetHeight` equals `measure()` by construction however badly a span
 * reflows. What can move is the text: its boxes are read one character at a
 * time (a Range per character), so the fade spans' own element boxes stay out of
 * the reading, and the run element's height is compared as the one box that
 * grows if the text wraps differently.
 *
 * ① also needs a positive control or it is not a reading: if the streaming
 * render wrapped nothing, "both modes agree" would be trivially true. Only text
 * that arrives after a row mounts fades, so the streaming row mounts with the
 * run's first words and then grows to the whole run, as a live reply does. The
 * faded text is asserted to be all of what arrived (the whole run but the words
 * it mounted with) on the streaming side and 0 on the committed side — one
 * instrument read present and absent on two renders that end on the same text.
 *
 * ② needs a control on the *instrument*: `Emulation.setEmulatedMedia` failing
 * silently and the media query genuinely not matching read the same downstream.
 * Every reading below is therefore paired with `matchMedia(...).matches`, and a
 * reading taken while that disagrees with the mode we asked for is void, not
 * passing.
 */

import { messageUnitDef } from '@session-chat/components/rows/message/message.def'
import type { ChatMessage } from '@session-chat/model'
import { cdp } from 'vitest/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { makeContractCtx, renderAndMeasureUnit, type HeightContractReading } from './contract'

const WIDTH = 420

/**
 * One bold run on purpose: it puts text boxes at non-zero x on the first line,
 * so the left-edge sum below is a real reading rather than 0 against 0.
 */
const TEXT =
  'Streaming text reveals **each new word** as it arrives, while the words already ' +
  'on screen stay exactly where they were before the chunk landed.'

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

/** What the streaming row mounts with before the rest of TEXT arrives; the space after it is not a word and does not fade. */
const MOUNTED = 'Streaming text reveals '

function message(id: string, streaming: boolean, text = TEXT): ChatMessage {
  // Distinct ids: the streaming and committed parses are cached per message id,
  // and sharing one id would let the first parse answer for the second.
  return { kind: 'message', id, role: 'assistant', text, streaming }
}

/**
 * Read off the still-mounted host. Numbers only — `inspected` is a
 * `Record<string, number>`. Text rects are summed at 1/100 px: a span that
 * changed character advance would move text by a fraction of a pixel long
 * before it moved anything by a whole one.
 */
function inspectRun(host: HTMLElement): Record<string, number> {
  const run = host.querySelector<HTMLElement>('.gg-md')
  const fresh = Array.from(host.querySelectorAll<HTMLElement>('.gg-md-fresh'))
  let animating = 0
  let fullyOpaque = 0
  for (const span of fresh) {
    const style = getComputedStyle(span)
    if (style.animationName !== 'none') animating += 1
    if (style.opacity === '1') fullyOpaque += 1
  }

  const hostRect = host.getBoundingClientRect()
  // Each character's box, by its place in the run (`l3`, `t3`, `w3`): per character, not per text node, since the fade
  // splits the text into a span per word.
  const charBoxes: Record<string, number> = {}
  let boxes = 0
  if (run) {
    const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      for (let at = 0; at < node.length; at += 1) {
        // A space draws nothing; one ending a text node at a wrap measures one box instead of two.
        if (!node.data[at]!.trim()) continue
        range.setStart(node, at)
        range.setEnd(node, at + 1)
        for (const rect of Array.from(range.getClientRects())) {
          charBoxes[`l${boxes}`] = rect.left - hostRect.left
          charBoxes[`t${boxes}`] = rect.top - hostRect.top
          charBoxes[`w${boxes}`] = rect.width
          boxes += 1
        }
      }
    }
  }

  return {
    runHeight: run?.offsetHeight ?? -1,
    runText: run?.textContent?.length ?? 0,
    freshText: fresh.reduce((sum, span) => sum + (span.textContent?.length ?? 0), 0),
    freshSpans: fresh.length,
    animating,
    fullyOpaque,
    matchesReduce: window.matchMedia(REDUCE_QUERY).matches ? 1 : 0,
    boxes,
    ...charBoxes
  }
}

/** Where the two renders put a character apart by more than layout rounding (Chrome lays out in 1/64 px). */
function movedText(a: HeightContractReading, b: HeightContractReading): string[] {
  const moved = a.inspected.runHeight === b.inspected.runHeight && a.inspected.boxes === b.inspected.boxes
    ? []
    : [`run ${a.inspected.runHeight}px/${a.inspected.boxes} boxes vs ${b.inspected.runHeight}px/${b.inspected.boxes} boxes`]
  for (let i = 0; i < a.inspected.boxes!; i += 1) {
    for (const key of [`l${i}`, `t${i}`, `w${i}`]) {
      if (Math.abs(a.inspected[key]! - b.inspected[key]!) > 0.1) moved.push(`${key}: ${a.inspected[key]} vs ${b.inspected[key]}`)
    }
  }
  return moved
}

async function emulateReducedMotion(value: 'reduce' | 'no-preference'): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }]
  })
}

function readStreaming(id: string): Promise<HeightContractReading> {
  return renderAndMeasureUnit(messageUnitDef, message(id, true, MOUNTED), makeContractCtx({ width: WIDTH }), inspectRun, {}, message(id, true))
}

afterEach(async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [] })
})

describe('streaming fade', () => {
  it('does not move the text it is painted over', async () => {
    const streaming = await readStreaming('stream-geometry')
    const committed = await renderAndMeasureUnit(
      messageUnitDef,
      message('stream-geometry-committed', false),
      makeContractCtx({ width: WIDTH }),
      inspectRun
    )

    // ① The fade actually wrapped the text — and only while streaming. Without
    //    this, everything below is a statement about two identical renders.
    expect(streaming.inspected.runText).toBeGreaterThan(0)
    expect(streaming.inspected.freshText).toBe(streaming.inspected.runText - MOUNTED.length)
    expect(committed.inspected.freshSpans).toBe(0)

    // ② The proof: every character sits where it sat without the spans, at the
    //    same width, and the run is the same height — to layout rounding: a span
    //    holds whole words, and text is never shaped across a space.
    expect(movedText(streaming, committed), 'the fade moved text').toEqual([])
    expect(streaming.spill).toBe(committed.spill)

    // ③ House invariant: each mode agrees with the height the engine reserved
    //    for it offscreen, and the two modes reserve the same one.
    expect(streaming.dom, `streaming: engine=${streaming.computed}px DOM=${streaming.dom}px`).toBe(
      streaming.computed
    )
    expect(committed.dom, `committed: engine=${committed.computed}px DOM=${committed.dom}px`).toBe(
      committed.computed
    )
    expect(streaming.dom).toBe(committed.dom)
  })

  it('animates the newly revealed text when motion is allowed', async () => {
    await emulateReducedMotion('no-preference')
    const reading = await readStreaming('stream-motion-on')

    // Instrument control: we asked for motion, the page must agree it has it.
    expect(reading.inspected.matchesReduce, 'emulation did not take: reading is void').toBe(0)

    expect(reading.inspected.freshSpans).toBeGreaterThan(0)
    expect(reading.inspected.animating).toBe(reading.inspected.freshSpans)
  })

  it('runs no animation under prefers-reduced-motion, and leaves the text readable', async () => {
    await emulateReducedMotion('reduce')
    const reading = await readStreaming('stream-motion-off')

    // Instrument control: a silently-ignored CDP call and a genuinely
    // non-matching query read the same downstream. Fail here, not there.
    expect(reading.inspected.matchesReduce, 'emulation did not take: reading is void').toBe(1)

    expect(reading.inspected.freshSpans).toBeGreaterThan(0)
    expect(reading.inspected.animating, 'fresh text still animates under prefers-reduced-motion').toBe(0)

    // The reverse control. Turning the fade off must leave the text at its
    // final, readable state — not frozen at the `from` keyframe. `fill-mode:
    // both` holds opacity 0 forever if the animation is merely paused instead
    // of removed, which reads as "the message never arrived".
    expect(
      reading.inspected.fullyOpaque,
      'fresh text is not at final opacity — the fade froze instead of being removed'
    ).toBe(reading.inspected.freshSpans)
  })

  it('keeps identical text geometry with motion on and off', async () => {
    await emulateReducedMotion('no-preference')
    const withMotion = await readStreaming('stream-geom-motion-on')
    expect(withMotion.inspected.matchesReduce, 'emulation did not take: reading is void').toBe(0)

    await emulateReducedMotion('reduce')
    const withoutMotion = await readStreaming('stream-geom-motion-off')
    expect(withoutMotion.inspected.matchesReduce, 'emulation did not take: reading is void').toBe(1)

    // Reduced motion may remove paint. It may not remove layout: the row height
    // was reserved offscreen and does not know about the reader's preference.
    expect(withoutMotion.inspected.freshSpans).toBe(withMotion.inspected.freshSpans)
    expect(movedText(withoutMotion, withMotion), 'reduced motion moved text').toEqual([])
    expect(withoutMotion.dom).toBe(withMotion.dom)
    expect(withoutMotion.dom).toBe(withoutMotion.computed)
  })
})
