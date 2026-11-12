import { readShellSlots } from '@/lib/shellSlots';
import { CHAT_LIST_SLOT_KEY } from '@/lib/sidebarChatsBridge';
import { useCallback } from 'react';
import { MicroLabel } from '@renderer/lib/ui/label';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SidebarUnreadCount } from './sidebar-unread-count';
import { SidebarGroup, sidebarGroupHeaderClass, sidebarGroupTitleClass } from './sidebar-primitives';

// gugu-dev#181「对话」:人、用户群和它们的话题。行是聊天列表那一行原样搬过来(壳那棵树画进这一格),
// 新建群聊、添加联系人的弹窗也是聊天列表那一套 —— 会话页只转达这两个动作(requestShellChatAction),❌ 在这边另写一份。

/**
 * 「对话」分区 —— #2548 the one list's conversations: the list is always open, so its header is a plain title with the
 * unread count (no collapse toggle, no 「+」: the one list's top has it).
 */
export function SidebarChatsSection({ unread }: { unread: number }) {
  const { translate } = useSessionMessages();
  const listSlot = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(CHAT_LIST_SLOT_KEY, element), []);

  return (
    <SidebarGroup className="mb-0 flex flex-col" data-sidebar-chats="">
      <div className={sidebarGroupHeaderClass} data-sidebar-chats-header="">
        <span className="flex items-center gap-1">
          <MicroLabel className={sidebarGroupTitleClass}>{translate('sidebar.chats')}</MicroLabel>
          <SidebarUnreadCount count={unread} />
        </span>
      </div>
      {/* 聊天列表画进这一格(壳那棵树的 components/ChatListSlotHost.tsx);格子里的东西归壳管,这一侧 ❌ 往里放子元素。 */}
      <div ref={listSlot} data-region="sidebar-chat-list" className="min-h-0" />
    </SidebarGroup>
  );
}
