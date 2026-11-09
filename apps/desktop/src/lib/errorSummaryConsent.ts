import { useSyncExternalStore } from 'react'
import { ERROR_SUMMARY_CONSENT_CHANNELS as channels, type ErrorSummaryConsentSnapshot } from '../../shared/error-summary-consent'

/** 「帮助改进咕咕」开关在界面这边的镜像。真值在主进程;换账号、别的窗口改了,主进程都会发 changed。 */
const unavailable: ErrorSummaryConsentSnapshot = { eligible: false, context: null, decision: 'unknown' }
let current = unavailable
let generation = 0
let installed = false
const listeners = new Set<() => void>()
const publish = (next: ErrorSummaryConsentSnapshot) => { current = next; for (const listener of listeners) listener() }

async function refresh(): Promise<void> {
  const token = ++generation
  try {
    const next = await window.electronAPI?.invoke(channels.read) as ErrorSummaryConsentSnapshot | undefined
    if (token === generation) publish(next ?? unavailable)
  } catch { if (token === generation) publish(unavailable) }
}

export function installErrorSummaryConsent(): void {
  if (!window.electronAPI || installed) return
  installed = true
  window.electronAPI.eventOn(channels.changed, () => { void refresh() })
  void refresh()
}

/** 开 / 关。账号已经换了就不写(主进程也会拒),由调用方提示没存上。 */
export async function setErrorSummaryAllowed(allowed: boolean): Promise<void> {
  const context = current.context
  if (!current.eligible || context === null) throw new Error('Error summary consent is unavailable')
  const token = ++generation
  const next = await window.electronAPI?.invoke(channels.write, allowed ? 'allowed' : 'denied', context) as ErrorSummaryConsentSnapshot
  if (token === generation) publish(next)
}

export function useErrorSummaryConsent(): ErrorSummaryConsentSnapshot {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => current, () => unavailable)
}

