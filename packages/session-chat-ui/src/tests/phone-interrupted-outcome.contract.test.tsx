/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from 'vitest'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import { defaultChatTranslator } from '@session-chat/localization'
import type { TurnOutcomeItem } from '@session-chat/model'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

const item = (retryable = true): TurnOutcomeItem => ({ kind: 'turn-outcome', id: 'phone:outcome', turnId: 'phone', prompt: 'Check the result',
  outcome: { kind: 'error', reason: 'process_closed', phoneInterruption: { jobId: 'original-job', retryable } } })

describe('an interrupted phone attempt has one explicit retry and retains the original record', () => {
  it.each([240, 390, 760])('measures the existing action layout exactly at width %s in both languages', async width => {
    for (const chinese of [false, true]) {
      const ctx = makeContractCtx({ width })
      ctx.translate = (key, values) => chinese && key === 'transcript.interrupted' ? '已中断'
        : chinese && key === 'transcript.retryPhoneTask' ? '重试' : defaultChatTranslator(key, values)
      const retry = vi.fn(async () => true), restore = vi.fn()
      let label = '', action = ''
      const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, item(), ctx, host => {
        label = host.querySelector('[data-slot="turn-outcome-badge"]')?.textContent ?? ''
        action = host.querySelector('[data-slot="turn-outcome-phone-retry"]')?.textContent ?? ''
        return { buttons: host.querySelectorAll('button').length }
      }, { onRetryPhoneTask: retry, onRestorePrompt: restore })
      expect(label).toBe(chinese ? '已中断' : 'Interrupted')
      expect(action).toBe(chinese ? '重试' : 'Retry')
      expect(reading.inspected.buttons).toBe(1)
      expect(reading.dom).toBe(reading.computed)
      expect(reading.spill).toBe(0)
      expect(retry).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
    }
  })

  it('dispatches only on a tap and prevents a second pending tap', async () => {
    let finish!: (value: boolean) => void
    const retry = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    await renderAndMeasureUnit(turnOutcomeUnitDef, item(), makeContractCtx({ width: 390 }), host => {
      const button = host.querySelector<HTMLButtonElement>('[data-slot="turn-outcome-phone-retry"]')!
      expect(retry).not.toHaveBeenCalled()
      button.click(); button.click()
      expect(button.disabled).toBe(true)
      expect(retry).toHaveBeenCalledExactlyOnceWith({ itemId: 'phone:outcome', jobId: 'original-job' })
      finish(true)
      return {}
    }, { onRetryPhoneTask: retry })
  })

  it('shows the interruption without a retry when custody was already retried or the host cannot retry', async () => {
    for (const [data, commands] of [[item(false), { onRetryPhoneTask: async () => true }], [item(), {}],
      [item(), { onRetryPhoneTask: async () => true, canRetryPhoneTask: () => false }]] as const) {
      const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, data, makeContractCtx({ width: 240 }), host => ({ buttons: host.querySelectorAll('button').length }), commands)
      expect(reading.inspected.buttons).toBe(0)
      expect(reading.dom).toBe(reading.computed)
    }
  })
})
