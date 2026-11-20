import type { TeamInvitationLink } from '../../../shared/team-invitation-link'
import type { TeamApi } from './types'
import { TeamApiError } from './errors'

/** The configured backend's successful read is authoritative. Never infer a region from a 404 or hostname. */
export async function readRegionalInvitation(api: Pick<TeamApi, 'invitationInfo'>, link: TeamInvitationLink) {
  const info = await api.invitationInfo(link.token)
  if (info.region !== 'cn' && info.region !== 'hk') throw new TeamApiError('invalid_response')
  if (info.region !== link.region) throw new TeamApiError('region_mismatch')
  return info
}
