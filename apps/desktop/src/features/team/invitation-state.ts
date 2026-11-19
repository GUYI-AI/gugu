import { parseTeamInvitationLink, isTeamInvitationLink, type TeamInvitationLink } from '../../../shared/team-invitation-link'

type WatchLinks = (receive: (raw: string) => void, overflow: () => void) => (() => void) | undefined

/** Capability and region stay together in memory; snapshots contain neither the token nor raw URL. */
export function createTeamInvitationInbox(watch: WatchLinks) {
  let link: TeamInvitationLink | null = null
  let snapshot = { version: 0, pending: false, invalid: false, errorCode: null as 'invalid_request' | null }
  const listeners = new Set<() => void>()
  function publish(invalid = false) {
    snapshot = { version: snapshot.version + 1, pending: link !== null, invalid, errorCode: invalid ? 'invalid_request' : null }
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    readLink: () => link,
    clear() { link = null; publish() },
    start() {
      return watch(raw => {
        if (!isTeamInvitationLink(raw)) return
        const next = parseTeamInvitationLink(raw)
        if (next && next.token === link?.token && next.region === link.region) return
        link = next; publish(!next)
      }, () => { if (link) { link = null; publish(true) } }) ?? (() => {})
    },
  }
}
