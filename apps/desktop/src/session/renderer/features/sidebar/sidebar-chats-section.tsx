import { readShellSlots } from '@/lib/shellSlots';
import { CHAT_LIST_SLOT_KEY } from '@/lib/sidebarChatsBridge';
import { useCallback } from 'react';
import { SidebarGroup } from './sidebar-primitives';

// gugu-dev#181「对话」:人、用户群和它们的话题。行是聊天列表那一行原样搬过来(壳那棵树画进这一格),
// 新建群聊、添加联系人的弹窗也是聊天列表那一套 —— 会话页只转达这两个动作(requestShellChatAction),❌ 在这边另写一份。

/**
 * The one list's conversations (#2548). No header: the list is the sidebar's only list, so a 「对话」 title separates it
 * from nothing, and its total unread count repeats what each row and the bell already show (owner, 11-12).
 */
export function SidebarChatsSection() {
  const listSlot = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(CHAT_LIST_SLOT_KEY, element), []);

  return (
    <SidebarGroup className="mb-0 flex flex-col" data-sidebar-chats="">
      {/* 聊天列表画进这一格(壳那棵树的 components/ChatListSlotHost.tsx);格子里的东西归壳管,这一侧 ❌ 往里放子元素。 */}
      <div ref={listSlot} data-region="sidebar-chat-list" className="min-h-0" />
    </SidebarGroup>
  );
}
