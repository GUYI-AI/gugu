/** @jsxImportSource solid-js */
import { describe, expect, it } from 'vitest'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import { defaultChatTranslator } from '@session-chat/localization'
import type { TurnOutcomeItem } from '@session-chat/model'
import { zhCNMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages'
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
  for (const locale of ['en-US', 'zh-CN']) for (const [name, data] of [['sign-in needed', signIn], ['upstream said', said]] as const) {
    for (const width of [296, 640]) {
      it(`fits "${name}" at ${width}px in ${locale}`, async () => {
        const ctx = makeContractCtx({ width })
        if (locale === 'zh-CN') {
          ctx.translate = (key, values) => (zhCNMessages as Record<string, string>)[key] ?? defaultChatTranslator(key, values)
        }
        const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, data, ctx, host => {
          const badge = host.querySelector<HTMLElement>('[data-slot="turn-outcome-badge"]')!
          const reason = host.querySelector<HTMLElement>('[data-slot="turn-outcome-reason"]')!
          if (data === signIn) expect(reason.textContent).toBe(locale === 'zh-CN' ? '需要登录' : 'sign-in needed')
          expect(badge.textContent).not.toContain('·')
          const range = document.createRange()
          range.selectNodeContents(reason)
          return { set: badge.getBoundingClientRect().width, natural: naturalBadgeWidth(badge), reasonLines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size }
        }, { onRestorePrompt: () => {} })
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
