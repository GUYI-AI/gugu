import { describe, expect, it, vi } from 'vitest'
import { parseTeamInvitationLink, isTeamInvitationLink } from '../../../apps/desktop/shared/team-invitation-link'
import { createTeamInvitationInbox } from '../../../apps/desktop/src/features/team/invitation-state'
import { readRegionalInvitation } from '../../../apps/desktop/src/features/team/invitation-region'
import { createTeamApi, type TeamRequest } from '../../../apps/desktop/src/features/team/api'
import { mockTeamApi } from '../../fixtures/teamEdition'

const token = 'aB_09-'.repeat(8)
const url = (region: string, scheme = 'gugu-beta') => `${scheme}://team/invite?region=${region}#invitation_token=${token}`

describe('team invitation capability and regional authority', () => {
  it.each(['gugu', 'gugu-beta', 'gugu-dev'])('accepts both deployed regional URL shapes for %s', scheme => {
    for (const region of ['cn', 'hk'] as const) expect(parseTeamInvitationLink(url(region, scheme))).toEqual({ token, region })
  })
  it.each([
    `gugu-beta://team/invite#invitation_token=${token}`,
    url('CN'), url('us'), url(''), url('cn&region=cn'), url('cn&region=hk'), url('cn&extra=1'),
    url('cn&invitation_token=leaked'), url('cn').replace('gugu-beta:', 'https:'),
    url('cn').replace('://team/', '://other/'), url('cn').replace('/invite?', '/wrong?'),
    url('cn').replace('://team/', '://name:password@team/'), url('cn').replace('://team/', '://team:123/'),
    url('cn').replace('://team/', '://team:invalid/'), url('cn').replace('://team/', '://%broken/'),
    url('cn').replace(token, 'short'), url('cn').replace(token, 'x'.repeat(257)),
    url('cn').replace(token, 'x'.repeat(43) + '%2F'), url('cn').replace(token, 'x'.repeat(43) + '%ZZ'),
    url('cn') + '&invitation_token=' + token, url('cn') + '&extra=1',
  ])('rejects malformed parameters without extracting a usable capability: %s', raw => {
    expect(parseTeamInvitationLink(raw)).toBeNull()
  })
  it('accepts backend token length bounds and decoded URI-safe values', () => {
    for (const length of [43, 256]) expect(parseTeamInvitationLink(url('hk').replace(token, 'a'.repeat(length)))?.token).toHaveLength(length)
    expect(parseTeamInvitationLink(url('cn').replace('region=cn', 'region=%63n'))?.region).toBe('cn')
  })
  it('keeps region through the opened-link inbox and deduplicates only the complete capability', () => {
    let receive!: (raw: string) => void
    const stop = vi.fn(), inbox = createTeamInvitationInbox(next => { receive = next; return stop })
    const unsubscribe = inbox.start()
    receive(url('cn')); const first = inbox.getSnapshot()
    expect(inbox.readLink()).toEqual({ token, region: 'cn' })
    expect(JSON.stringify(first)).not.toContain(token)
    receive(url('cn')); expect(inbox.getSnapshot()).toBe(first)
    receive(url('hk')); expect(inbox.readLink()?.region).toBe('hk')
    expect(inbox.getSnapshot().version).toBe(first.version + 1)
    inbox.clear(); expect(inbox.readLink()).toBeNull()
    unsubscribe(); expect(stop).toHaveBeenCalledOnce()
  })
  it('consumes malformed auth routes locally rather than forwarding their raw capability to extension diagnostics', () => {
    let receive!: (raw: string) => void
    const inbox = createTeamInvitationInbox(next => { receive = next; return () => {} }); inbox.start()
    for (const raw of [url('cn&region=hk'), url('cn').replace('://team/', '://team:123/'), url('cn').replace('://team/', '://team:invalid/'), url('cn').replace('://team/', '://%broken/'), url('cn').replace('://team/', '://other/')]) {
      expect(isTeamInvitationLink(raw)).toBe(true); receive(raw)
      expect(inbox.getSnapshot()).toMatchObject({ pending: false, invalid: true, errorCode: 'invalid_request' })
      expect(inbox.readLink()).toBeNull()
    }
  })
  it.each(['cn', 'hk'] as const)('compares %s against the successful configured-backend response without sending link region', async region => {
    let receive!: (raw: string) => void
    const inbox = createTeamInvitationInbox(next => { receive = next; return () => {} }); inbox.start(); receive(url(region))
    const data = { ...await mockTeamApi().invitationInfo(token), region }
    const transport = vi.fn(async (_request: TeamRequest) => ({ ok: true, data }))
    expect((await readRegionalInvitation(createTeamApi(transport), inbox.readLink()!)).region).toBe(region)
    expect(transport).toHaveBeenCalledExactlyOnceWith({ endpoint: 'team-accounts', action: 'invitation_info', method: 'POST', body: { invitation_token: token }, signal: undefined })
  })
  it.each([['cn', 'hk'], ['hk', 'cn']] as const)('rejects link %s against authoritative %s locally, without a fabricated HTTP status', async (linkRegion, serverRegion) => {
    const api = createTeamApi(async () => ({ ok: true, data: { ...await mockTeamApi().invitationInfo(token), region: serverRegion } }))
    await expect(readRegionalInvitation(api, parseTeamInvitationLink(url(linkRegion))!)).rejects.toMatchObject({ code: 'region_mismatch', status: undefined })
  })
  it.each([[404, 'invitation_invalid'], [503, 'dependency_unavailable'], [403, 'region_mismatch']] as const)('preserves the real %s refusal %s', async (status, code) => {
    const transport = vi.fn(async () => ({ ok: false, status, error: { code } }))
    await expect(readRegionalInvitation(createTeamApi(transport), parseTeamInvitationLink(url('cn'))!)).rejects.toMatchObject({ code, status })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('never treats malformed successful region data as verified', async () => {
    const api = createTeamApi(async () => ({ ok: true, data: { ...await mockTeamApi().invitationInfo(token), region: 'unknown' } }))
    await expect(readRegionalInvitation(api, parseTeamInvitationLink(url('cn'))!)).rejects.toMatchObject({ code: 'invalid_response' })
  })
})
