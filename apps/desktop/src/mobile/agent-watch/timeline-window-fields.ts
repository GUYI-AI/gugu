import type { TimelineWindowFields } from '@gugu/session-core/session-record/contract'

type Bucket = Pick<TimelineWindowFields, 'pendingLongRecords' | 'sourceFragments'>
// Keep only the host's bounded first-screen text; ownership is resolved independently.
const fragmentMetadata = (values: TimelineWindowFields['sourceFragments']) => values
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
  turns: readonly { id: string; items: readonly DisplayItem[] }[] = [],
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
  const allOwners = union(base.resolvedFragmentOwners ?? [], incoming.resolvedFragmentOwners ?? [], value => value.fragmentKey)
  const arrived = (owner: { turnId: string; itemId: string }) => turns.some(turn => turn.id === owner.turnId && contains(turn.items, owner.itemId))
  const windowResolved = (base.sourceFragments ?? []).filter(fragment => {
    const owner = allOwners.find(value => value.fragmentKey === fragment.key)
    return owner && !arrived(owner)
  })
  const fragments = union(windowResolved, union(pages.sourceFragments ?? [], tail.sourceFragments ?? [], value => value.key), value => value.key)
  const owners = allOwners.filter(value => arrived(value) || fragments.some(fragment => fragment.key === value.fragmentKey))
  const bodyKey = (ref: NonNullable<TimelineWindowFields['bodyRefs']>[number]) => JSON.stringify(ref.owner.kind === 'canonical' ? ['canonical', ref.owner.turnId, ref.owner.itemId, ref.id] : ['fragment', ref.owner.fragmentKey, ref.id])
  const bodyRefs = (mode === 'older'
    ? union(incoming.bodyRefs ?? [], base.bodyRefs ?? [], bodyKey)
    : union(base.bodyRefs ?? [], incoming.bodyRefs ?? [], bodyKey)).filter(ref => {
    const owner = ref.owner
    if (owner.kind === 'canonical') return arrived(owner)
    const fragment = fragments.find(value => value.key === owner.fragmentKey)
    return !!fragment && (!fragment.bodyRef || (fragment.bodyRef.id === ref.id && fragment.bodyRef.revision === ref.revision))
  })
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

/** Located fragments with bounded text are readable before canonical ownership resolves. */
export function hasPendingWindow(state: TimelineWindowState & { turns: readonly { id: string; items: readonly DisplayItem[] }[] }): boolean {
  return !!state.pendingLongRecords?.length || !!state.sourceFragments?.some(fragment => {
    if (fragment.text) return false
    const owner = state.resolvedFragmentOwners?.find(value => value.fragmentKey === fragment.key)
    return !owner || !state.turns.some(turn => turn.id === owner.turnId && contains(turn.items, owner.itemId))
  })
}
