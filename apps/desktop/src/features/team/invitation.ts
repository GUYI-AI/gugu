import { platform } from '@/platform'
import { teamInvitationToken, isTeamInvitationLink } from '../../../shared/team-invitation-link'

let token: string | null = null, snapshot = { version: 0, pending: false, invalid: false }
const listeners = new Set<() => void>()
function publish(invalid = false) {
  snapshot = { version: snapshot.version + 1, pending: token !== null, invalid }
  for (const listener of listeners) listener()
}
export const teamInvitation = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  getSnapshot: () => snapshot,
  readToken: () => token,
  clear() { token = null; publish() },
  start() {
    return platform.watchOpenedLinks?.(raw => {
      if (!isTeamInvitationLink(raw)) return
      const next = teamInvitationToken(raw)
      if (next && next === token) return
      token = next; publish(!next)
    }, () => { if (token) { token = null; publish(true) } }) ?? (() => {})
  },
}
