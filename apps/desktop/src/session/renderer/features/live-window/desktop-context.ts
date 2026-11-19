import { machineRegistry } from '@renderer/lib/machine-routing';
import { sessionAgentBindings } from '../sessions/stores/session-agent-bindings';
import type { LiveWindowContext } from './types';
import type { LiveWindowConversation } from './conversation';
import { reaction } from 'mobx';
import { sessionRegistry } from '../sessions/stores/session-registry';

const bound = new WeakSet<LiveWindowConversation>();
export function bindDesktopLiveWindowActivity(conversation: LiveWindowConversation): void {
  if (bound.has(conversation)) return;
  bound.add(conversation);
  const sessionId = conversation.getContext().sessionId;
  conversation.addCleanup(reaction(() => sessionRegistry.get(sessionId)?.sessions.get(sessionId)?.status,
    status => conversation.setOperating(status === 'working' || status === 'needs_user'), { fireImmediately: true }));
}

export function desktopLiveWindowContext(projectId: string, sessionId: string, shown: boolean): LiveWindowContext {
  return { conversationId: sessionId, deviceId: machineRegistry.machineOf(projectId) ?? 'local', sessionId,
    agentId: sessionAgentBindings.bindingFor(sessionId)?.agentUserId ?? sessionId, privateAgentChat: true, shown };
}
