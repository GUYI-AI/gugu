/** Opening a page keeps the pane being used current, including when the opener receives keyboard focus. */
export function makesPaneCurrent(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest('[data-pane-opener]'));
}
