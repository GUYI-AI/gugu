import { useSessionMessages } from '@renderer/localization/use-session-messages';

// 数只在真读了才减 —— 这里只读数、❌ 清任何东西。

/** 未读数(红底白字):「对话」分区头上、项目行尾、内层侧栏收起时的分区头上。 */
export function SidebarUnreadCount({ count }: { count: number }) {
  const { translate } = useSessionMessages();
  if (count <= 0) return null;
  return (
    <span
      aria-label={translate('sidebar.unreadCount', { count })}
      className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--danger-solid)] px-1 text-[length:var(--font-caption)] leading-none font-semibold text-[var(--danger-solid-fg)]"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
