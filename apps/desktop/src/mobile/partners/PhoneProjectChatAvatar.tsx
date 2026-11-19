import { type CSSProperties, type ReactNode } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useDevicesStore } from '@/store/devicesContext'
import { deviceSessionsOf, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { needsYouCount } from '@/session/renderer/features/sidebar/session-groups'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { sessionPresentation } from '@/lib/agent-wait/watch-status'
import { useMyChatAgentCounts } from '@/lib/innerSidebarBridge'
import { Chip } from '@/components/ui/Chip'
import { TaskStatusMark } from '@/components/chat/ComposerCardView'
import { PhoneMessageAvatar } from '../chat/PhoneMessageAvatar'

/**
 * 消息中的群用群自己的头像(#2600 owner 11-13:没要过文件夹封面,群头像换了就该看得见);
 * 提醒仅占头像一角,不进伙伴通讯录。桌面(#2548 一张表的侧栏):头像右下角挂「我的智能体里有几个在跑」(#2599:住在群里的那些)。
 */
export function PhoneProjectChatAvatar({ chat, mobile, children }: { chat: ChatItem; mobile: boolean; children: ReactNode }) {
  return mobile ? <ProjectChatAvatar chat={chat}>{children}</ProjectChatAvatar> : <DesktopProjectChatAvatar chat={chat}>{children}</DesktopProjectChatAvatar>
}

/** 桌面:群头像照旧,群在角上挂在跑的数。 */
function DesktopProjectChatAvatar({ chat, children }: { chat: ChatItem; children: ReactNode }) {
  return <ProjectRunningCount chatId={chat.id}>{children}</ProjectRunningCount>
}

// 右下角:群头像不挂引擎角标,这一角是空的。头像里现在是字,所以这枚数往外挂(伸进头像右边和下边的空隙),少盖字。
const RUNNING_AVATAR_STYLE: CSSProperties = { position: 'relative', display: 'inline-flex' }
const RUNNING_CORNER_STYLE: CSSProperties = { position: 'absolute', right: -9, bottom: -6, pointerEvents: 'none' }

/**
 * 数由会话页算好发过来(innerSidebarBridge:群有、开关关着没有),与内层侧栏「智能体」分区头那枚药丸同一个推导;
 * 字形与侧栏会话行在跑的那一枚相同(TaskStatusMark)。一个都没在跑就不挂。
 */
function ProjectRunningCount({ chatId, children }: { chatId: string; children: ReactNode }) {
  const counts = useMyChatAgentCounts(chatId)
  const { translate } = useSessionMessages()
  if (!counts || counts.running === 0) return children
  const label = translate('sidebar.agentsRunning', { count: counts.running })
  return <span style={RUNNING_AVATAR_STYLE}>
    {children}
    <span style={RUNNING_CORNER_STYLE} role="img" aria-label={label} title={label} data-project-running={counts.running}>
      <Chip appearance="filled"><TaskStatusMark status="working" />{counts.running}</Chip>
    </span>
  </span>
}

function ProjectChatAvatar({ chat, children }: { chat: ChatItem; children: ReactNode }) {
  const { devices } = useDevicesStore()
  const directory = useLiveDeviceSessions()
  if (chat.kind !== 'group') return <PhoneMessageAvatar>{children}</PhoneMessageAvatar>
  // 角标与桌面的「需要你」点是同一条计数(needsYouCount):各台机器上住在这个群里的会话,等你操作或失败还没看过的。
  const needsYou = needsYouCount(devices.flatMap((device) => {
    const listed = deviceSessionsOf(device, directory)
    return listed.sessions.filter((session) => session.groupChatId === chat.id).map((session) => ({
      presentation: sessionPresentation(session, listed.hostOnline === true && !listed.cached),
      unseen: session.unseen === true,
      hostOnline: listed.hostOnline,
    }))
  }))
  return <PhoneMessageAvatar badge={needsYou > 0 ? <span className="gg-phone-project-attention" data-testid="phone-project-waiting" aria-hidden /> : null}>
    {children}
  </PhoneMessageAvatar>
}
