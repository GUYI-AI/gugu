import { chatService } from './chat'
import { rendererLogger } from './log'
import { replica } from './replica'

const dmLog = rendererLogger('assistant/chat')

/**
 * #7199 和个人助理的那条私聊的 id(rpc `open_dm`:有就给那一条,没有就建一条 —— 与通讯录「发消息」同一个)。一条私聊的 id
 * 不会变,读到就一直对(`fresh: Infinity`,没有推送)。跨重启留一份:壳挂着就要它(聊天格子、「今天」页的文件夹)。
 */
export const assistantDm = replica({
  name: 'assistantDm',
  scope: 'account',
  read: async (owner: string, assistantId: string): Promise<string> => {
    try {
      return await chatService.getOrCreateDM(owner, assistantId)
    } catch (error) {
      dmLog.error({ error: String(error), assistantId }, 'open assistant dm failed')
      throw error
    }
  },
  fresh: Infinity,
  // One chat id (~40 B in a ~110 B entry); the assistant and, after a move or a re-provision, the one before it.
  persist: { maxBytes: 128, maxEntries: 2 },
})
