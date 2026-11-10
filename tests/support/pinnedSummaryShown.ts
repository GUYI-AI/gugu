/**
 * Whether any point of a pinned user-message summary is on screen. Resting, the summary is hidden over its own
 * message (@@@pin-cover); hidden elements are not hit, so a hit anywhere on the card means it shows.
 */
export function pinnedSummaryShown(summary: HTMLElement): boolean {
  const r = summary.getBoundingClientRect();
  for (let y = r.top + 1; y < r.bottom; y += 2) if (summary.contains(document.elementFromPoint(r.left + r.width / 2, y))) return true;
  return false;
}
