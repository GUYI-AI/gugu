import { describe, expect, it } from 'vitest'
import { membershipProjection, toTier } from '../../../../apps/desktop/src/lib/billing/membership'
import type { MembershipV2 } from '../../../../apps/desktop/src/lib/billing/v2/readers'
import { creditDecimal } from '@gugu/core/billing/creditAmount'

const row: MembershipV2 = {
  planId: 'server-plan', tierKey: 'future-paid', monthlyPriceCny: creditDecimal('200'),
  periodCredits: creditDecimal('100'), periodHours: 720, expiresAt: '2026-12-20T00:00:00Z',
  balanceCredits: creditDecimal('15'), topupCreditsPerCny: creditDecimal('10'),
}

describe('forward-compatible membership tiers (#3509)', () => {
  it.each(['future-paid', '', 'FREE'])('returns explicit unreadable data for tier %j without throwing or inventing Free', tierKey => {
    expect(membershipProjection({ ...row, tierKey })).toEqual({ state: 'unreadable', reason: 'unrecognized-tier' })
  })
  it.each([null, undefined, 1, {}, []])('does not throw for a malformed tier %j', value => {
    expect(toTier(value)).toBeNull()
  })
  it.each(['free', 'plus', 'pro', 'max'] as const)('preserves the server fields for recognized tier %s', tierKey => {
    expect(membershipProjection({ ...row, tierKey })).toEqual({ state: 'value', value: {
      planId: row.planId, tier: tierKey, monthlyPriceCny: row.monthlyPriceCny,
      periodCredits: row.periodCredits, periodHours: row.periodHours, expiresAt: new Date(row.expiresAt!),
      balanceCredits: row.balanceCredits, topupCreditsPerCny: row.topupCreditsPerCny,
    } })
  })
})
