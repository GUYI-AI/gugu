/** Preserve the server's fractional precision when a deletion and a message share a millisecond. */
export function historyTime(value: string): bigint {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid conversation history timestamp')
  const fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1] ?? ''
  return BigInt(milliseconds) * 1_000_000n + BigInt((fraction.slice(3) + '000000').slice(0, 6))
}

export function historyMessageVisible(at: string, floor?: string | null): boolean {
  return !floor || historyTime(at) >= historyTime(floor)
}
