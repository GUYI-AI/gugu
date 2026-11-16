import type { SelectionSendCite, SelectionSendResult } from '@/session/shared/extensions/selection-send'

export interface SelectionSendOptions {
  /** The selection's cite: `draft` is sent before the person's words, `quote` and `pills` are what the box shows of it. */
  cite: SelectionSendCite
  sessionId: string
  /** Beside the selection (this window's CSS px), or a bar at the bottom (phone). */
  anchor: DOMRect | 'dock'
  /** The page under the selection: a click or a wheel on it closes Send (it cannot scroll away under the box). */
  cover?: DOMRect
  /** The layer of the window the page is drawn in, when that is not this one (an App in a window of its own). */
  container?: HTMLElement | null
  /** Left alone this long, it closes as cancelled (a caller waiting on a clock of its own). */
  closeAfterMs?: number
}

export type SelectionSendAsked = SelectionSendOptions & { answer: (result: SelectionSendResult) => void }

let take: ((asked: SelectionSendAsked) => void) | null = null

/**
 * A selection's Send, asked of the shell as `pickDispatchTarget` asks its sheet (dispatchAsk): the box (SelectionSendLayer,
 * beside DispatchSheet in ExtensionConsentSheet) shows what goes, takes a few words with the session composer's @, and
 * sends the way typed words are (`sessionSend`). One at a time: a second ask cancels the first.
 */
export function openSelectionSend(options: SelectionSendOptions): Promise<SelectionSendResult> {
  return new Promise((resolve, reject) => {
    if (!take) return reject(new Error('No window here can open Send'))
    take({ ...options, answer: resolve })
  })
}

/** The layer takes the asks while it is drawn; the returned call lets go. */
export function takeSelectionSends(taker: (asked: SelectionSendAsked) => void): () => void {
  take = taker
  return () => {
    if (take === taker) take = null
  }
}
