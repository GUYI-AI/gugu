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
    const turns = [{ id: 'turn', items: [{ id: 'item' }] }]
    const current = merge({}, { bodyRefs: [ref('new')] }, 'snapshot', turns)
    expect(merge(current, { bodyRefs: [ref('old')] }, 'older', turns).bodyRefs).toEqual([ref('new')])
    expect(merge(current, { bodyRefs: [ref('next')] }, 'batch', turns).bodyRefs).toEqual([ref('next')])
  })

  it('does not merge references belonging to different canonical items by body ID alone', () => {
    const other = { ...ref('other'), owner: { kind: 'canonical' as const, turnId: 't2', itemId: 'i2' }, turnId: 't2', itemId: 'i2' }
    const state = merge({}, { bodyRefs: [ref('first'), other] }, 'snapshot',
      [{ id: 'turn', items: [{ id: 'item' }] }, { id: 't2', items: [{ id: 'i2' }] }])
    expect(state.bodyRefs).toHaveLength(2)
  })
  it('keeps a fragment without readable text loading until the canonical item arrives', () => {
    const source = merge({}, { sourceFragments: [{ ...fragment, text: undefined }] }, 'snapshot')
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
    expect(next.sourceFragments?.[0]).toMatchObject({ key: fragment.key, ownership: 'unresolved' })
    expect(next.sourceFragments?.[0]?.text).toBe(fragment.text)
    expect(hasPendingWindow({ ...next, turns: [] })).toBe(false)
  })
})

it('preserves the owner event when the same batch clears fragments and supplies the real item', () => {
  const before = merge({}, { sourceFragments: [fragment] }, 'snapshot')
  const owner = { fragmentKey: fragment.key, turnId: 'turn', itemId: 'item' }
  const after = merge(before, { sourceFragments: [], resolvedFragmentOwners: [owner] }, 'batch',
    [{ id: 'turn', items: [{ id: 'item' }] }])
  expect(after.sourceFragments).toEqual([])
  expect(after.resolvedFragmentOwners).toEqual([owner])
})

it('retains out-of-order owner fragments until real content arrives, then releases their text', () => {
  const before = merge({}, { sourceFragments: [fragment] }, 'snapshot')
  const owner = { fragmentKey: fragment.key, turnId: 'turn', itemId: 'item' }
  const waiting = merge(before, { sourceFragments: [], resolvedFragmentOwners: [owner] }, 'batch')
  expect(waiting.sourceFragments?.[0]?.text).toBe(fragment.text)
  const arrived = merge(waiting, {}, 'batch', [{ id: 'turn', items: [{ id: 'item' }] }])
  expect(arrived.sourceFragments).toEqual([])
  expect(arrived.resolvedFragmentOwners).toEqual([owner])
  expect(merge(arrived, {}, 'batch').resolvedFragmentOwners).toEqual([])
})

it.each([false, true])('releases old refs across 200 tail replacements (resident page=%s)', withPage => {
  const body = (key: string): NonNullable<TimelineWindowFields['bodyRefs']>[number] => {
    const { turnId: _turn, itemId: _item, ...value } = ref('r')
    return { ...value, id: key, owner: { kind: 'fragment', fragmentKey: key } }
  }
  const page = { ...fragment, key: 'page', bodyRef: body('page') }
  let state = merge({}, withPage ? { sourceFragments: [page], bodyRefs: [page.bodyRef] } : {}, 'older')
  for (let index = 0; index < 200; index++) {
    const value = { ...fragment, key: `tail-${index}`, bodyRef: body(`tail-${index}`) }
    state = merge(state, { sourceFragments: [value], bodyRefs: [value.bodyRef] }, 'batch')
    expect(state.bodyRefs).toHaveLength(withPage ? 2 : 1)
  }
  const expected = withPage ? ['page', 'tail-199'] : ['tail-199']
  expect(state.sourceFragments?.map(value => value.key)).toEqual(expected)
  expect(state.bodyRefs?.map(value => value.id)).toEqual(expected)
})

it('releases canonical refs when their actual resident owner leaves the window', () => {
  const state = merge({}, { bodyRefs: [ref('r')] }, 'snapshot', [{ id: 'turn', items: [{ id: 'item' }] }])
  expect(state.bodyRefs).toHaveLength(1)
  expect(merge(state, {}, 'batch', []).bodyRefs).toEqual([])
})
