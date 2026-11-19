export const CODEX_INITIALIZE_PROGRESS_MS = 120_000
export const CODEX_PREPARATION_PREFIX = '[gugu-codex-preparing] '

export function codexBackfillWaiting(error) {
  return /timed out waiting for state db backfill[\s\S]*?status:\s*running/i.test(String(error?.stderrTail ?? error?.message ?? ''))
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
/** Time updates progress; only a native exit waiting on the backfill lease starts another process. */
export async function retryCodexPreparation(start, { stop = async () => {}, onProgress = () => {}, signal, wait = delay, retryDelayMs = 5_000 } = {}) {
  const startedAt = Date.now()
  let phase = 'preparing'
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    const publish = () => onProgress({ phase, startedAt, attempt })
    publish()
    const progress = setTimeout(publish, CODEX_INITIALIZE_PROGRESS_MS)
    progress.unref?.()
    try {
      const result = await start()
      onProgress(null)
      return result
    } catch (error) {
      clearTimeout(progress)
      if (signal?.aborted || !codexBackfillWaiting(error)) throw error
      await stop()
      phase = 'history'
      publish()
      await wait(retryDelayMs, signal)
    } finally { clearTimeout(progress) }
  }
}
