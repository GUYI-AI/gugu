import { chatService } from './chat'
import { rendererLogger } from './log'
import { replica } from './replica'

const dmLog = rendererLogger('assistant/chat')

/** #7199 和个人助理的那条私聊的 id(rpc `open_dm`);不会变(`fresh: Infinity`),跨重启留一份:壳挂着就要它。 */
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
  // ~190 B each: the assistant and, after a move or re-provision, the one before it.
  persist: { maxBytes: 256, maxEntries: 2 },
})
