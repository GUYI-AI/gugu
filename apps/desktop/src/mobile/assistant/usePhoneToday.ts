import { readChatFolderText } from '@/lib/chatFolder'
import { replica, useReplica } from '@/lib/replica'
import { ChatFolderReadError } from '@/session/shared/extensions/chat-folder-text'
import { TODAY_FILE_NAME, TODAY_REFRESH_MS, TodayReadError, todayReadOf, type TodayFeedView, type TodayRead } from '@/session/renderer/features/assistant/assistant-today-file'

/**
 * 私聊文件夹里的 today.json(手机上在窗口里 fetch,lib/chatFolder.ts;文件服务要答跨域预检,gugu-supabase #119)。
 * 没有「文件夹变了」的推送:摆着时每分钟再问一次,再问时照旧摆着上一份(❌ 闪回「正在读」)。不跨重启留(内容随日子长)。
 */
export const assistantToday = replica({
  name: 'assistantToday',
  scope: 'account',
  read: async (_owner: string, chatId: string): Promise<TodayRead> => {
    try {
      return todayReadOf(await readChatFolderText({ chat: chatId, name: TODAY_FILE_NAME }))
    } catch (error) {
      throw error instanceof ChatFolderReadError ? new TodayReadError(error.kind, error.message) : error
    }
  },
  refreshEvery: TODAY_REFRESH_MS,
})

/** 「动态」那一格与「<名字>」那一格的日记都读它。 */
export function usePhoneToday(chatId: string): TodayFeedView {
  const reading = useReplica(assistantToday, [chatId])
  if (reading.state === 'unknown') return { state: 'loading' }
  if (reading.state === 'error') return { state: 'error', error: reading.error, retry: () => { void assistantToday.refresh(chatId) } }
  return { state: 'read', read: reading.value }
}
