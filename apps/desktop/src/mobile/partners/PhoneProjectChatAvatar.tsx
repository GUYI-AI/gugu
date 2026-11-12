import { useCallback, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useAgentDisplayStatuses } from '@/hooks/useAgentDisplayStatus'
import { useDevicesStore } from '@/store/devicesContext'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { isAssistantHome, type AssistantHomeRow } from '@/lib/assistantHome'
import { deviceSessionsOf, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { needsYouCount } from '@/session/renderer/features/sidebar/session-groups'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { useMyChatAgentCounts } from '@/lib/innerSidebarBridge'
import { Chip } from '@/components/ui/Chip'
import { TaskStatusMark } from '@/components/chat/ComposerCardView'
import { partnerProjects, type PartnerProject } from './partnersModel'
import { ProjectFolderAvatar } from './ProjectFolderAvatar'
import { PhoneMessageAvatar } from '../chat/PhoneMessageAvatar'

/**
 * 消息中的项目群沿用项目封面;提醒仅占头像一角,不进伙伴通讯录。
 * 桌面(#2548 一张表的侧栏):项目行也是项目封面(同一个 ProjectFolderAvatar,侧栏头像位 32),
 * 头像右下角挂「我的智能体里有几个在跑」;用户群没有这个数,也不换封面。
 */
export function PhoneProjectChatAvatar({ chat, mobile, children }: { chat: ChatItem; mobile: boolean; children: ReactNode }) {
  return mobile ? <ProjectChatAvatar chat={chat}>{children}</ProjectChatAvatar> : <DesktopProjectChatAvatar chat={chat}>{children}</DesktopProjectChatAvatar>
}

/** 桌面:项目群换成它的项目封面(哪个项目、哪张封面与手机同一个推导 partnerProjects),封面的鲜明度跟着在跑的数。 */
function DesktopProjectChatAvatar({ chat, children }: { chat: ChatItem; children: ReactNode }) {
  const project = useChatProject(chat.kind === 'group' ? chat.id : null)
  const running = useMyChatAgentCounts(chat.id)?.running ?? 0
  return <ProjectRunningCount chatId={chat.id}>
    {project ? <ProjectFolderAvatar coverId={project.coverId} running={running} size={DESKTOP_ROW_AVATAR_PX} /> : children}
  </ProjectRunningCount>
}

/** 桌面会话行的头像位(Avatar size="sm")。 */
const DESKTOP_ROW_AVATAR_PX = 32

// 角落与引擎角标同一处(.agent-harness-badge:右下,各让出 2px);群头像不挂引擎角标,这一角是空的。
const RUNNING_AVATAR_STYLE: CSSProperties = { position: 'relative', display: 'inline-flex' }
const RUNNING_CORNER_STYLE: CSSProperties = { position: 'absolute', right: -2, bottom: -2, pointerEvents: 'none' }

/**
 * 数由会话页算好发过来(innerSidebarBridge:只有项目群有、开关关着没有),与内层侧栏「智能体」分区头那枚药丸同一个推导;
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

/** 这个群是哪个项目(手机与桌面同一个推导 partnerProjects,读账号上的项目);不是项目群 / chatId null = undefined。 */
function useChatProject(chatId: string | null): PartnerProject | undefined {
  const { devices, cloudComputer } = useDevicesStore()
  // 个人助理宿主:与 useMachineLabel 同一个判据(只读设备 store,头像不依赖登录态)。
  const homeId = cloudComputer?.snapshot?.deviceId ?? null
  const isHome = useCallback((row: AssistantHomeRow) => isAssistantHome(row, homeId), [homeId])
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  return useMemo(() => (chatId === null ? undefined : partnerProjects(accountList, devices, isHome).find((row) => row.chatId === chatId)), [accountList, devices, isHome, chatId])
}

function ProjectChatAvatar({ chat, children }: { chat: ChatItem; children: ReactNode }) {
  const { devices } = useDevicesStore()
  const directory = useLiveDeviceSessions()
  const project = useChatProject(chat.id)
  const statuses = useAgentDisplayStatuses(chat.member_user_ids ?? [])
  if (!project) return <PhoneMessageAvatar>{children}</PhoneMessageAvatar>
  const running = Object.values(statuses).filter((status) => status === 'working').length
  // 角标与桌面项目行的「需要你」点是同一条计数(needsYouCount):那台机器上这个项目的会话,等你操作或失败还没看过的。
  const needsYou = needsYouCount(project.members.flatMap(({ deviceId, localProjectId }) => {
    const device = devices.find((row) => row.device_id === deviceId)
    if (!device) return []
    const listed = deviceSessionsOf(device, directory)
    return listed.sessions.filter((session) => session.projectId === localProjectId).map((session) => ({
      presentation: sessionPresentation(session, listed.hostOnline === true && !listed.cached),
      unseen: session.unseen === true,
      hostOnline: listed.hostOnline,
    }))
  }))
  return <PhoneMessageAvatar badge={needsYou > 0 ? <span className="gg-phone-project-attention" data-testid="phone-project-waiting" aria-hidden /> : null}>
    <ProjectFolderAvatar coverId={project.coverId} running={running} size={48} />
  </PhoneMessageAvatar>
}
