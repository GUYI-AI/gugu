import { useCallback, useMemo } from 'react'
import type { ChatItem, Device } from '@gugu/core/shared/types/chat'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { chatActivityAt } from '@gugu/core/shared/ui/chatModels'
import type { DisplayIdentity } from '@/lib/displayIdentity'
import { useChatStore } from '../../store/chatContext'
import { useDevicesStore } from '../../store/devicesContext'

// 通讯录群行与群资料要的那几样事实:谁在里面、绑的哪个项目文件夹、最近一次动静。全是客户端已有的:
// 会话行(活动时刻、未读)、身份目录(成员是人还是 Agent —— 会话列表保证 member_user_ids 的身份都在)、
// 设备 store 上各台机器记在账号上的项目(chatId → 项目)。❌ 再读一次。

export type GroupProject = { device: Device; project: DeviceProject }

export type GroupRowFacts = {
  activityAt: string | null
  unread: number
  /** 人在前、Agent 在后。 */
  members: DisplayIdentity[]
  humans: number
  agents: number
  /** 设备 store 还没读到项目 = null(不画,❌ 说「未绑定」)。 */
  project: GroupProject | null
}

export function projectsByChat(devices: readonly Device[]): Map<string, GroupProject> {
  const byChat = new Map<string, GroupProject>()
  for (const device of devices) {
    for (const project of device.projects ?? []) {
      if (project.chatId && !byChat.has(project.chatId)) byChat.set(project.chatId, { device, project })
    }
  }
  return byChat
}

export function useGroupProject(chatId: string): GroupProject | null {
  const { devices } = useDevicesStore()
  return useMemo(() => projectsByChat(devices).get(chatId) ?? null, [devices, chatId])
}

export function useGroupRowFacts(): (group: ContactGroupChat) => GroupRowFacts {
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const { devices } = useDevicesStore()
  const chatById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats])
  const projects = useMemo(() => projectsByChat(devices), [devices])
  return useCallback((group) => {
    const chat = chatById.get(group.id)
    const known = (group.member_user_ids ?? []).flatMap((id) => identitiesById[id] ?? [])
    const humans = known.filter((identity) => identity.type !== 'agent')
    const agents = known.filter((identity) => identity.type === 'agent')
    return {
      activityAt: chat ? chatActivityAt(chat) : null,
      unread: chat?.unread_count ?? 0,
      members: [...humans, ...agents],
      humans: humans.length,
      agents: agents.length,
      project: projects.get(group.id) ?? null,
    }
  }, [chatById, identitiesById, projects])
}

/** 置顶在前,其余按最近一次动静排(会话列表同一个键,chatActivityAt @@@2264)。 */
export function sortGroupsByActivity(groups: ContactGroupChat[], chats: readonly ChatItem[], pinned: ReadonlyMap<string, boolean>): ContactGroupChat[] {
  const at = new Map(chats.map((chat) => [chat.id, Date.parse(chatActivityAt(chat)) || 0]))
  const rank = (group: ContactGroupChat) => (pinned.get(group.id) ? 1 : 0)
  return [...groups].sort((a, b) => rank(b) - rank(a) || (at.get(b.id) ?? 0) - (at.get(a.id) ?? 0))
}
