import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors'
import { i18n } from '@/i18n'
import type { Reading } from '@/lib/replica'

/**
 * How the phone's assistant pages draw a reading (`ReadView`): `loading` (unknown), `ok` with its data — and the failure
 * of the last refresh, while the shown data stays — or `error`. A view of a replica's reading, ❌ a read of its own.
 */
export type PhoneRead<T> = { state: 'loading' } | { state: 'ok'; data: T; refreshError?: unknown } | { state: 'error'; error: unknown }

export function phoneReadOf<T>(reading: Reading<T>, reload: () => void): PhoneRead<T> & { reload: () => void } {
  if (reading.state === 'unknown') return { state: 'loading', reload }
  if (reading.state === 'error') return { state: 'error', error: reading.error, reload }
  return reading.error ? { state: 'ok', data: reading.value, refreshError: reading.error, reload } : { state: 'ok', data: reading.value, reload }
}

/**
 * A collection the home has not prepared yet (a new assistant's panel while its setup finishes): not a failure, one to
 * wait for. Its readers draw it as "preparing", never "unreadable".
 */
export const assistantReadWaiting = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'unprepared'

export function errorText(error: unknown): string {
  return assistantPanelFailure(error,(key,values) => i18n.t(`assistant:${key}`,values))
}
