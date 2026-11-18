/** Reserve a full More entry only when the ordered App list cannot fit. */
export function railAppVisibleCount(count: number, availableHeight: number, rowHeight: number, gap: number): number {
  if (count === 0) return 0
  if (![availableHeight, rowHeight, gap].every(Number.isFinite) || rowHeight <= 0 || gap < 0) return 0
  const slots = Math.max(0, Math.floor((availableHeight + gap) / (rowHeight + gap)))
  return count <= slots ? count : Math.max(0, slots - 1)
}
