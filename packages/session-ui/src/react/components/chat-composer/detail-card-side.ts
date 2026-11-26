/**
 * Where a menu or hint opened from a row of the model details goes: away from the model list (the card sits on one side
 * of it), when the window has `need` px there; otherwise below. Null until both the card and the list are on screen.
 */
export function sideAwayFromPicker(row: Element | null, picker: HTMLElement | null, need: number): 'left' | 'right' | 'bottom' | null {
  const card = row?.closest('[data-hover-card]')?.getBoundingClientRect();
  const panel = picker?.getBoundingClientRect();
  if (!card || !panel || !picker) return null;
  const left = card.left < panel.left;
  const free = left ? card.left : picker.ownerDocument.documentElement.clientWidth - card.right;
  return free >= need ? (left ? 'left' : 'right') : 'bottom';
}
