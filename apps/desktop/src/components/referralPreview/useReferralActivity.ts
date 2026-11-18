import { useState } from 'react'
import { replicaAccount, useReplicas } from '@/lib/replica'
import { personalReferralActivity } from '@/lib/referralReplicas'
import type { ReferralActivityItem } from '@/lib/referrals'

export function useReferralActivity(userId: string | undefined) {
  // Only the visible cursor sequence is view state. Page values and failures belong to the account's replica.
  const [shown, setShown] = useState<{ userId?: string; cursors: (string | null)[] }>({ cursors: [null] })
  const cursors = shown.userId === userId ? shown.cursors : [null]
  const active = !!userId && replicaAccount().id === userId
  const readings = useReplicas(personalReferralActivity, active ? cursors.map((cursor): [string | null] => [cursor]) : [])
  const items: ReferralActivityItem[] = []
  for (const reading of readings) {
    if (reading.state !== 'value') break
    for (const item of reading.value.items) if (!items.some(old => old.key === item.key)) items.push(item)
  }
  const loading = !active || readings.some(reading => reading.state === 'unknown')
  const failed = readings.some(reading => reading.state === 'error' || (reading.state === 'value' && !!reading.error))
  const last = readings.at(-1)
  const next = last?.state === 'value' ? last.value.next_cursor : null
  return {
    items, loading, failed,
    more: !loading && !failed && next !== null,
    reload: () => {
      setShown({ userId, cursors: [null] })
      if (active) void personalReferralActivity.refresh(null)
    },
    loadMore: () => {
      if (!active || loading) return
      if (failed) { void personalReferralActivity.refresh(); return }
      if (next !== null && !cursors.includes(next)) setShown({ userId, cursors: [...cursors, next] })
    },
  }
}
