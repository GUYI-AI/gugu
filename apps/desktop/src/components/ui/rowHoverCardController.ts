import { useCallback, useEffect, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * The product's one way to show a card for the object under the pointer in a list: a group's agent rows, the main
 * sidebar's group / person rows, the running-agent pills above the composer. One timing, one motion, one shape, so
 * pointing at any of them reads the same (owner 2026-11-24: "should all be unified to the group's agent list").
 *
 * Opening and closing:
 *  · **Pointer only.** The pointer rests on a row for ROW_HOVER_CARD_OPEN_DELAY_MS before the card opens, so sweeping
 *    down a list does not flash cards. Touch never opens it (no hover there).
 *  · With a card already open, entering another row of the same list swaps to it **at once** (warm swap).
 *  · **A press is not a hover**: pressing a row closes its card (and a pending open), and that row does not open again
 *    until the pointer has left it (owner 2026-09-24).
 *  · Leaving closes **at once**, no grace timer and no exit animation (owner 2026-10-08: "should vanish immediately").
 *    The card opens flush against its row; the visible gap is the card's own transparent padding, so moving from the
 *    row into the card never crosses a pixel that is neither. Where the pointer goes on leaving (`relatedTarget`) is
 *    therefore all it takes: into the card, back to the row, or onto another row of the list keeps it.
 *  · Outside press and Escape are Base UI's.
 *
 * One card per list at a time: a row does not remember "I am open", it asks its list's controller whether it is the
 * active key, so the old card closing and the new one opening are one assignment, never two cards at once.
 */
export const ROW_HOVER_CARD_OPEN_DELAY_MS = 400

export class RowHoverCardController {
  activeKey: string | null = null
  /**
   * The row just pressed, the pointer not yet gone from it: its hover does not open. Kept here, not on the row's node: opening
   * what was pressed re-renders the list, the row's node may be replaced, and the new node gets a pointerenter on the next move.
   * One slot: entering any other row voids it, so scrolling away or unmounting never leaves a row that cannot open.
   */
  suppressedKey: string | null = null
  private pending: { key: string; timer: ReturnType<typeof setTimeout> } | null = null
  private readonly listeners = new Set<() => void>()

  /**
   * `list` names the list in the DOM: its card carries `data-row-hover-card=<list>`, its rows `data-row-hover-trigger=<list>`
   * (what `useRowHoverCardTrigger` spreads), or match `rows` when the list's rows are drawn by others and cannot carry it.
   */
  constructor(readonly list: string, private readonly rows = `[data-row-hover-trigger="${list}"]`) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readActive = () => this.activeKey

  private set(next: string | null): void {
    if (next === this.activeKey) return
    this.activeKey = next
    for (const listener of this.listeners) listener()
  }

  private cancel(key?: string): void {
    if (!this.pending || (key !== undefined && this.pending.key !== key)) return
    clearTimeout(this.pending.timer)
    this.pending = null
  }

  /** The pointer came onto a row. */
  enter(key: string, pointerType: string): void {
    if (pointerType === 'touch') return
    this.cancel()
    if (this.suppressedKey === key) return
    this.suppressedKey = null
    if (this.activeKey !== null) {
      this.set(key)
      return
    }
    this.pending = { key, timer: setTimeout(() => { this.pending = null; this.set(key) }, ROW_HOVER_CARD_OPEN_DELAY_MS) }
  }

  /** The pointer left a row or its card for `to`. Leaving also ends "just pressed": the next entry is a fresh hover. */
  leave(key: string, to: EventTarget | null): void {
    this.cancel(key)
    if (this.suppressedKey === key) this.suppressedKey = null
    if (!this.keeps(to)) this.close(key)
  }

  /** A press (any mouse button, a pen) on a row: operating it, not looking at it. */
  press(key: string, pointerType: string): void {
    if (pointerType === 'touch') return
    this.cancel()
    this.suppressedKey = key
    this.close(key)
  }

  /** Opens without the hover wait: keyboard focus or a long press where a surface wants that. */
  open(key: string): void {
    this.cancel()
    this.set(key)
  }

  /** Closes only this key's card: by the time row A unmounts or is dismissed, the open card may be row B's. */
  close(key: string): void {
    this.cancel(key)
    if (this.activeKey === key) this.set(null)
  }

  /** Still looking at the card: into the card, back onto a row of this list (that row's enter swaps). Null = left the window. */
  keeps(to: EventTarget | null): boolean {
    return to instanceof Element && to.closest(`[data-row-hover-card="${this.list}"], ${this.rows}`) !== null
  }
}

/** Whether `key`'s card is the open one. */
export function useRowHoverCardOpen(card: RowHoverCardController, key: string): boolean {
  return useSyncExternalStore(card.subscribe, card.readActive) === key
}

/**
 * The row side: spread the result on the row. `enabled` false (a setting turned off) also closes a card that is open,
 * the switch is wired to the row, not just to the next hover.
 */
export function useRowHoverCardTrigger(card: RowHoverCardController, key: string, enabled = true) {
  useEffect(() => {
    if (!enabled) card.close(key)
  }, [card, enabled, key])
  // A row that unmounts (scrolled out of a virtual list, folded away) closes its card: otherwise the key hangs in the
  // shared controller and the card pops up by itself when the row mounts again.
  useEffect(() => () => card.close(key), [card, key])
  const onPointerEnter = useCallback((event: ReactPointerEvent) => { if (enabled) card.enter(key, event.pointerType) }, [card, enabled, key])
  const onPointerLeave = useCallback((event: ReactPointerEvent) => card.leave(key, event.relatedTarget), [card, key])
  const onPointerDown = useCallback((event: ReactPointerEvent) => card.press(key, event.pointerType), [card, key])
  const dismiss = useCallback(() => card.close(key), [card, key])
  return { 'data-row-hover-trigger': card.list, onPointerEnter, onPointerLeave, onPointerDown, dismiss }
}

