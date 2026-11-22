import { useEffect, useRef, useState } from 'react'
import { replica, useReplica, type Reading } from '../../lib/replica'
import type { CreditUsageDay, UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { fetchCreditDays, fetchUsageDays, fetchUsageDevices, type UsageDevice } from '../../lib/usage/cloud'
import { useSpendingPower } from '../../lib/billing/useSpendingPower'
import { HEATMAP_DAYS, addDays, localDay } from '../../lib/usage/derive'
import { canSyncLocalUsage, syncLocalUsage } from '../../lib/usage/sync'

/**
 * 两页各取各的:「活跃」取会话/token 汇总与设备清单,「用量」取积分。
 * 一条挂了只让它那几段说「取不到」,❌ 不把整页吞掉,更❌ 不把失败画成 0 ——
 * 一次网络抖动长得像「你这一年什么都没干」,那是编造出来的事实(同 #2503)。
 */
export type Loadable<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; value: T }

export type UsageData = {
  today: string
  usage: Loadable<UsageDay[]>
  /** 一年档的对照段(再往前一年),只在选中一年档时才取。 */
  previousYear: Loadable<{ usage: UsageDay[] }> | null
  /** null = not read yet (the filter draws a placeholder). */
  devices: UsageDevice[] | null
  /** 本机正在把最新数据送上云端;送完会自动再取一次。 */
  syncing: boolean
  syncError: string | null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 近一年(热力图要满一年)的起点。 */
function yearFrom(today: string): string {
  return addDays(today, -(HEATMAP_DAYS - 1))
}

// usageDays and creditDays are not kept across restarts: a year of an active account's days is tens of KB, past any
// entry limit, and the key moves with today (@@@client-state-model, persistence).
const usageDays = replica({
  name: 'usageDays',
  scope: 'account',
  read: (_userId, from: string, to: string, deviceId: string | null) => fetchUsageDays(from, to, deviceId),
})

export const usageDevices = replica({
  name: 'usageDevices',
  scope: 'account',
  read: () => fetchUsageDevices(),
  // Every device that ever had usage, removed ones too: ~50 B each, so 2 KB holds ~38.
  persist: { maxBytes: 2048, maxEntries: 1 },
})

const creditDays = replica({
  name: 'creditDays',
  scope: 'account',
  // Totals are in the account's credit unit: another unit version is another reading (unknown until read), ❌ the old total.
  read: (_userId, from: string, to: string, timeZone: string, _creditVersion: string | null) => fetchCreditDays(from, to, timeZone),
  // Back to the foreground: a membership bought on the web meanwhile moves no broadcast here (#5899).
  refreshOnFocus: true,
})

/** A reading as this page's three states: unknown is still loading (a placeholder block), ❌ an empty year. */
function loadable<T>(reading: Reading<T>): Loadable<T> {
  if (reading.state === 'value') return { status: 'ready', value: reading.value }
  if (reading.state === 'error') return { status: 'error', error: message(reading.error) }
  return { status: 'loading' }
}

/** 「活跃」页:会话/token 汇总(跨设备)与设备清单。上一次的读数先画,同步与重读在后台。 */
export function useUsageData({ userId, deviceId, wantPreviousYear }: { userId: string | null; deviceId: string | null; wantPreviousYear: boolean }): UsageData {
  const [today] = useState(() => localDay(new Date()))
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const from = yearFrom(today)
  const prevTo = addDays(today, -365)
  const prevFrom = addDays(prevTo, -364)
  const usage = useReplica(usageDays, userId ? [from, today, deviceId] : null)
  const previous = useReplica(usageDays, userId && wantPreviousYear ? [prevFrom, prevTo, deviceId] : null)
  const devices = useReplica(usageDevices, userId ? [] : null)

  // 打开页面就先把这台机器的最新数据送上去,送完再读一遍 —— 否则刚跑完的会话要等半小时才出现。
  useEffect(() => {
    if (!userId || !canSyncLocalUsage()) return
    let alive = true
    setSyncing(true)
    syncLocalUsage({ force: true })
      .then(() => { if (alive) setSyncError(null); void usageDays.refresh() })
      .catch((e: unknown) => { if (alive) setSyncError(message(e)) })
      .finally(() => { if (alive) setSyncing(false) })
    return () => { alive = false }
  }, [userId])

  const previousYear = previous.state === 'value' ? { status: 'ready' as const, value: { usage: previous.value } } : loadable(previous) as Loadable<{ usage: UsageDay[] }>
  return {
    today,
    usage: loadable(usage),
    previousYear: wantPreviousYear ? previousYear : null,
    // 设备筛选只是锦上添花:取不到就只剩「所有设备」,不单独报错。
    devices: devices.state === 'value' ? devices.value : devices.state === 'error' ? [] : null,
    syncing,
    syncError,
  }
}

/** Account credit consumption is independent of the activity device filter; a billing change reads it again in place. */
export function useCreditData(userId: string | null): { today: string; credits: Loadable<CreditUsageDay[]> } {
  const [today] = useState(() => localDay(new Date()))
  const { creditVersion, activityRevision } = useSpendingPower(userId ? { id: userId } : null)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const from = yearFrom(today)
  const credits = useReplica(creditDays, userId ? [from, today, timeZone, creditVersion] : null)
  // A new charge (activity) reads the same totals again in place.
  const seen = useRef<number | null>(null)
  useEffect(() => {
    if (seen.current !== null && seen.current !== activityRevision) void creditDays.refresh()
    seen.current = activityRevision
  }, [activityRevision])
  return { today, credits: loadable(credits) }
}
