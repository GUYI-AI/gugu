/** Configuration controls keep the active editor and its native IME session. */
export const preserveComposerFocus = (event: { preventDefault(): void }) => event.preventDefault()

/** Blank panel surfaces and headings must not commit the editor's native composition. */
export function preservePanelComposerFocus(event: { target: EventTarget | null; preventDefault(): void }) {
  if (!(event.target instanceof Element) || !event.target.closest('input, textarea, select, [contenteditable="true"]')) {
    event.preventDefault()
  }
}

