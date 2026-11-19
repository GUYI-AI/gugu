import { normalizeReferralCode } from '@gugu/core/shared/referralLink'

const key = 'gugu:pending-personal-referral'
let memory: { code: string; userId?: string } | null = null
let storageFailed = false
export const REFERRAL_LINK_EVENT = 'gugu:personal-referral-link'
export const REFERRAL_CHANGED_EVENT = 'gugu:personal-referral-changed'

export function refreshPersonalReferrals(userId: string): void {
  window.dispatchEvent(new CustomEvent(REFERRAL_CHANGED_EVENT, { detail: userId }))
}

export function rememberPersonalReferral(code: string): void {
  const normalized = normalizeReferralCode(code)
  if (!normalized) return
  memory = { code: normalized }
  try { localStorage.setItem(key, JSON.stringify(memory)); storageFailed = false }
  catch (error) { storageFailed = true; throw error }
  finally { window.dispatchEvent(new Event(REFERRAL_LINK_EVENT)) }
}

/** Bind a pre-login hint to the first account that reviews it, never a later login. */
export function pendingPersonalReferral(userId: string): string {
  let value: { code?: string; userId?: string } | null = memory
  if (!storageFailed) {
    try {
      const raw = localStorage.getItem(key)
      value = raw ? JSON.parse(raw) as { code?: string; userId?: string } : null
    } catch { storageFailed = true }
  }
  if (!value) return ''
  if (value.userId && value.userId !== userId) return ''
  const code = normalizeReferralCode(value.code ?? '')
  if (!code) return ''
  if (!value.userId) {
    memory = { code, userId }
    try { localStorage.setItem(key, JSON.stringify(memory)) } catch { storageFailed = true }
  }
  return code
}

export function clearPersonalReferral(userId: string): void {
  if (pendingPersonalReferral(userId)) {
    memory = null
    try { localStorage.removeItem(key); storageFailed = false } catch { storageFailed = true }
  }
}
