import { platform } from '@/platform'
import { createTeamInvitationInbox } from './invitation-state'

export const teamInvitation = createTeamInvitationInbox((receive, overflow) => platform.watchOpenedLinks?.(receive, overflow))
