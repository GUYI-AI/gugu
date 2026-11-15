/**
 * 「帮助改进咕咕」:错误摘要默认发送,人可以随时关(owner 11-09:首登第一页「继续」下面一行勾选 + 设置 → 通用)。
 * 按安装 × 账号记;只记「关了」这一件事,没记过的账号就是开着。
 * 读不出记录时不当成开着:那份记录里可能正好有人关过,这一轮不发,直到人自己再选一次。
 */
export type ErrorSummaryDecision = 'unknown' | 'allowed' | 'denied'
export interface ErrorSummaryConsentSnapshot {
  eligible: boolean
  context: string | null
  decision: ErrorSummaryDecision
}

export const ERROR_SUMMARY_CONSENT_CHANNELS = {
  read: 'error-summary:consent-read',
  write: 'error-summary:consent-write',
  changed: 'error-summary:consent-changed',
} as const

/** This file is a local installation contract, never an outgoing event. */
export interface ErrorSummaryConsentRecord {
  version: 1
  denied: Record<string, true>
}

const SCOPE = /^(?:anonymous|[a-f0-9]{64})$/

export function decodeErrorSummaryConsent(value: unknown): ErrorSummaryConsentRecord | null {
  if (value === null) return { version: 1, denied: {} }
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ErrorSummaryConsentRecord>
  if (record.version !== 1 || !record.denied || typeof record.denied !== 'object') return null
  const denied: Record<string, true> = {}
  for (const [scope, flag] of Object.entries(record.denied)) {
    if (SCOPE.test(scope) && flag === true) denied[scope] = true
  }
  return { version: 1, denied }
}

export function createErrorSummaryConsentStore(deps: {
  eligible: boolean
  /** null = nothing saved yet; throws when the saved record cannot be read. */
  read: () => unknown
  save: (record: ErrorSummaryConsentRecord) => void
  scope: () => string | undefined
  changed: () => void
  withdraw: () => void
}) {
  let record: ErrorSummaryConsentRecord | null
  try { record = decodeErrorSummaryConsent(deps.read()) } catch { record = null }
  const blocked = new Set<string>()
  const snapshot = (): ErrorSummaryConsentSnapshot => {
    const scope = deps.scope()
    const eligible = deps.eligible && scope !== undefined
    if (!eligible || scope === undefined) return { eligible, context: scope ?? null, decision: 'unknown' }
    if (record === null || blocked.has(scope)) return { eligible, context: scope, decision: 'unknown' }
    return { eligible, context: scope, decision: record.denied[scope] ? 'denied' : 'allowed' }
  }
  return {
    snapshot,
    block() {
      const scope = deps.scope()
      if (scope !== undefined) blocked.add(scope)
      deps.changed()
    },
    set(decision: unknown, expectedScope: unknown) {
      const scope = deps.scope()
      if (!deps.eligible || scope === undefined || expectedScope !== scope || (decision !== 'allowed' && decision !== 'denied')) throw new Error('Error summary consent is unavailable')
      // Turning it off takes effect before disk I/O, including when saving fails.
      if (decision === 'denied') { blocked.add(scope); deps.changed(); deps.withdraw() }
      const denied = { ...record?.denied }
      if (decision === 'denied') denied[scope] = true
      else delete denied[scope]
      const next: ErrorSummaryConsentRecord = { version: 1, denied }
      deps.save(next)
      record = next
      blocked.delete(scope)
      deps.changed()
      return snapshot()
    },
  }
}
