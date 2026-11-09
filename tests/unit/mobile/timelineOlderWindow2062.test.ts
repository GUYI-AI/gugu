import { describe, expect, it } from 'vitest'
import type { TimelineSnapshot, WindowCursor } from '@gugu/session-core/session-record/contract'
import { olderTimelineTarget } from '@/mobile/agent-watch/timeline-older-window'
import { applySnapshot, emptyAgentWatchTimeline, prependOlder } from '@/mobile/agent-watch/agent-watch-store'

const cursor: WindowCursor = { version: 1, scope: 's', sourceLineage: 'lineage', snapshotRevision: 'r', before: 5e9, segment: null }
const snapshot = (extra: Partial<TimelineSnapshot> = {}): TimelineSnapshot => ({
  cursor: { epoch: 'e', seq: 2 }, turns: [], settlements: [], hasOlder: true, ...extra,
})

describe('timeline older window cursor', () => {
  it('pages an unknown-role record with no synthetic turn or truncated integer offset', () => {
    const state = applySnapshot(emptyAgentWatchTimeline(), snapshot({ olderCursor: cursor }))
    expect(state.turns).toEqual([])
    expect(olderTimelineTarget(state)).toEqual({ cursor })
    expect(olderTimelineTarget(state)).not.toHaveProperty('beforeTurnId')
  })

  it('keeps legacy turn paging when the host supplies no window cursor', () => {
    const turns = [{ id: 'real-turn' }] as TimelineSnapshot['turns']
    expect(olderTimelineTarget({ turns, hasOlder: true })).toEqual({ beforeTurnId: 'real-turn' })
    expect(olderTimelineTarget({ turns: [], hasOlder: true })).toBeNull()
    expect(olderTimelineTarget({ turns, hasOlder: false })).toBeNull()
  })

  it('advances an empty bounded page and respects an explicit end without inventing messages', () => {
    const state = applySnapshot(emptyAgentWatchTimeline(), snapshot({ olderCursor: cursor }))
    const next = { ...cursor, before: 4e9 }
    const page = prependOlder(state, { epoch: 'e', turns: [], hasOlder: true, olderCursor: next })
    expect(olderTimelineTarget(page)).toEqual({ cursor: next })
    const end = prependOlder(page, { epoch: 'e', turns: [], hasOlder: false, olderCursor: null })
    expect(olderTimelineTarget(end)).toBeNull()
  })

  it('does not accept an older page from another source epoch', () => {
    const state = applySnapshot(emptyAgentWatchTimeline(), snapshot({ olderCursor: cursor }))
    const next = prependOlder(state, { epoch: 'other', turns: [], hasOlder: false, olderCursor: null })
    expect(next.olderCursor).toEqual(cursor)
    expect(next.needsSnapshot).toBe('epoch_changed')
  })
})
