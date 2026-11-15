import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { i18n } from '@/i18n'
import { TeamApiProvider } from '@/features/team/context'
import { TeamAuthPane } from '@/features/team/TeamAuthPane'
import { createTeamInvitationInbox } from '@/features/team/invitation-state'
import { createTeamApi, type TeamRequest } from '@/features/team/api'
import { mockTeamApi, teamSignIn } from '../../../../../../../tests/fixtures/teamEdition'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

const auth = vi.hoisted(() => ({ accept: vi.fn(async () => undefined), begin: vi.fn(() => 41) }))
vi.mock('@/lib/sessionCoordinator', () => ({ sessionCoordinator: { beginInteractiveLogin: auth.begin, acceptInteractiveSession: auth.accept } }))
let harness: ReturnType<typeof createReactHarness>
const token = 'synthetic_capability_'.repeat(3)
beforeEach(async () => { await page.viewport(1440, 960); await i18n.changeLanguage('zh-CN'); auth.accept.mockClear() })
afterEach(() => harness?.cleanup())
async function mount(linkRegion: 'cn' | 'hk', info: unknown, accepted?: unknown) {
  let receive!: (raw: string) => void
  const inbox = createTeamInvitationInbox(next => { receive = next; return () => {} }); inbox.start()
  receive(`gugu-beta://team/invite?region=${linkRegion}#invitation_token=${token}`)
  const fixture = mockTeamApi()
  const transport = vi.fn(async (request: TeamRequest) => {
    switch (request.action) {
      case 'invitation_info': return info
      case 'email_challenge': return { ok: true, data: await fixture.challenge({ email: 'member@example.test', purpose: 'accept_invitation' }) }
      case 'email_verify': return { ok: true, data: await fixture.verify('challenge-fixture', '123456') }
      case 'accept_invitation': return accepted ?? { ok: true, data: { ...teamSignIn(), context: { ...teamSignIn().context, region: linkRegion } } }
      default: throw new Error('Unexpected invitation action')
    }
  })
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamApiProvider api={createTeamApi(transport)}>
    <TeamAuthPane googleEnabled={false} onPersonal={vi.fn()} invitationLink={inbox.readLink()} />
  </TeamApiProvider>, { auth: null })
  return transport
}
it.each(['cn', 'hk'] as const)('carries %s from the opened deep link to region validation, email proof and independent session installation', async region => {
  const info = { ...await mockTeamApi().invitationInfo(token), region }
  const transport = await mount(region, { ok: true, data: info })
  await until('the verified regional invitation is ready', () => !!harness.container.querySelector('input[type="email"]'))
  expect(transport.mock.calls[0][0]).toMatchObject({ action: 'invitation_info', body: { invitation_token: token } })
  expect(transport.mock.calls[0][0].body).not.toHaveProperty('region')
  expect(harness.container.textContent).not.toContain(token)
  await userEvent.fill(page.getByRole('textbox', { name: '邮箱', exact: true }), 'member@example.test')
  await userEvent.click(page.getByRole('button', { name: '继续', exact: true }))
  await until('the invited email proof step opens', () => !!harness.container.querySelector('input[autocomplete="one-time-code"]'))
  await userEvent.fill(page.getByRole('textbox', { name: '验证码' }), '123456')
  await userEvent.click(page.getByRole('button', { name: '加入团队', exact: true }))
  await until('the independently verified team session is accepted', () => auth.accept.mock.calls.length === 1)
  expect(transport.mock.calls.map(([request]) => request.action)).toEqual(['invitation_info', 'email_challenge', 'email_verify', 'accept_invitation'])
  expect(transport.mock.calls[1][0].body).toEqual({ email: 'member@example.test', purpose: 'accept_invitation', invitation_token: token })
})
it.each([
  ['cn', 'hk'], ['hk', 'cn'],
] as const)('blocks both click and form submission for a %s link when the authority says %s', async (linkRegion, serverRegion) => {
  const transport = await mount(linkRegion, { ok: true, data: { ...await mockTeamApi().invitationInfo(token), region: serverRegion } })
  await until('the region mismatch is visible', () => harness.container.textContent?.includes('请在所属区域登录团队账号。') === true)
  await blocked(transport)
})
it.each([
  [{ ok: false, status: 404, error: { code: 'invitation_invalid' } }, '邀请无效或已过期，请联系管理员。'],
  [{ ok: false, status: 503, error: { code: 'dependency_unavailable' } }, '暂时不可用'],
  [{ ok: true, data: { region: 'other', state: 'invited' } }, '数据'],
] as const)('does not send proof or accept after an unverified response %#', async (response, copy) => {
  const transport = await mount('cn', response)
  await until('the failed read is displayed', () => !!harness.container.querySelector('[role="alert"]'))
  expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain(copy)
  expect(harness.container.textContent).not.toContain('请在所属区域登录团队账号。')
  await blocked(transport)
})
async function blocked(transport: ReturnType<typeof vi.fn<(request: TeamRequest) => Promise<unknown>>>) {
  await expect.element(page.getByRole('button', { name: '继续', exact: true })).toBeDisabled()
  await userEvent.fill(page.getByRole('textbox', { name: '邮箱', exact: true }), 'member@example.test')
  harness.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(transport.mock.calls.map(([request]) => request.action)).toEqual(['invitation_info'])
  expect(auth.accept).not.toHaveBeenCalled()
}
it('keeps a failed network read unverified and never advances to proof or acceptance', async () => {
  let reject!: (cause: Error) => void
  const pending = new Promise((_resolve, fail) => { reject = fail })
  const transport = await mount('hk', pending)
  expect(harness.container.querySelector('form')).toBeNull()
  reject(new Error('synthetic network failure'))
  await until('the network failure is visible', () => !!harness.container.querySelector('[role="alert"]'))
  await blocked(transport)
})
it('independently honors a final provision region refusal after successful summary and email proof', async () => {
  const transport = await mount('cn', { ok: true, data: await mockTeamApi().invitationInfo(token) },
    { ok: false, status: 403, error: { code: 'region_mismatch' } })
  await until('the successful summary opens the form', () => !!harness.container.querySelector('input[type="email"]'))
  await userEvent.fill(page.getByRole('textbox', { name: '邮箱', exact: true }), 'member@example.test')
  await userEvent.click(page.getByRole('button', { name: '继续', exact: true }))
  await until('the proof code input opens', () => !!harness.container.querySelector('input[autocomplete="one-time-code"]'))
  await userEvent.fill(page.getByRole('textbox', { name: '验证码' }), '123456')
  await userEvent.click(page.getByRole('button', { name: '加入团队', exact: true }))
  await until('provision refuses the region', () => harness.container.textContent?.includes('请在所属区域登录团队账号。') === true)
  expect(transport.mock.calls.map(([request]) => request.action)).toEqual(['invitation_info', 'email_challenge', 'email_verify', 'accept_invitation'])
  expect(auth.accept).not.toHaveBeenCalled()
})
