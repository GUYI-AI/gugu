import { useRef } from 'react'
import { creditDecimal, creditUnits } from '@gugu/core/billing/creditAmount'
import type { CreditDecimal } from '@gugu/core/billing/creditAmount'

export function parseTeamCap(value: string, unlimited: boolean): CreditDecimal | null {
  if (unlimited) return null
  const cap = creditDecimal(value.trim())
  if (creditUnits(cap) < 0n) throw new RangeError('Negative monthly cap')
  return cap
}

/** Repeating the same command after a lost response keeps its key. An edited command gets a new key. */
export function useTeamCommandKey() {
  const last = useRef<{ signature: string; key: string } | null>(null)
  return (input: unknown) => {
    const signature = JSON.stringify(input)
    if (last.current?.signature !== signature) last.current = { signature, key: crypto.randomUUID() }
    return last.current.key
  }
}
