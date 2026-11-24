import { ClosureV2HttpFailure, type ClosureV2Auth } from './v2-http'
/** Project the existing native Auth mirror; never refresh or ask renderer here. */
export function closureV2Auth(auth: { userId: string; accessToken: string } | 'lost' | null | undefined): ClosureV2Auth | null | undefined {
  if (auth === undefined) return undefined
  if (auth === null || auth === 'lost') return null
  try {
    const c = JSON.parse(Buffer.from(auth.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
    if (c.sub !== auth.userId || c.role !== 'authenticated' || typeof c.session_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(c.session_id)) throw Error()
    return { ownerId: auth.userId, sessionId: c.session_id, accessToken: auth.accessToken }
  } catch { throw new ClosureV2HttpFailure('unauthorized') }
}
