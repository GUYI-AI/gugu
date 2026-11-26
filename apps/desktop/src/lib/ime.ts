type ImeKeyEvent = { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }

/**
 * Whether this keydown belongs to the input method (an Enter or Escape that picks or cancels a candidate),
 * not to the field. On macOS the commit Enter arrives with key 'Enter' and isComposing; Safari reports
 * keyCode 229 for it after compositionend. Accepts both React and DOM keyboard events.
 */
export function isImeComposing(event: ImeKeyEvent): boolean {
  return Boolean(event.nativeEvent?.isComposing ?? event.isComposing) || event.keyCode === 229
}
