// A reader of another machine's timeline asks for pages folded and reads a held turn back whole when a row of it comes
// on screen from behind a fold (`folded-pages`). A host that does not know `lean` sends whole pages: nothing is read again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createHeldTurnReader, withWholeTurns, type WholePages } from '../../../../apps/desktop/src/components/session-watch/folded-pages'

const turn = (id: string, held: boolean): TranscriptTurn => ({
  id, role: 'assistant', startedAt: 1, outcome: null, itemIds: ['a'],
  items: [{ kind: 'execute-tool-call', id: 'a', seq: 1, toolCallId: 'a', title: 'cat', status: 'done', ...(held ? { held: true } : { outputText: 'whole' }) }],
} as unknown as TranscriptTurn)

function reader(shown: TranscriptTurn[], machine: TranscriptTurn[]) {
  let turns = shown
  const pages: WholePages = {
    snapshot: vi.fn(async (limit: number) => ({ turns: machine.slice(-limit) })),
    older: vi.fn(async (before: string, limit: number) => {
      const at = machine.findIndex((t) => t.id === before)
      return { turns: machine.slice(Math.max(0, at - limit), at) }
    }),
  }
  const failed = vi.fn()
  const fill = createHeldTurnReader({ pages, turns: () => turns, land: (whole) => { turns = withWholeTurns(turns, whole) }, failed })
  return { fill, pages, failed, turns: () => turns }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('folded pages: a held turn is read whole once its row comes out from behind a fold', () => {
  it('reads each held turn shown, together, and puts it in place (the newest from the newest page, others before the next)', async () => {
    const machine = [turn('t1', false), turn('t2', false), turn('t3', false)]
    const r = reader([turn('t1', true), turn('t2', false), turn('t3', true)], machine)
    r.fill('t1:a'); r.fill('t3:a'); r.fill('t1:a')
    await vi.advanceTimersByTimeAsync(30)
    expect(r.pages.older).toHaveBeenCalledTimes(1)
    expect(r.pages.older).toHaveBeenCalledWith('t2', 1)
    expect(r.pages.snapshot).toHaveBeenCalledWith(1)
    expect(r.turns().map((t) => (t.items[0] as { outputText?: string }).outputText)).toEqual(['whole', 'whole', 'whole'])
    r.fill('t1:a')
    await vi.advanceTimersByTimeAsync(30)
    expect(r.pages.older).toHaveBeenCalledTimes(1)
  })

  it('a whole page (a host that does not know `lean`) holds nothing back: no row reads again', async () => {
    const shown = [turn('t1', false), turn('t2', false)]
    const r = reader(shown, shown)
    r.fill('t1:a'); r.fill('t2:a')
    await vi.advanceTimersByTimeAsync(30)
    expect(r.pages.older).not.toHaveBeenCalled()
    expect(r.pages.snapshot).not.toHaveBeenCalled()
  })

  it('a failed read is reported and can be asked for again', async () => {
    const r = reader([turn('t1', true)], [turn('t1', false)])
    vi.mocked(r.pages.snapshot).mockRejectedValueOnce(new Error('link down'))
    r.fill('t1:a')
    await vi.advanceTimersByTimeAsync(30)
    expect(r.failed).toHaveBeenCalledWith(new Error('link down'))
    r.fill('t1:a')
    await vi.advanceTimersByTimeAsync(30)
    expect((r.turns()[0]!.items[0] as { outputText?: string }).outputText).toBe('whole')
  })
})
