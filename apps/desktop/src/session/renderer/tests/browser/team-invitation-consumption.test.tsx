import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { page, userEvent } from 'vitest/browser'
import { TeamApiProvider } from '@/features/team/context'
import { TeamAuthPane } from '@/features/team/TeamAuthPane'
import { TeamInvitationHandoff } from '@/features/team/TeamInvitationHandoff'
import { teamInvitation } from '@/features/team/invitation'
import { mockTeamApi, teamSignIn } from '../../../../../../../tests/fixtures/teamEdition'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'

const auth = vi.hoisted(() => ({ accept: vi.fn(), snapshot: vi.fn(), receive: null as null | ((link: string) => void) }))
vi.mock('@/lib/sessionCoordinator', () => ({ sessionCoordinator: { beginInteractiveLogin: () => 41, acceptInteractiveSession: auth.accept, getSnapshot: auth.snapshot } }))
vi.mock('@/features/team/invitation', async () => {
  const { createTeamInvitationInbox } = await import('@/features/team/invitation-state')
  const inbox = createTeamInvitationInbox(receive => { auth.receive = receive; return () => {} }); inbox.start()
  return { teamInvitation: inbox }
})
let harness: ReturnType<typeof createReactHarness>
const token = 'a'.repeat(64), nextToken = 'b'.repeat(64)
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN'); await page.viewport(1100, 900)
  auth.accept.mockReset(); auth.snapshot.mockReset(); teamInvitation.clear()
  auth.receive!(`gugu-dev://team/invite?region=cn#invitation_token=${token}`)
})
afterEach(() => { harness?.cleanup(); teamInvitation.clear() })
async function mount(install: 'accepted' | 'ignored' | 'new-invitation') {
  function AppBoundary() {
    const [signedIn, setSignedIn] = useState(false)
    auth.accept.mockImplementation(async () => {
      if (install === 'new-invitation') auth.receive!(`gugu-dev://team/invite?region=cn#invitation_token=${nextToken}`)
      if (install !== 'ignored') setSignedIn(true)
    })
    return signedIn ? <><span>团队已登录</span><TeamInvitationHandoff /></>
      : <TeamAuthPane googleEnabled={false} onPersonal={vi.fn()} invitationLink={teamInvitation.readLink()} />
  }
  auth.snapshot.mockImplementation(() => install === 'ignored' ? { status: 'anonymous', session: null }
    : { status: 'authenticated', session: teamSignIn().session })
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamApiProvider api={mockTeamApi()}><AppBoundary /></TeamApiProvider>, { auth: null })
  await until('the invited team is verified', () => document.body.textContent?.includes('明川研究院') === true)
  await userEvent.fill(page.getByRole('textbox', { name: '邮箱', exact: true }), 'lin@example.test')
  await userEvent.click(page.getByRole('button', { name: '继续', exact: true }))
  await until('email proof is requested', () => !!document.querySelector('input[autocomplete=one-time-code]'))
  await userEvent.fill(page.getByRole('textbox', { name: '验证码' }), '123456')
  await userEvent.click(page.getByRole('button', { name: '加入团队', exact: true }))
}
it('consumes the accepted invitation so successful sign-in does not reopen the account-switch dialog', async () => {
  await mount('accepted')
  await until('the signed-in app has consumed this invitation', () => document.body.textContent?.includes('团队已登录') === true && !teamInvitation.getSnapshot().pending)
  expect(page.getByRole('button', { name: '切换账号', exact: true }).query()).toBeNull()
  expect(teamInvitation.readLink()).toBeNull()
})
it('retains the invitation when a stale session-install attempt was ignored', async () => {
  await mount('ignored'); await until('the coordinator considered the attempt', () => auth.snapshot.mock.calls.length > 0)
  expect(teamInvitation.getSnapshot().pending).toBe(true); expect(teamInvitation.readLink()?.token === token).toBe(true)
})
it('preserves a newer invitation arriving while the previous session is installed', async () => {
  await mount('new-invitation'); await until('the prior session reaches the app', () => document.body.textContent?.includes('团队已登录') === true)
  expect(teamInvitation.getSnapshot().pending).toBe(true); expect(teamInvitation.readLink()?.token === nextToken).toBe(true)
  expect(page.getByRole('button', { name: '切换账号', exact: true }).query()).not.toBeNull()
})
