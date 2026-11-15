const SCHEMES = new Set(['gugu:', 'gugu-beta:', 'gugu-dev:'])
export interface TeamInvitationLink { readonly token: string; readonly region: 'cn' | 'hk' }

/** An invitation is an auth input, never an extension navigation URL. Do not log raw URLs. */
export function parseTeamInvitationLink(raw: string): TeamInvitationLink | null {
  try {
    const url = new URL(raw)
    if (!SCHEMES.has(url.protocol) || url.host !== 'team' || url.pathname !== '/invite'
      || url.username || url.password || url.port) return null
    const regions = url.searchParams.getAll('region')
    if ([...url.searchParams.keys()].length !== 1 || regions.length !== 1
      || (regions[0] !== 'cn' && regions[0] !== 'hk')) return null
    const fragment = new URLSearchParams(url.hash.slice(1)), tokens = fragment.getAll('invitation_token')
    if ([...fragment.keys()].length !== 1 || tokens.length !== 1 || !/^[A-Za-z0-9_-]{43,256}$/.test(tokens[0])) return null
    return Object.freeze({ token: tokens[0], region: regions[0] })
  } catch { return null }
}
export function isTeamInvitationLink(raw: string): boolean {
  if (!SCHEMES.has(raw.slice(0, raw.indexOf(':') + 1))) return false
  // Recognize the capability even when an invalid authority/port makes URL parsing fail.
  const hash = raw.indexOf('#')
  if (hash !== -1 && new URLSearchParams(raw.slice(hash + 1)).has('invitation_token')) return true
  try {
    const url = new URL(raw)
    // Reserve malformed auth inputs too, so a capability cannot fall through to extension URL diagnostics.
    return url.hostname === 'team' && url.pathname === '/invite'
  }
  catch { return false }
}
