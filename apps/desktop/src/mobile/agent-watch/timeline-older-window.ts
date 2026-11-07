import type { TimelineSnapshot, WindowCursor } from '@gugu/session-core/session-record/contract'

/** A locating ticket has no turn ID; its opaque window cursor is sufficient. */
export function olderTimelineTarget(
  state: Pick<TimelineSnapshot, 'hasOlder' | 'olderCursor'> & { turns: readonly { id: string }[] },
): { cursor: WindowCursor; beforeTurnId?: never } | { beforeTurnId: string; cursor?: never } | null {
  if (state.olderCursor) return { cursor: state.olderCursor }
  const oldest = state.turns[0]
  return state.hasOlder && oldest ? { beforeTurnId: oldest.id } : null
}
