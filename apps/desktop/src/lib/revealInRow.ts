/** Scrolls `row` sideways just enough to show `node` (plus `pad`) — only `row` moves. `scrollIntoView` also scrolls every
 *  clipped ancestor, which shoves a whole layout aside (a strip inside a panel mid-slide). */
export function revealInRow(row: HTMLElement, node: HTMLElement, pad = 0) {
  const left = node.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft - pad;
  const right = left + node.offsetWidth + 2 * pad;
  if (left < row.scrollLeft) row.scrollLeft = left;
  else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
}
