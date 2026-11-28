import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { createGroupWebhooks, groupWebhookUrl as webhookUrlAt, type GroupWebhook, type GroupWebhooks } from '@gugu/core/cloud/groupWebhooks'
import { chatDb, getCurrentAuthUserId } from './supabase'

export { GROUP_WEBHOOK_NAME_MAX, GROUP_WEBHOOK_TARGET_MAX, type GroupWebhook } from '@gugu/core/cloud/groupWebhooks'

// #3934 群 Webhook 在 App 里:以已登录的人自己的身份调(gugu-supabase #420 的六个函数自己判权限)。
export async function currentGroupWebhooks(): Promise<GroupWebhooks> {
  return createGroupWebhooks(chatDb, await getCurrentAuthUserId())
}

export function groupWebhookUrl(token: string): string {
  return webhookUrlAt(getSupabaseUrl(), token)
}

/** A current member of the group, one a webhook can point at. */
export type WebhookMember = { id: string; type: 'human' | 'agent' }

/** What the target picker starts from: the targets still in the group (the database refuses anyone else). */
export function pickableTargets(hook: GroupWebhook, members: readonly WebhookMember[]): string[] {
  const present = new Set(members.map((member) => member.id))
  return hook.targetUserIds.filter((id) => present.has(id))
}
