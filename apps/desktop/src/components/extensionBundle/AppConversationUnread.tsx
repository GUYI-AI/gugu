import type { ReactNode } from 'react';
import { useAuth } from '@/store/auth';
import { useChatStore } from '@/store/chatContext';
import { useReplica } from '@/lib/replica';
import { LOCAL_HOST, useInstalledApps } from '@/session/renderer/features/extensions/installed-extensions';
import { conversationUnreadProjection } from '@/session/shared/extensions/unread-projection';
import { appUnreadBindings, useAppBindingPush } from '../appSlot/appBindingReplicas';

/**
 * Mounted by the host rail, never by an App guest. Page lifetime does not participate. The host-owned authorization
 * association (`appUnreadBindings`, not chat contents or a copied unread count) is read once for every rail entry and again
 * when main says an App changed; until it is read, or when it cannot be, no unread is said (`null`).
 */
export function AppConversationUnread({ extensionId, children }: {
  extensionId: string; children: (unread: boolean | null) => ReactNode;
}) {
  const { user } = useAuth();
  const ownerId = user?.id ?? null;
  const { chats } = useChatStore('chats');
  const installed = useInstalledApps(LOCAL_HOST);
  // Unknown list: no binding name, so nothing is read and no unread is said (`null`) until it is known.
  const name = installed.state === 'value' ? installed.value.manifestFor(extensionId)?.contributes.unreadSource?.binding : undefined;
  const bindings = useReplica(appUnreadBindings, ownerId && name ? [] : null);
  useAppBindingPush(!!ownerId && !!name);
  if (!name || bindings.state !== 'value') return children(null);
  return children(conversationUnreadProjection({ ownerId, binding: bindings.value[extensionId], name, chats }));
}
