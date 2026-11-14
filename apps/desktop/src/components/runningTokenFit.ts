/**
 * Render the widest possible prefix first, then remove one token at a time until
 * that prefix and its actual overflow label fit. Proportional digits make +N
 * widths non-monotonic: adding a token can turn a narrow +11 into a wider +10.
 * Never grow again during this pass. Every failed measurement removes a token,
 * so the pass takes at most maximum measurements and keeps the largest valid
 * prefix it examined. The existing one-token minimum also applies while hidden.
 */
export function settleRunningTokenFit(maximum: number, showAndMeasure: (visible: number) => number): number {
  for (let visible = maximum; visible > 0; visible -= 1) {
    const fitting = showAndMeasure(visible)
    if (fitting >= visible || visible <= 1) return visible
  }
  return 0
}
