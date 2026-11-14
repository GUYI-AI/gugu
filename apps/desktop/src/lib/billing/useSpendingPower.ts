// 余额 + 额度窗口的**唯一**读模型(lib/readModel)。
//
// 以前侧栏、积分面板、额度页、低额横幅各写一套 useEffect + 各自的刷新节奏,同一时刻能读出
// 不一样的余额。现在只有这一份:一份数据、一套刷新,读到的必然是同一份。数据跟账号走(换号、登出才清),
// ❌ 跟订阅者走 —— 关掉订阅页再开,上一次的读数立刻在。
// 取不到就说取不到 —— 余额与窗口两条链路各自落地,一条挂了不会把另一条一起吞掉,也绝不
// 用 0 之类的假数字顶上。
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { deriveSpendingPower, quotaSpendWindows, type SpendingPower } from '@gugu/core/billing'
import {
  subscribePrivateUserEventBus,
  unsubscribePrivateUserEventBus,
  type PrivateUserEventBusHandle,
} from '../realtimeChannel'
import { readModel, useReadModel } from '../readModel'
import type { CreditAmount } from '@gugu/core/billing/creditAmount'
import type { QuotaWindows } from './quota'
import { membershipProjection, type Membership } from './membership'
import { readCreditV2Account } from './v2/runtime'

export interface SpendingSnapshot {
  /** unknown = 这个账号在这台设备上还没读到过;界面画占位,❌ 画「—」或 0。 */
  state: 'unknown' | 'value' | 'error'
  membership: Membership | null
  creditVersion: string | null
  /** null = 还没取到或取不到,**不是** 0。 */
  balance: CreditAmount | null
  balanceError: string | null
  /** 非 null 即已通过领域校验(政策自洽),下游可以直接推导,不必再防一手。 */
  windows: QuotaWindows | null
  /** 取不到,或服务端政策自相矛盾(推导出的短窗上限与回包不符)—— 都在这里响,不静默挑一个来信。 */
  windowsError: string | null
  /** 余额与窗口都在时才有。这是「还能花多少」的唯一来源。 */
  power: SpendingPower | null
  /** 计费版本:库的广播、回到前台各推进一次;用量页据此重取会员。 */
  activityRevision: number
}

const UNKNOWN_SNAPSHOT: SpendingSnapshot = {
  state: 'unknown',
  membership: null,
  creditVersion: null,
  balance: null,
  balanceError: null,
  windows: null,
  windowsError: null,
  power: null,
  activityRevision: 0,
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What one read of the account returned, kept as plain data (the snapshot across restarts stores it as is). */
const creditAccount = readModel({
  name: 'creditAccount',
  scope: 'account',
  read: async () => {
    const account = await readCreditV2Account()
    if (account.windows) quotaSpendWindows(account.windows)
    return {
      plan: account.plan,
      balance: account.balance,
      windows: account.windows,
      creditVersion: JSON.stringify(account.meta),
      balanceError: account.balanceError === null ? null : message(account.balanceError),
      windowsError: account.windowsError === null ? null : message(account.windowsError),
    }
  },
  persist: true,
})

// 计费版本:库的广播、回到前台各推进一次;用量页据此重取会员。
let activityRevision = 0
const revisionListeners = new Set<() => void>()
function bumpActivity(): void {
  activityRevision += 1
  revisionListeners.forEach((listener) => listener())
}

function refreshAll(): void {
  if (!officialServicesEnabled()) return
  void creditAccount.refresh()
}

function refreshWhenVisible(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  // 回到前台:人可能刚在网页上开通或续费了会员。那只写会员表(bind_subscription → user_quota_periods)、
  // 不碰 user_credits,库的广播不会响 —— 推进计费版本,让读会员的那一处(用量页)也跟着重取(#5899)。
  bumpActivity()
  refreshAll()
}

// 实时那一路(广播、回到前台)只在有人看着时挂着;数据本身跟账号走,没人看也不清。
let watchers = 0
let watchedUserId: string | null = null
let billingEventHandle: PrivateUserEventBusHandle | null = null

function watch(userId: string): () => void {
  watchers += 1
  if (watchers === 1) {
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
  }
  if (watchedUserId !== userId) {
    if (billingEventHandle) unsubscribePrivateUserEventBus(billingEventHandle)
    watchedUserId = userId
    billingEventHandle = subscribePrivateUserEventBus(userId, 'spending_power_changed', () => {
      bumpActivity()
      refreshAll()
    }, {
      // Reconnects also re-fetch once, closing any event gap while the socket was unavailable.
      onSubscribed: () => refreshAll(),
    })
  }
  return () => {
    watchers -= 1
    if (watchers > 0) return
    window.removeEventListener('focus', refreshWhenVisible)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
    if (billingEventHandle) unsubscribePrivateUserEventBus(billingEventHandle)
    billingEventHandle = null
    watchedUserId = null
  }
}

/** 手动催一次(充值回来、用户点刷新)。 */
export function refreshSpendingPower(): void {
  refreshAll()
}

export function useSpendingPower(user: { id: string } | null): SpendingSnapshot {
  const userId = officialServicesEnabled() ? user?.id ?? null : null
  const reading = useReadModel(creditAccount, userId ? [] : null)
  const revision = useSyncExternalStore(
    (listener) => { revisionListeners.add(listener); return () => { revisionListeners.delete(listener) } },
    () => activityRevision,
  )
  useEffect(() => (userId ? watch(userId) : undefined), [userId])

  return useMemo((): SpendingSnapshot => {
    if (reading.state === 'unknown') return { ...UNKNOWN_SNAPSHOT, activityRevision: revision }
    // 一次读失败就整份不要了、说清为什么:❌ 留着上一次的余额(#2503,没读到的数不冒充现在的数)。
    const failure = reading.state === 'error' ? reading.error : reading.error
    if (failure) {
      return { ...UNKNOWN_SNAPSHOT, state: 'error', balanceError: message(failure), windowsError: message(failure), activityRevision: revision }
    }
    const account = (reading as Extract<typeof reading, { state: 'value' }>).value
    return {
      state: 'value',
      membership: account.plan ? membershipProjection(account.plan) : null,
      creditVersion: account.creditVersion,
      balance: account.balance,
      balanceError: account.balanceError,
      windows: account.windows,
      windowsError: account.windowsError,
      power: account.balance === null || account.windows === null ? null : deriveSpendingPower(account.balance, account.windows),
      activityRevision: revision,
    }
  }, [reading, revision])
}
