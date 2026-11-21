import { chatService } from './chat'
import { replica } from './replica'

/** #7199 和个人助理的那条私聊的 id(rpc `open_dm`);不会变(`fresh: Infinity`),跨重启留一份:壳挂着就要它。 */
export const assistantDm = replica({
  name: 'assistantDm',
  scope: 'account',
  read: (owner: string, assistantId: string): Promise<string> => chatService.getOrCreateDM(owner, assistantId),
  fresh: Infinity,
  // ~190 B each: the assistant and, after a move or re-provision, the one before it.
  persist: { maxBytes: 256, maxEntries: 2 },
})
