// @@@1397 群邀请分享链接 —— 纯逻辑,与组件分离(便于单测 + 满足 react-refresh)。
// 二维码和可粘贴的链接是同一条短链(qrPayload.ts 的 createGuguQrUrl,形态见那里的 @@@short-qr)。
import { createGroupInviteQrPayload, createGuguQrUrl } from '@gugu/core/shared/qrPayload'
import { isProjectGroupChat } from './groupMemberPermissions'

// public_id / join_token 缺失(未加载/无邀请权限)→ null,由调用方决定隐藏,不展示半成品死链接。
export function buildGroupInviteShareUrl(groupPublicId: number | null, joinToken: string | null): string | null {
  if (!groupPublicId || !joinToken) return null
  return createGuguQrUrl(createGroupInviteQrPayload(groupPublicId, joinToken))
}

/** The group's shareable link, or null where sharing is off: the switch is off, or a project group (gugu-dev#181). */
export function groupInviteLinkFor(chatId: string, settings: {
  invite_link_enabled: boolean
  public_id?: number | null
  join_token?: string | null
} | null): string | null {
  if (!settings?.invite_link_enabled || isProjectGroupChat(chatId)) return null
  return buildGroupInviteShareUrl(settings.public_id ?? null, settings.join_token ?? null)
}
