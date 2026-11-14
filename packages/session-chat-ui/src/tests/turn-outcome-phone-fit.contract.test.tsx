/** @jsxImportSource solid-js */
import { describe, expect, it } from 'vitest'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import type { TurnOutcomeItem } from '@session-chat/model'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

const signIn: TurnOutcomeItem = { kind: 'turn-outcome', id: 'sign-in:outcome', turnId: 'sign-in',
  outcome: { kind: 'error', reason: 'prompt_failed', signInRequired: true }, prompt: 'retry me' }
const said: TurnOutcomeItem = { kind: 'turn-outcome', id: 'said:outcome', turnId: 'said',
  outcome: { kind: 'error', said: 'upstream refused' } }

/** Width the badge's own contents take on one line, read from the DOM the row painted. */
function naturalBadgeWidth(badge: HTMLElement) {
  const clone = badge.cloneNode(true) as HTMLElement
  clone.style.cssText = 'position:absolute;visibility:hidden;width:max-content;height:auto'
  document.body.appendChild(clone)
  const width = clone.getBoundingClientRect().width
  clone.remove()
  return width
}

describe('the turn outcome badge is measured from what it paints', () => {
  // The page picks the middle dot's glyph by language (zh-CN on a phone: a CJK font, 6px), while off-screen measurement
  // sees a Latin one (about 3px). `monospace` stands in for such a fallback: a different, wider glyph for the same dot.
  for (const glyph of ['inherit', 'monospace']) for (const [name, data] of [['sign-in needed', signIn], ['upstream said', said]] as const) {
    for (const width of [296, 640]) {
      it(`gives "${name}" the width of its label, separator and reason at ${width}px (dot font: ${glyph})`, async () => {
        const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, data, makeContractCtx({ width }), host => {
          for (const dot of host.querySelectorAll<HTMLElement>('[data-slot="turn-outcome-badge"] > [aria-hidden="true"]')) dot.style.fontFamily = glyph
          const badge = host.querySelector<HTMLElement>('[data-slot="turn-outcome-badge"]')!
          const reason = host.querySelector<HTMLElement>('[data-slot="turn-outcome-reason"]')!
          const range = document.createRange()
          range.selectNodeContents(reason)
          return { set: badge.getBoundingClientRect().width, natural: naturalBadgeWidth(badge), reasonLines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size }
        }, { onRestorePrompt: () => {} })
        // The separator sits in a fixed-width box, so the badge's reserved width holds whatever glyph the page picks for the dot.
        expect(Math.abs(reading.inspected.set - reading.inspected.natural)).toBeLessThan(0.1)
        expect(reading.inspected.reasonLines).toBe(1)
        expect(reading.dom).toBe(reading.computed)
      })
    }
  }

  it('paints the outcome lane on the transcript surface, not a card step', async () => {
    const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, signIn, makeContractCtx({ width: 296 }), host => {
      // A host whose card step differs from its transcript surface, as the phone page does in dark.
      host.style.setProperty('--chat-bg', 'rgb(24, 24, 24)')
      host.style.setProperty('--chat-bg-1', 'rgb(33, 33, 33)')
      const surfaces = ['[data-slot="turn-outcome"]', '[data-slot="turn-outcome-lane"]']
        .map(selector => getComputedStyle(host.querySelector(selector)!).backgroundColor)
      return { matching: surfaces.filter(color => color === 'rgb(24, 24, 24)').length }
    }, { onRestorePrompt: () => {} })
    expect(reading.inspected.matching).toBe(2)
  })
})
