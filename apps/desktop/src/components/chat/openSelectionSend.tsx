import { createRoot } from 'react-dom/client'
import type { SelectionSendResult } from '@/session/shared/extensions/selection-send'
import { SelectionSendBox, type SelectionSendOptions } from './SelectionSend'

let open: { cancel(): void } | null = null

/**
 * A selection's Send: its words and pills as they will go, a few words of the person's own with the session composer's @,
 * sent the way typed words are (`sessionSend`). One at a time; Esc, a click outside or on the page beneath cancel, and so
 * does `closeAfterMs` left alone (a caller waiting on a clock of its own).
 */
export function openSelectionSend(options: SelectionSendOptions, closeAfterMs?: number): Promise<SelectionSendResult> {
  open?.cancel()
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const done = (result: SelectionSendResult) => {
      if (open !== mine) return
      open = null
      clearTimeout(timer)
      root.unmount()
      host.remove()
      resolve(result)
    }
    const mine = { cancel: () => done('cancelled') }
    open = mine
    const timer = closeAfterMs === undefined ? undefined : setTimeout(mine.cancel, closeAfterMs)
    root.render(<SelectionSendBox {...options} done={done} />)
  })
}
