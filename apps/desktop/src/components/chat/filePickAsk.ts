import type { FilePickAsk, FilePicked } from '@/session/shared/extensions/app-file-pick-core'

export type FilePickAsked = FilePickAsk & { answer: (picked: FilePicked) => void }

let take: ((asked: FilePickAsked) => void) | null = null

/**
 * API 62 `gugu.files.pick`, on the desktop (main asks the window) and the phone (its page asks) alike: the person picks
 * files of the chat in the shell's sheet (FilePickSheet) — null when they cancel or let it run out. The rows are the files
 * the host listed; the sheet answers only which of them were picked, or that one is to be added from this device.
 */
export function pickChatFiles(ask: FilePickAsk): Promise<FilePicked> {
  return new Promise((resolve, reject) => {
    if (!take) return reject(new Error('No window here can ask which files to pick'))
    take({ ...ask, answer: resolve })
  })
}

/** The sheet takes the asks while it is drawn; the returned call lets go. */
export function takeFilePickAsks(taker: (asked: FilePickAsked) => void): () => void {
  take = taker
  return () => {
    if (take === taker) take = null
  }
}
