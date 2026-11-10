/**
 * Whether any point of a pinned user-message summary is on screen. The summary sticks inside a window whose
 * clip-path hides it until its message has left the viewport (@@@pin-window); clip-path clips hit-testing the
 * same way it clips paint, so a hit anywhere on the card means it shows.
 */
export function pinnedSummaryShown(summary: HTMLElement): boolean {
  const r = summary.getBoundingClientRect();
  for (let y = r.top + 1; y < r.bottom; y += 2) if (summary.contains(document.elementFromPoint(r.left + r.width / 2, y))) return true;
  return false;
}
