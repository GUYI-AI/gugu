import { coreLogger } from '../../log'

const log = coreLogger('agent-inbox-reader')
type Retry = { attempts: number; timer?: ReturnType<typeof setTimeout> }
const retries = new Map<string, Retry>()

/** A new real trigger supersedes the timer, but consecutive failures retain their backoff. */
export function beginInboxAttempt(agentUserId: string): void {
  const retry = retries.get(agentUserId)
  if (retry?.timer) clearTimeout(retry.timer)
}

export function clearInboxRetry(agentUserId: string): void {
  beginInboxAttempt(agentUserId)
  retries.delete(agentUserId)
}

/** Only rejected pulls enter here. Normal admission deferrals and settled turns never poll. */
export function retryInboxFailure(agentUserId: string, error: unknown, pull: () => void): void {
  const retry = retries.get(agentUserId) ?? { attempts: 0 }
  if (retry.timer) clearTimeout(retry.timer)
  retry.attempts += 1
  const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(retry.attempts - 1, 6))
  retry.timer = setTimeout(() => {
    if (retries.get(agentUserId) !== retry) return
    retry.timer = undefined
    pull()
  }, delayMs)
  retry.timer.unref?.()
  retries.set(agentUserId, retry)
  log.warn({ agentUserId, attempt: retry.attempts, delayMs, err: error instanceof Error ? error.message : String(error) },
    'agent inbox pull retry scheduled; unread rows will be pulled without another message')
}

/**
 * A read receipt the host writes after acceptance failed (a network error or a 5xx): re-pull with backoff — the
 * re-pulled row is already accepted, so the host only writes its receipt again. Its own count, cleared only when a
 * receipt lands: a pull succeeding says nothing about the receipt, which the host writes without waiting. Bounded;
 * after the last round the next ordinary trigger settles it.
 */
export const RECEIPT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000]
const receiptRetries = new Map<string, Retry>()

export function retryInboxReceipt(agentUserId: string, error: unknown, pull: () => void): void {
  const retry = receiptRetries.get(agentUserId) ?? { attempts: 0 }
  receiptRetries.set(agentUserId, retry)
  // Several rows failing in one round schedule one re-pull.
  if (retry.timer) return
  const delayMs = RECEIPT_RETRY_DELAYS_MS[retry.attempts]
  const err = error instanceof Error ? error.message : String(error)
  if (delayMs === undefined) {
    log.error({ agentUserId, attempts: retry.attempts, err }, 'agent read receipt still failing; no more re-pulls until the next trigger')
    return
  }
  retry.attempts += 1
  retry.timer = setTimeout(() => {
    if (receiptRetries.get(agentUserId) !== retry) return
    retry.timer = undefined
    pull()
  }, delayMs)
  retry.timer.unref?.()
  log.warn({ agentUserId, attempt: retry.attempts, delayMs, err }, 'agent read receipt failed; re-pull scheduled')
}

export function clearInboxReceiptRetry(agentUserId: string): void {
  const retry = receiptRetries.get(agentUserId)
  if (retry?.timer) clearTimeout(retry.timer)
  receiptRetries.delete(agentUserId)
}

export function resetInboxRetries(): void {
  for (const agentUserId of retries.keys()) clearInboxRetry(agentUserId)
  for (const agentUserId of receiptRetries.keys()) clearInboxReceiptRetry(agentUserId)
}
