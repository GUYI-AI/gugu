import { useCallback, useEffect } from 'react';
import { setInnerSidebarTopicsAll, topicsPageSlotKey } from '@/lib/innerSidebarBridge';
import { readShellSlots } from '@/lib/shellSlots';

/**
 * 「全部 ›」打开的话题页在这个群 / 项目那一块里留的格子;页本身由壳画进来(ChatListSlotHost → InnerTopicsPage)。
 * 这一块走了(点开一条话题换了主会话、关掉这一块),话题页跟着关:回到这个群时看到的是群本身。
 */
export function TopicsPageSlot({ chatId }: { chatId: string }) {
  const slot = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(topicsPageSlotKey(chatId), element), [chatId]);
  useEffect(() => () => setInnerSidebarTopicsAll(null), [chatId]);
  return <div ref={slot} className="flex min-h-0 min-w-0 flex-1 flex-col" data-region="topics-page" />;
}
