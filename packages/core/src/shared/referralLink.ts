/** A referral is distinct from a contact number and a group join token. */
export function normalizeReferralCode(value: string): string | null {
  const code = value.trim().toUpperCase()
  return /^[A-F0-9]{12}$/.test(code) ? code : null
}

export function createReferralLink(value: string, channel: 'stable' | 'beta' = 'stable'): string {
  const code = normalizeReferralCode(value)
  if (!code) throw new Error('Invalid personal referral code')
  return `https://gugu.nextmind.space/j/?r=${code}${channel === 'beta' ? '&channel=beta' : ''}`
}

/** Use the running host's scheme: a built renderer can still be launched from source. */
export async function createReferralLinkForApp(value: string, readAppCallback?: () => Promise<string>): Promise<string> {
  const callback = await readAppCallback?.()
  return createReferralLink(value, callback && new URL(callback).protocol === 'gugu-beta:' ? 'beta' : 'stable')
}

export function parseReferralLink(value: string): string | null {
  try {
    const url = new URL(value)
    if (!(url.protocol === 'https:' || /^gugu(?:-beta|-dev)?:$/.test(url.protocol)) || url.hostname !== 'gugu.nextmind.space'
      || !/^\/j\/?$/.test(url.pathname) || [...url.searchParams.keys()].some(key => key !== 'r' && key !== 'channel')
      || url.searchParams.getAll('r').length !== 1) return null
    return normalizeReferralCode(url.searchParams.get('r') ?? '')
  } catch { return null }
}
