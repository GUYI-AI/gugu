import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors'
import { i18n } from '@/i18n'

/**
 * A collection the home has not prepared yet (a new assistant's panel while its setup finishes): not a failure, one to
 * wait for. Its readers draw it as "preparing", never "unreadable".
 */
export const assistantReadWaiting = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'unprepared'

export function errorText(error: unknown): string {
  return assistantPanelFailure(error,(key,values) => i18n.t(`assistant:${key}`,values))
}
