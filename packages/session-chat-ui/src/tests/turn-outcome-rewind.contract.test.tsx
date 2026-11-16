/** @jsxImportSource solid-js */
/**
 * #7304 A failed turn whose agent can step back offers 「退回重新编辑」 in place of 「取回指令」:
 * it opens that turn's own message for editing (sending removes the turn first, so the agent no longer
 * sees the failure). Where the agent cannot step back, the row keeps 「取回指令」. Measured height === DOM either way.
 */
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import type { ChatCommands } from '@session-chat/commands'
import type { TurnOutcomeItem } from '@session-chat/model'
import { describe, expect, it, vi } from 'vitest'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

const failed: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: 'turn-refused',
  id: 'turn-refused:outcome',
  outcome: { kind: 'error', reason: 'prompt_failed', said: 'This request has been flagged for possible cybersecurity risk.' },
  prompt: 'scan the open ports',
  promptItemId: 'user-1',
}

async function render(commands: ChatCommands, item: TurnOutcomeItem = failed) {
  let rewind: HTMLButtonElement | null = null
  const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, item, makeContractCtx({ width: 640 }), (host) => {
    rewind = host.querySelector<HTMLButtonElement>('[data-slot="turn-outcome-rewind"]')
    rewind?.click()
    return {
      rewind: rewind ? 1 : 0,
      restore: host.querySelector('[data-slot="turn-outcome-action"]') ? 1 : 0,
    }
  }, commands)
  expect(reading.dom).toBe(reading.computed)
  return reading.inspected
}

describe('rewinding a failed turn (#7304)', () => {
  it('opens the failed turn\'s own message when the agent can step back', async () => {
    const onEditMessage = vi.fn()
    const read = await render({ onEditMessage, canRevertMessage: (id) => id === 'user-1', onRestorePrompt: () => {} })
    expect(read).toEqual({ rewind: 1, restore: 0 })
    expect(onEditMessage).toHaveBeenCalledExactlyOnceWith({ itemId: 'user-1' })
  })

  it('keeps 「取回指令」 where the agent cannot step back', async () => {
    const onEditMessage = vi.fn()
    const read = await render({ onEditMessage, canRevertMessage: () => false, onRestorePrompt: () => {} })
    expect(read).toEqual({ rewind: 0, restore: 1 })
    expect(onEditMessage).not.toHaveBeenCalled()
  })

  it('offers no rewind on a stopped turn', async () => {
    const read = await render({ onEditMessage: vi.fn(), canRevertMessage: () => true },
      { ...failed, id: 'turn-refused:cancelled', outcome: { kind: 'cancelled', reason: 'cancelled' } })
    expect(read.rewind).toBe(0)
  })
})
