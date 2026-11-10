// @@@1397 群邀请分享链接 —— 纯逻辑,与组件分离(便于单测 + 满足 react-refresh)。
// 二维码和可粘贴的链接是同一条短链(qrPayload.ts 的 createGuguQrUrl,形态见那里的 @@@short-qr)。
import { createGroupInviteQrPayload, createGuguQrUrl } from '@gugu/core/shared/qrPayload'

// public_id / join_token 缺失(未加载/无邀请权限)→ null,由调用方决定隐藏,不展示半成品死链接。
export function buildGroupInviteShareUrl(groupPublicId: number | null, joinToken: string | null): string | null {
  if (!groupPublicId || !joinToken) return null
  return createGuguQrUrl(createGroupInviteQrPayload(groupPublicId, joinToken))
}
