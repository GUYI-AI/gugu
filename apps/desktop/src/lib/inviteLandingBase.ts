/** Configured invitation web page. An installer download cannot accept a referral. */
export function webInviteLandingBase(): string | null {
  const raw = ((import.meta.env.VITE_GUGU_WEB_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')
  return raw ? `${raw}/invite` : null
}
