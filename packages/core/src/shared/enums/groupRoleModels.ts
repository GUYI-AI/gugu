import type { GroupMemberRole, GroupMemberRoleInput } from '../types/chat'

export function normalizeGroupRole(role: GroupMemberRoleInput | string | null | undefined): GroupMemberRole {
  const normalized = typeof role === 'string' ? role.toLowerCase() : ''
  if (normalized === 'owner') return 'owner'
  if (normalized === 'admin') return 'admin'
  return 'member'
}
