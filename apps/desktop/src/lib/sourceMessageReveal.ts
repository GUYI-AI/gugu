export const SOURCE_MESSAGE_FLASH_MS = 1400

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
