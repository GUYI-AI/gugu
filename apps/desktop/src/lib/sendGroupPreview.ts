import { i18n } from '@/i18n/runtime'

/** #2581 The latest message is several files sent at once: the chat list and its notification say how many, not the last file's name. */
export function sendGroupPreview(size: unknown): string | null {
  const count = Number(size)
  return Number.isInteger(count) && count > 1 ? i18n.t('chatList.sendPreview', { ns: 'messaging', count }) : null
}
