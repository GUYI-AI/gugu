const SCHEMES = new Set(['gugu:', 'gugu-beta:', 'gugu-dev:'])

/** An invitation is an auth input, never an extension navigation URL. Do not log raw URLs. */
export function teamInvitationToken(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!SCHEMES.has(url.protocol) || url.host !== 'team' || url.pathname !== '/invite'
      || url.username || url.password || url.search) return null
    const fragment = new URLSearchParams(url.hash.slice(1)), tokens = fragment.getAll('invitation_token')
    if ([...fragment.keys()].length !== 1 || tokens.length !== 1 || !tokens[0] || tokens[0].length > 8192) return null
    return tokens[0]
  } catch { return null }
}
export function isTeamInvitationLink(raw: string): boolean {
  try { const url = new URL(raw); return SCHEMES.has(url.protocol) && url.host === 'team' && url.pathname === '/invite' }
  catch { return false }
}
