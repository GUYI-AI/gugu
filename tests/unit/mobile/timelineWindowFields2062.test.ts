import { describe, expect, it } from 'vitest'
import type { TimelineWindowFields } from '@gugu/session-core/session-record/contract'
import { hasPendingWindow, mergeTimelineWindowFields as merge } from '@/mobile/agent-watch/timeline-window-fields'

const pending = (ticket: string) => ({ kind: 'pending_long_record' as const, ticket,
  sourceInstance: 'source', pinnedEnd: 6e9, nextScanOffset: 5e9,
  sourceFence: { start: 5e9, end: 6e9, digest: 'fence' } })
const ref = (revision: string): NonNullable<TimelineWindowFields['bodyRefs']>[number] => ({
  version: 1, scope: 'session', sourceLineage: 'lineage', id: 'body', revision,
  owner: { kind: 'canonical', turnId: 'turn', itemId: 'item' }, turnId: 'turn', itemId: 'item',
  firstChunk: null, decoderCheckpoint: null, sourceRange: { start: 5e9, end: 6e9 }, byteLength: null,
})
const fragment = { key: 'native-fragment', sourceRange: { start: 5e9, end: 6e9 },
  ownership: 'unresolved' as const, knownRole: 'assistant' as const, text: 'bounded source evidence' }

describe('bounded timeline window metadata', () => {
  it('clears the tail bucket without falsely resolving older-page tickets', () => {
    const tail = merge({}, { pendingLongRecords: [pending('tail')] }, 'snapshot')
    const pages = merge(tail, { pendingLongRecords: [pending('page')] }, 'older')
    const next = merge(pages, { pendingLongRecords: [] }, 'batch')
    expect(next.pendingLongRecords?.map(value => value.ticket)).toEqual(['page'])
    expect(merge(pages, {}, 'batch').pendingLongRecords).toHaveLength(2)
    expect(next).not.toHaveProperty('turns')
    expect(next.pendingLongRecords?.[0]).not.toHaveProperty('role')
  })

  it('applies explicit resolutions across both buckets, never just a tail empty set', () => {
    const tail = merge({}, { pendingLongRecords: [pending('tail')] }, 'snapshot')
    const pages = merge(tail, { pendingLongRecords: [pending('page')] }, 'older')
    expect(merge(pages, { resolvedPendingTickets: ['tail', 'page'] }, 'batch').pendingLongRecords).toEqual([])
  })

  it('replaces a snapshot without leaking old source metadata', () => {
    const old = merge({}, { bodyRefs: [ref('old')], sourceFragments: [fragment], pendingLongRecords: [pending('old')] }, 'snapshot')
    expect(merge(old, {}, 'snapshot')).toMatchObject({ bodyRefs: [], sourceFragments: [], pendingLongRecords: [], olderCursor: null })
  })

  it('keeps a newer canonical revision when an older page arrives', () => {
    const current = merge({}, { bodyRefs: [ref('new')] }, 'snapshot')
    expect(merge(current, { bodyRefs: [ref('old')] }, 'older').bodyRefs).toEqual([ref('new')])
    expect(merge(current, { bodyRefs: [ref('next')] }, 'batch').bodyRefs).toEqual([ref('next')])
  })

  it('keeps unresolved fragments loading until both owner proof and the actual canonical item exist', () => {
    const source = merge({}, { sourceFragments: [fragment] }, 'snapshot')
    expect(hasPendingWindow({ ...source, turns: [] })).toBe(true)
    const mapped = merge(source, { resolvedFragmentOwners: [{ fragmentKey: fragment.key, turnId: 'turn', itemId: 'item' }] }, 'batch')
    expect(hasPendingWindow({ ...mapped, turns: [] })).toBe(true)
    expect(hasPendingWindow({ ...mapped, turns: [{ id: 'turn', items: [{ id: 'group', children: [{ id: 'item' }] }] }] })).toBe(false)
    expect(mapped.sourceFragments?.[0].key).toBe(fragment.key)
    expect(mapped).not.toHaveProperty('turns')
  })

  it('does not clear page-local fragments when the tail window becomes empty', () => {
    const source = merge({}, { sourceFragments: [fragment] }, 'older')
    const next = merge(source, { sourceFragments: [] }, 'batch')
    expect(next.sourceFragments).toEqual([fragment])
    expect(hasPendingWindow({ ...next, turns: [] })).toBe(true)
  })
})
