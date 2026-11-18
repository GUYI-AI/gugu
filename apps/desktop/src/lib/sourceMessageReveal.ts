export const SOURCE_MESSAGE_FLASH_MS = 1400

// A search result opened: its words are marked inside that message's next flash and fade with it (tokens.css
// msg-src-flash). One pending ask at a time, taken by the flash; nothing stays once the flash is over.
let flashWords: { messageId: string; words: string } | null = null
export function askFlashWords(messageId: string, words: string): void {
  flashWords = words ? { messageId, words } : null
}
export function takeFlashWords(messageId: string): string | null {
  if (flashWords?.messageId !== messageId) return null
  const { words } = flashWords
  flashWords = null
  return words
}

/** Shared by chat and session references: reveal the exact anchor, then flash it. */
export async function revealSourceMessage(messageId: string, input: {
  showLoaded: (id: string) => boolean
  load: (id: string) => Promise<void>
  flash: (id: string) => void
  missing: () => void
  current: () => boolean
}): Promise<void> {
  try {
    if (!input.showLoaded(messageId)) await input.load(messageId)
    if (input.current()) input.flash(messageId)
  } catch (error) {
    // Left before it was shown (another conversation opened): nothing went missing.
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (input.current()) input.missing()
  }
}
