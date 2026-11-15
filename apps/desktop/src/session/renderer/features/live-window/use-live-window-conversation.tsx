import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication';
import { rendererLogger } from '@/lib/log';
import type { LiveWindowContext } from './types';
import type { LiveWindowTransport } from './transport';
import { LiveWindowConversation } from './conversation';

const log = rendererLogger('live-window/conversation');
const conversations = new Map<string, LiveWindowConversation>();
let account = getRendererSession()?.user.id ?? 'local';
observeRendererSession(change => {
  const next = change.session?.user.id ?? 'local';
  if (next === account) return;
  account = next;
  for (const conversation of conversations.values()) conversation.dispose();
  conversations.clear();
});
export function liveWindowConversationKey(context: LiveWindowContext, platform: 'desktop' | 'phone' = 'desktop'): string {
  return JSON.stringify([account, platform, context.deviceId, context.sessionId, context.agentId]);
}
export function getLiveWindowConversation(context: LiveWindowContext, platform: 'desktop' | 'phone', transport: LiveWindowTransport) {
  const key = liveWindowConversationKey(context, platform);
  let conversation = conversations.get(key);
  if (!conversation) {
    conversation = new LiveWindowConversation(context, platform, transport, error => log.warn({ error }, 'Live picture could not be updated'));
    conversations.set(key, conversation);
  }
  return conversation;
}
export function findLiveWindowConversation(key: string) { return conversations.get(key); }
export function closeLiveWindowConversation(sessionId: string): void {
  for (const [key, conversation] of conversations) if (conversation.getContext().sessionId === sessionId) {
    conversation.dispose(); conversations.delete(key);
  }
}
export function LiveWindowPicture({ conversation, sourceId }: { conversation: LiveWindowConversation; sourceId: string }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = conversation.picture(sourceId), mount = root.current;
    if (!node || !mount) return;
    mount.append(node);
    return () => { if (node.parentElement === mount) node.remove(); };
  }, [conversation, sourceId]);
  return <div ref={root} className="h-full w-full" />;
}
export function useLiveWindowConversation(input: {
  context: LiveWindowContext; platform: 'desktop' | 'phone'; operating?: boolean; transport: LiveWindowTransport;
}) {
  const { context, platform, operating, transport } = input;
  const key = liveWindowConversationKey(context, platform), holder = useId();
  const conversation = useMemo(() => getLiveWindowConversation(context, platform, transport), [key, platform, transport]);
  useEffect(() => { conversation.setVisible(holder, context.shown); return () => conversation.setVisible(holder, false); }, [conversation, holder, context.shown]);
  useEffect(() => { if (operating !== undefined) conversation.setOperating(operating); }, [conversation, operating]);
  const snapshot = useSyncExternalStore(conversation.model.subscribe, conversation.model.getSnapshot, conversation.model.getSnapshot);
  const sources = useMemo(() => snapshot.sources.map(source => ({
    ...source, picture: <LiveWindowPicture key={source.id} conversation={conversation} sourceId={source.id} />,
  })), [snapshot.sources, conversation]);
  return { ...snapshot, sources, conversation, dispatch: conversation.model.dispatch.bind(conversation.model) };
}
