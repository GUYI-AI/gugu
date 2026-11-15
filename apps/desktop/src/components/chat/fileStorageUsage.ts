import { readModel } from '../../lib/readModel'
import { rendererLogger } from '../../lib/log'
import { chatDb } from '../../lib/supabase'

type Usage = { used_and_reserved_bytes: number; limit_bytes: number; warning: boolean; full: boolean }
const log = rendererLogger('files/storage-usage')

/**
 * One group's file storage against its limit, for the managers shown the notice: attachment changes keep the last
 * verified usage on screen while it is read again. Re-read every minute while shown (a placed file need not emit a chat
 * message); a failed read retries with backoff before it is reported.
 */
export const fileStorageUsage = readModel({
  name: 'file-storage-usage',
  scope: 'account',
  read: async (userId, chatId: string): Promise<Usage> => {
    try {
      const { data, error } = await chatDb.rpc('file_transfer_group_usage', { p_chat: chatId, p_as: userId })
      if (error) throw new Error(error.message, { cause: error })
      const row = data as Usage | null
      if (!row || !Number.isSafeInteger(row.used_and_reserved_bytes) || row.used_and_reserved_bytes < 0 ||
        !Number.isSafeInteger(row.limit_bytes) || row.limit_bytes < 0 || typeof row.warning !== 'boolean' || typeof row.full !== 'boolean') {
        throw new Error('Invalid group file usage response')
      }
      return row
    } catch (error) {
      log.error({ userId, chatId, error: String(error), cause: error instanceof Error ? error.cause : undefined }, 'could not read group file storage usage')
      throw error
    }
  },
  // An attachment change while a slow read is retrying shares that read (❌ cancel it and start another).
  refreshJoinsRead: true,
  retry: true,
  retryDelay: (attempt) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000),
  refreshEvery: 60_000,
  refreshOnFocus: true,
})
