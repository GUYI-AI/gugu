/** A routing hint only. Server-side Auth and current membership still authorize every team call. */
export function teamAccountTokenHint(token: string): 'personal' | 'team' | 'unknown' {
  try {
    const encoded = token.split('.')[1]
    if (!encoded) return 'personal' // Existing local/legacy providers have no team marker.
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    const row = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), value => value.charCodeAt(0))))
    const kind = row?.app_metadata?.gugu_account_kind
    if (kind === undefined || kind === null || kind === 'personal') return 'personal'
    return kind === 'team_member' ? 'team' : 'unknown'
  } catch { return 'unknown' }
}
