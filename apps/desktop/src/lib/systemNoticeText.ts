import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { SystemNotice } from '@gugu/core/shared/ui/systemNotice'
import { i18n } from '@/i18n'
import { agentFailureText } from './agentTurnFailure'
import { displayAgentReferences } from './mentionMdast'
import { markdownPlainText } from './markdownPlainText'

// @@@system-notice-text A system row in the reader's language. The server stores one Chinese sentence in content for
// agents and old clients; the marker says what kind of row it is (systemNotice.ts), so old rows read right too. Only
// the names, and for member-managed which sentence, come from content. A sentence not recognised stays as written.
// The sentences matched here are written by these gugu-supabase functions: member-joined by chat.insert_group_member,
// agent-flood by chat.apply_agent_flood_rule and chat.enforce_agent_flood_passive, member-managed (left / removed /
// made admin / admin revoked) by chat.announce_group_management, topic-opened by chat.create_topic.
const say = (key: Parameters<typeof i18n.t>[0], values?: Record<string, string>) => i18n.t(key, { ns: 'messaging', ...values })

const JOINED = ' 加入了群聊'
const TOPIC_OPENED = ' 开了话题:'
const SERVER_NAME_SEPARATOR = '、'

/** The topic row's actor and topic name, what a row with a link draws apart; null if content is not that sentence. */
export function topicOpenedParts(content: string): { lead: string; name: string } | null {
  const at = content.indexOf(TOPIC_OPENED)
  if (at < 0) return null
  return { lead: say('group.notice.topicOpened', { actor: content.slice(0, at) }), name: content.slice(at + TOPIC_OPENED.length) }
}

function memberManagedText(content: string): string {
  let m: RegExpMatchArray | null
  if ((m = content.match(/^(.*) 退出了群聊$/s))) return say('group.notice.left', { actor: m[1]! })
  if ((m = content.match(/^(.*) 将 (.*) 移出了群聊$/s))) return say('group.notice.removed', { actor: m[1]!, target: m[2]! })
  if ((m = content.match(/^(.*) 将 (.*) 设为管理员$/s))) return say('group.notice.madeAdmin', { actor: m[1]!, target: m[2]! })
  if ((m = content.match(/^(.*) 撤销了 (.*) 的管理员身份$/s))) return say('group.notice.revokedAdmin', { actor: m[1]!, target: m[2]! })
  return content
}

export function systemNoticeText(notice: SystemNotice | null, content: string): string {
  switch (notice?.kind) {
    case 'turn-failure':
      return agentFailureText(notice.reason)
    case 'agent-flood':
      return content.startsWith('这条话题') ? say('group.notice.agentFloodTopic') : say('group.notice.agentFloodGroup')
    case 'member-joined': {
      const names = content.endsWith(JOINED) ? content.slice(0, -JOINED.length) : content
      return names.split(SERVER_NAME_SEPARATOR).join(say('group.memberJoined.separator')) + say('group.memberJoined.joined')
    }
    case 'topic-opened': {
      const parts = topicOpenedParts(content)
      return parts ? parts.lead + parts.name : content
    }
    case 'member-managed':
      return memberManagedText(content)
    default:
      return content
  }
}

/** The chat list's last-message line: a system row in the viewer's language, anything else its stored preview. */
export function chatPreviewText(chat: Pick<ChatItem, 'last_message_preview' | 'last_message_notice'>): string {
  return chat.last_message_notice ? systemNoticeText(chat.last_message_notice, chat.last_message_preview ?? '')
    : markdownPlainText(displayAgentReferences(chat.last_message_preview ?? '', (_id, label) => `@${label}`))
}
