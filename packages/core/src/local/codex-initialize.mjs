export const CODEX_INITIALIZE_TIMEOUT_MS = 120_000
export const CODEX_INITIALIZE_TIMEOUT = 'codex_initialize_timeout'
export const CODEX_PREPARATION_PREFIX = '[gugu-codex-preparing] '

export function codexBackfillWaiting(error) {
  return /timed out waiting for state db backfill[\s\S]*?status:\s*running/i.test(String(error?.stderrTail ?? error?.message ?? ''))
}
export function retryableCodexPreparation(error) {
  return error?.code === CODEX_INITIALIZE_TIMEOUT || codexBackfillWaiting(error)
}
export function parseCodexPreparation(line) {
  if (!line.startsWith(CODEX_PREPARATION_PREFIX)) return undefined
  try {
    const value = JSON.parse(line.slice(CODEX_PREPARATION_PREFIX.length))
    if (value === null) return null
    if (['preparing', 'history'].includes(value?.phase) && Number.isFinite(value.startedAt) && Number.isInteger(value.attempt) && value.attempt > 0) return value
  } catch { /* An unrelated or partial stderr line is not a preparation fact. */ }
  return undefined
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Codex preparation cancelled'))
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Codex preparation cancelled')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
/** One bounded native attempt; persisted backfill work survives its process. No private database edits. */
export async function retryCodexPreparation(start, { stop = async () => {}, onProgress = () => {}, signal, wait = delay, retryDelayMs = 5_000 } = {}) {
  const startedAt = Date.now()
  let phase = 'preparing'
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    onProgress({ phase, startedAt, attempt })
    try {
      const result = await start()
      onProgress(null)
      return result
    } catch (error) {
      if (signal?.aborted || !retryableCodexPreparation(error)) throw error
      await stop()
      if (codexBackfillWaiting(error)) phase = 'history'
      onProgress({ phase, startedAt, attempt })
      await wait(retryDelayMs, signal)
    }
  }
}
