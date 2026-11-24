import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useDevicesStore } from '@/store/devicesContext'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { isAssistantHome, type AssistantHomeRow } from '@/lib/assistantHome'
import { deviceSessionsOf, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { needsYouCount } from '@/session/renderer/features/sidebar/session-groups'
import { sessionPresentation } from '@/lib/agent-wait/watch-status'
import { partnerProjects, type PartnerProject } from './partnersModel'
import { PhoneMessageAvatar } from '../chat/PhoneMessageAvatar'
import { cloudSnapshotOf, useCloudComputer } from '@/lib/cloudComputer'

/**
 * 消息中的项目群和别的群一样用群自己的头像(#2600 owner 11-13:没要过文件夹封面,群头像换了就该看得见);
 * 提醒仅占头像一角,不进伙伴通讯录(手机)。桌面头像角上不挂数。
 */
export function PhoneProjectChatAvatar({ chat, mobile, children }: { chat: ChatItem; mobile: boolean; children: ReactNode }) {
  return mobile ? <ProjectChatAvatar chat={chat}>{children}</ProjectChatAvatar> : <DesktopProjectChatAvatar chat={chat}>{children}</DesktopProjectChatAvatar>
}

/** 桌面:群头像照旧,角上不挂数(界面减法 #69:在跑的智能体数不挂在头像上,状态看行尾和群内侧栏)。 */
function DesktopProjectChatAvatar({ children }: { chat: ChatItem; children: ReactNode }) {
  return children
}

/** 这个群是哪个项目(手机与桌面同一个推导 partnerProjects,读账号上的项目);不是项目群 / chatId null = undefined。 */
function useChatProject(chatId: string | null): PartnerProject | undefined {
  const { devices } = useDevicesStore()
  const cloudComputer = useCloudComputer()
  // 个人助理宿主:与 useMachineLabel 同一个判据(只读设备 store,头像不依赖登录态)。
  const homeId = cloudSnapshotOf(cloudComputer)?.deviceId ?? null
  const isHome = useCallback((row: AssistantHomeRow) => isAssistantHome(row, homeId), [homeId])
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  return useMemo(() => (chatId === null ? undefined : partnerProjects(accountList, devices, isHome).find((row) => row.chatId === chatId)), [accountList, devices, isHome, chatId])
}

function ProjectChatAvatar({ chat, children }: { chat: ChatItem; children: ReactNode }) {
  const { devices } = useDevicesStore()
  const directory = useLiveDeviceSessions()
  const project = useChatProject(chat.id)
  if (!project) return <PhoneMessageAvatar>{children}</PhoneMessageAvatar>
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
    {children}
  </PhoneMessageAvatar>
}
