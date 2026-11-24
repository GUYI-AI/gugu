import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { LeanPage, TimelineOlderResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import { turnHeld } from '@gugu/session-core/session-record/held-turn'

/**
 * @@@folded-pages-reader — the one place a reader of another machine's timeline asks for pages in their folded form
 * (transport-trim `@@@folded-form`: what the conversation view keeps behind a fold is left out and the item marked
 * `held`) and reads a held turn back whole when a row of it comes on screen from behind a fold (`onHeldShown`).
 * Pages are a snapshot, an older page, and the snapshot a reset answer to a subscribe / after carries (the stream
 * passes its `lean` on all of them); the batches pushed as the conversation moves go whole.
 * Both conversation views of a remote timeline read through it: the session stream the phone, the peek view and the
 * desktop session page share (`useTimelineSession` with `folded`, `RemoteTimelineFeed`). Readers that draw no folds
 * (reply progress, question cards) ask for whole pages. A host that does not know `lean` sends whole pages, which hold
 * nothing back, so nothing is read again.
 */
export const FOLDED: LeanPage = 'folded'

/** How a reader asks its machine for a page, whole (never folded): the newest turns, or the turns before one. */
export type WholePages = {
  snapshot(limit: number): Promise<Pick<TimelineSnapshot, 'turns'>>
  older(beforeTurnId: string, limit: number): Promise<Pick<TimelineOlderResult, 'turns'>>
}

/** Rows of a turn carry the turn's id before their own (`<turn>:<item>`). */
const heldTurnOf = (turns: readonly TranscriptTurn[], itemId: string) =>
  turns.find((turn) => itemId.startsWith(`${turn.id}:`) && turnHeld(turn))

/** One turn whole: the turn before the one after it, or the newest page's last turn. Null when it is no longer there. */
async function wholeTurn(pages: WholePages, turns: readonly TranscriptTurn[], id: string): Promise<TranscriptTurn | null> {
  const at = turns.findIndex((turn) => turn.id === id)
  const next = turns[at + 1]
  const page = next ? await pages.older(next.id, 1) : await pages.snapshot(1)
  const turn = page.turns.at(-1)
  return turn?.id === id ? turn : null
}

/** The turns with each held one replaced by its whole read; one revised meanwhile (no longer held) stays as it is. */
export function withWholeTurns(turns: readonly TranscriptTurn[], whole: ReadonlyMap<string, TranscriptTurn>): TranscriptTurn[] {
  return turns.map((turn) => (turnHeld(turn) ? whole.get(turn.id) ?? turn : turn))
}

/**
 * Reads held turns back as their rows come on screen. Opening a fold brings many rows at once: their turns are read
 * together and land as one change. A failed read is reported (`failed`) and may be asked for again.
 */
export function createHeldTurnReader(input: {
  pages: WholePages
  turns: () => readonly TranscriptTurn[]
  land: (whole: ReadonlyMap<string, TranscriptTurn>) => void
  failed: (error: unknown) => void
}): (itemId: string) => void {
  const reading = new Set<string>()
  let wanted = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const read = async () => {
    timer = null
    const ids = [...wanted]
    wanted = new Set()
    for (const id of ids) reading.add(id)
    try {
      const turns = input.turns()
      const read = await Promise.all(ids.map((id) => wholeTurn(input.pages, turns, id)))
      const whole = new Map(read.flatMap((turn) => (turn ? [[turn.id, turn] as const] : [])))
      if (whole.size) input.land(whole)
    } catch (error) {
      input.failed(error)
    } finally {
      for (const id of ids) reading.delete(id)
    }
  }
  return (itemId) => {
    const turn = heldTurnOf(input.turns(), itemId)
    if (!turn || reading.has(turn.id)) return
    wanted.add(turn.id)
    timer ??= setTimeout(() => void read(), 30)
  }
}
