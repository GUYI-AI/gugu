import { useDesktopSidebarV2Switch } from '@renderer/features/sidebar/use-desktop-sidebar-v2';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 空会话那块空态(ThreadWelcome)的字。#2548 一张表的侧栏(开关 interface.desktopSidebarV2):一条空会话就是一个
 * 刚建的新智能体 ⇒ 问「想让新智能体做点什么？」,下面一行说名字和头像会自动生成(mock v33 创建智能体)。关着 = 今天那一句。
 */
export function useSessionHeroCopy(): { title: string; description?: string } {
  const { translate } = useSessionMessages();
  return useDesktopSidebarV2Switch()
    ? { title: translate('chat.heroNewAgent'), description: translate('chat.heroNewAgentHint') }
    : { title: translate('chat.hero') };
}
