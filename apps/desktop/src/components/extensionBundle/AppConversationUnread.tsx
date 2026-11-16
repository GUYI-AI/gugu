import type { ReactNode } from 'react';
import { useAuth } from '@/store/auth';
import { useChatStore } from '@/store/chatContext';
import { useReplica } from '@/lib/replica';
import { LOCAL_HOST, useInstalledApps } from '@/session/renderer/features/extensions/installed-extensions';
import { conversationUnreadProjection } from '@/session/shared/extensions/unread-projection';
import { appUnreadBindings } from '../appSlot/appBindingReplicas';

/** Mounted by the host rail, never by an App guest. Until `appUnreadBindings` is read (or when it cannot be), no unread is said. */
export function AppConversationUnread({ extensionId, children }: {
  extensionId: string; children: (unread: boolean | null) => ReactNode;
}) {
  const { user } = useAuth();
  const ownerId = user?.id ?? null;
  const { chats } = useChatStore('chats');
  const installed = useInstalledApps(LOCAL_HOST);
  const name = installed.state === 'value' ? installed.value.manifestFor(extensionId)?.contributes.unreadSource?.binding : undefined;
  const bindings = useReplica(appUnreadBindings, ownerId && name ? [] : null);
  if (!name || bindings.state !== 'value') return children(null);
  return children(conversationUnreadProjection({ ownerId, binding: bindings.value[extensionId], name, chats }));
}
