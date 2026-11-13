import { describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '../acp'
import { clearedHistoryResult, clearedHistoryTurns, historyClearEpoch } from './conversation-history-clear'
import { historyMessageVisible } from '@gugu/core/shared/conversationHistoryTime'
const floor = '2026-11-14T00:00:00.000500Z'
const at = Date.parse('2026-11-14T00:00:00Z')
const turn = (): TranscriptTurn => ({ id: 't', seq: 1, initiator: 'user', startedAt: at - 1000, endedAt: at + 1000,
  items: [{ kind: 'message', id: 'old', role: 'user', seq: 0, text: 'cleared', at: at - 1000 },
    { kind: 'message', id: 'new', role: 'assistant', seq: 1, text: 'new reply', at: at + 1000 }] })
describe('personal native history clear', () => {
  it('retains the later reply of a turn that began before deletion', () => {
    expect(clearedHistoryTurns([turn()], floor)[0].items.map(item => item.id)).toEqual(['new'])
    expect(turn().items).toHaveLength(2)
  })
  it('removes old turns and their deferred body references and unresolved fragments', () => {
    const value = { turns: [{ ...turn(), items: [turn().items[0]] }], hasOlder: true, bodyRefs: [{ itemId: 'old' }], sourceFragments: [{ text: 'old fragment' }], cursor: { epoch: 'source', seq: 1 } }
    const result = clearedHistoryResult(value, floor)
    expect(result.turns).toEqual([]); expect(result.bodyRefs).toEqual([]); expect(result.sourceFragments).toEqual([])
    expect(result.hasOlder).toBe(false)
    expect(result.cursor.epoch).toBe('source' + historyClearEpoch(floor))
  })
  it('applies the same boundary to incremental and reset results', () => {
    expect(clearedHistoryResult({ ok: true, batch: { turns: [turn()], epoch: 'source' } }, floor).batch.turns[0].items.map(item => item.id)).toEqual(['new'])
    expect(clearedHistoryResult({ ok: false, snapshot: { turns: [turn()] } }, floor).snapshot.turns[0].items.map(item => item.id)).toEqual(['new'])
  })
  it('keeps submillisecond server ordering and does not reinterpret hiding as clearing', () => {
    expect(historyMessageVisible('2026-11-14T00:00:00.000499Z', floor)).toBe(false)
    expect(historyMessageVisible('2026-11-14T00:00:00.000501Z', floor)).toBe(true)
    const turns = [turn()]; expect(clearedHistoryTurns(turns, null)).toBe(turns)
  })
  it('keeps stored-page origins and revisions aligned and cannot page behind the boundary', () => {
    const old = { ...turn(), id: 'old-turn', items: [turn().items[0]] }
    const page = { turns: [old, turn()], originTurnIds: ['old-origin', 'new-origin'], turnRevisions: [1, 3], nextCursor: 1, epoch: 'stored' }
    const value = clearedHistoryResult(page, floor)
    expect(value.originTurnIds).toEqual(['new-origin'])
    expect(value.turnRevisions).toEqual([3])
    expect(value.nextCursor).toBeNull()
    expect(clearedHistoryResult(value, floor).epoch).toBe(value.epoch)
  })
})
