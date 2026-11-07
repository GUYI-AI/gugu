import type { TimelineWindowFields } from '@gugu/session-core/session-record/contract'

type Bucket = Pick<TimelineWindowFields, 'pendingLongRecords' | 'sourceFragments'>
const fragmentMetadata = (values: TimelineWindowFields['sourceFragments']) => values?.map(({ text: _text, ...value }) => value)
export type TimelineWindowState = TimelineWindowFields & { windowTail?: Bucket; windowPages?: Bucket }
const bucket = (value: TimelineWindowFields): Bucket => ({
  pendingLongRecords: value.pendingLongRecords ?? [], sourceFragments: fragmentMetadata(value.sourceFragments) ?? [],
})
function union<T>(older: readonly T[], newer: readonly T[], key: (value: T) => string): T[] {
  return [...new Map([...older, ...newer].map(value => [key(value), value])).values()]
}

/** Tail replacement is independent from resident pages; resolutions remove tickets across both. */
export function mergeTimelineWindowFields(
  current: TimelineWindowState, incoming: TimelineWindowFields, mode: 'snapshot' | 'batch' | 'older',
): TimelineWindowState {
  const base = mode === 'snapshot' ? {} : current
  const tail = mode === 'snapshot' ? bucket(incoming) : mode === 'batch' ? {
    pendingLongRecords: incoming.pendingLongRecords ?? base.windowTail?.pendingLongRecords ?? [],
    sourceFragments: fragmentMetadata(incoming.sourceFragments) ?? base.windowTail?.sourceFragments ?? [],
  } : bucket(base.windowTail ?? {})
  const pages = mode === 'snapshot' ? bucket({}) : mode === 'older' ? {
    pendingLongRecords: union(incoming.pendingLongRecords ?? [], base.windowPages?.pendingLongRecords ?? [], value => value.ticket),
    sourceFragments: union(fragmentMetadata(incoming.sourceFragments) ?? [], base.windowPages?.sourceFragments ?? [], value => value.key),
  } : bucket(base.windowPages ?? {})
  const resolved = new Set(incoming.resolvedPendingTickets ?? [])
  tail.pendingLongRecords = tail.pendingLongRecords?.filter(value => !resolved.has(value.ticket))
  pages.pendingLongRecords = pages.pendingLongRecords?.filter(value => !resolved.has(value.ticket))
  const fragments = union(pages.sourceFragments ?? [], tail.sourceFragments ?? [], value => value.key)
  const owners = union(base.resolvedFragmentOwners ?? [], incoming.resolvedFragmentOwners ?? [], value => value.fragmentKey)
    .filter(value => fragments.some(fragment => fragment.key === value.fragmentKey))
  const bodyKey = (ref: NonNullable<TimelineWindowFields['bodyRefs']>[number]) => JSON.stringify(ref.owner.kind === 'canonical' ? ['canonical', ref.owner.turnId, ref.owner.itemId, ref.id] : ['fragment', ref.owner.fragmentKey, ref.id])
  const bodyRefs = mode === 'older'
    ? union(incoming.bodyRefs ?? [], base.bodyRefs ?? [], bodyKey)
    : union(base.bodyRefs ?? [], incoming.bodyRefs ?? [], bodyKey)
  return {
    windowTail: tail, windowPages: pages, bodyRefs, sourceFragments: fragments, resolvedFragmentOwners: owners,
    pendingLongRecords: union(pages.pendingLongRecords ?? [], tail.pendingLongRecords ?? [], value => value.ticket),
    olderCursor: mode === 'snapshot' ? incoming.olderCursor ?? null : incoming.olderCursor === undefined ? base.olderCursor : incoming.olderCursor,
    moreBefore: incoming.moreBefore ?? base.moreBefore,
    coveredRanges: incoming.coveredRanges ?? base.coveredRanges,
    sourceLineage: mode === 'older' ? base.sourceLineage : incoming.sourceLineage ?? base.sourceLineage,
    snapshotRevision: mode === 'older' ? base.snapshotRevision : incoming.snapshotRevision ?? base.snapshotRevision,
  }
}

type DisplayItem = { id: string; children?: readonly DisplayItem[] }
const contains = (items: readonly DisplayItem[], id: string): boolean => items.some(item => item.id === id || contains(item.children ?? [], id))

/** Source fragments stay loading until their genuine canonical item has arrived. */
export function hasPendingWindow(state: TimelineWindowState & { turns: readonly { id: string; items: readonly DisplayItem[] }[] }): boolean {
  return !!state.pendingLongRecords?.length || !!state.sourceFragments?.some(fragment => {
    const owner = state.resolvedFragmentOwners?.find(value => value.fragmentKey === fragment.key)
    return !owner || !state.turns.some(turn => turn.id === owner.turnId && contains(turn.items, owner.itemId))
  })
}
