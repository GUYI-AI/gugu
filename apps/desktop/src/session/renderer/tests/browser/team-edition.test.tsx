import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { i18n } from '@/i18n'
import { AuthContext } from '@/store/auth'
import { TeamApiProvider, TeamProvider, TeamAccessGate } from '@/features/team/context'
import { TeamPage } from '@/features/team/TeamPage'
import { TeamAuthPane } from '@/features/team/TeamAuthPane'
import { TeamAccountMethods } from '@/features/team/TeamAccount'
import { TeamApiError } from '@/features/team/errors'
import type { TeamApi, TeamRole } from '@/features/team/types'
import { mockTeamApi, teamProfile, teamSignIn, teamUser } from '../../../../../../../tests/fixtures/teamEdition'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/features/team/team.css'

const auth = vi.hoisted(() => ({ accept: vi.fn(async () => undefined), begin: vi.fn(() => 41) }))
vi.mock('@/lib/sessionCoordinator', () => ({ sessionCoordinator: { beginInteractiveLogin: auth.begin, acceptInteractiveSession: auth.accept } }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await page.viewport(1440, 960); document.documentElement.setAttribute('data-theme', 'light'); await i18n.changeLanguage('zh-CN'); auth.accept.mockClear(); auth.begin.mockClear()
  for (const key of Object.keys(localStorage)) if (key.startsWith('gugu:team-disable:v1:team-ming:team-person-lin:')) localStorage.removeItem(key)
})
afterEach(() => harness?.cleanup())
const click = (name: string) => userEvent.click(page.getByRole('button', { name, exact: true }))
async function capture(name: string) {
  if (import.meta.env.VITE_TEAM_CAPTURE === '1') await page.screenshot({ path: `__screenshots__/team-desktop-${name}.png` })
}
async function mountTeam(role: TeamRole, api: TeamApi, node = <TeamPage onMessage={vi.fn()} onTopUp={vi.fn()} />) {
  harness = createReactHarness(); harness.container.style.cssText = 'height:900px;width:1300px;display:flex'
  await renderWithAppProviders(harness, <TeamProvider user={teamUser} api={api}><TeamAccessGate>{node}</TeamAccessGate></TeamProvider>, { auth: teamUser })
  await until('the verified team profile is ready', () => !!harness.container.querySelector('[data-testid="team-page"]') || harness.container.textContent?.includes('lin@example.test') === true)
}

it('lets a member use directory/search/usage while omitting every management section', async () => {
  const summary = vi.fn(), setCaps = vi.fn(), api = mockTeamApi('member', { summary, setCaps })
  await mountTeam('member', api)
  await capture('member-overview')
  expect(harness.container.textContent).not.toContain('成员管理')
  expect(harness.container.textContent).not.toContain('积分管理')
  await click('搜索成员')
  await userEvent.fill(page.getByRole('searchbox', { name: '搜索团队成员' }), '许澄')
  await until('member search returns the authorized person', () => harness.container.querySelectorAll('.gg-team-person-row').length === 1)
  expect(harness.container.textContent).toContain('许澄')
  expect(harness.container.textContent).not.toContain('共享资源')
  await click('我的用量')
  await until('my monthly usage is rendered', () => harness.container.textContent?.includes('74') === true)
  expect(harness.container.textContent).not.toContain('1,236')
  expect(harness.container.textContent).not.toContain('本周期')
  await capture('member-usage')
  expect(summary).not.toHaveBeenCalled(); expect(setCaps).not.toHaveBeenCalled()
  expect(harness.container.textContent).not.toContain('·')
})

it('edits an exact decimal monthly cap using cap_revision rather than membership revision', async () => {
  const api = mockTeamApi('admin'), setCaps = vi.fn(api.setCaps)
  await mountTeam('admin', { ...api, setCaps })
  await click('积分管理')
  await until('the financial rows include disabled members', () => harness.container.querySelectorAll('.gg-team-cap-row').length === 4)
  await capture('admin-credits')
  await userEvent.click(harness.container.querySelector<HTMLButtonElement>('.gg-team-cap-row button:last-child')!)
  await userEvent.fill(page.getByRole('textbox', { name: '上限积分' }), '150.25')
  await capture('monthly-cap')
  await click('保存')
  await until('the cap command is sent', () => setCaps.mock.calls.length === 1)
  expect(setCaps.mock.calls[0][0]).toEqual([{ member_id: 'member-lin', cap_credits: '150.25', expected_revision: 17 }])
  expect(setCaps.mock.calls[0][0][0].expected_revision).not.toBe(93)
  await until('the saved cap is read back', () => harness.container.querySelector('.gg-team-cap-row')?.textContent?.includes('150.25') === true)
})

it('sets an optional cap for a selected batch with one command', async () => {
  const api = mockTeamApi('superadmin'), setCaps = vi.fn(api.setCaps)
  await mountTeam('superadmin', { ...api, setCaps })
  await click('积分管理')
  await until('the member selection loads', () => harness.container.querySelectorAll('.gg-team-cap-row').length === 4)
  await userEvent.click(page.getByRole('checkbox', { name: '全选' }))
  await click('批量设置上限'); await click('保存')
  await until('the atomic batch is submitted', () => setCaps.mock.calls.length === 1)
  expect(setCaps.mock.calls[0][0]).toHaveLength(4)
  expect(setCaps.mock.calls[0][0].every(row => row.cap_credits === null)).toBe(true)
})

it('keeps disablement pending until effective revocation is read back', async () => {
  const api = mockTeamApi('superadmin'), revocationResult = vi.fn(api.revocationResult)
    .mockResolvedValueOnce({ state: 'revoking', operation_id: 'revocation-fixture' })
  await mountTeam('superadmin', { ...api, revocationResult })
  await click('成员管理')
  await until('the management rows load', () => harness.container.querySelectorAll('.gg-team-person-row').length === 3)
  await userEvent.click(page.getByRole('button', { name: /许澄.*xu@example/ }))
  await click('停用并交接'); await click('停用并交接')
  await until('the pending result is visible', () => document.body.textContent?.includes('正在确认停用结果') === true)
  expect(document.body.textContent).not.toContain('已停用，交接已完成。')
  await click('重试')
  await until('effective revocation completes', () => document.body.textContent?.includes('已停用，交接已完成。') === true)
  expect(revocationResult).toHaveBeenCalledTimes(2)
  expect(revocationResult).toHaveBeenLastCalledWith('revocation-fixture')
})

it('replays the original disable request after a lost response and a component restart', async () => {
  const api = mockTeamApi('superadmin'), disable = vi.fn(api.disable)
    .mockImplementationOnce(async (...args) => { await api.disable(...args); throw new TypeError('Synthetic lost response') })
  await mountTeam('superadmin', { ...api, disable })
  await click('成员管理')
  await until('the active member loads', () => harness.container.querySelectorAll('.gg-team-person-row').length === 3)
  await userEvent.click(page.getByRole('button', { name: /许澄.*xu@example/ }))
  await click('停用并交接'); await click('停用并交接')
  await until('the lost response is reported', () => !!document.querySelector('[role="dialog"] [role="alert"]'))
  const original = disable.mock.calls[0]
  harness.cleanup()
  await mountTeam('superadmin', { ...api, disable })
  await click('成员管理'); await userEvent.click(page.getByRole('tab', { name: '已停用', exact: true }))
  await until('the changed member is loaded after restart', () => document.body.textContent?.includes('许澄') === true)
  await userEvent.click(page.getByRole('button', { name: /许澄.*xu@example/ }))
  expect([...document.querySelectorAll('button')].some(button => button.textContent === '恢复')).toBe(false)
  await click('查看停用进度')
  await capture('disable-recovery')
  await click('重试')
  await until('the original operation is verified', () => document.body.textContent?.includes('已停用，交接已完成。') === true)
  expect(disable.mock.calls[1]).toEqual(original)
  expect(original[2]).toBe(5)
})

it('allows only the current member to confirm a pending email change before signing out', async () => {
  const api = mockTeamApi(), confirmEmailChange = vi.fn(api.confirmEmailChange), logout = vi.fn(async () => ({ success: true }))
  harness = createReactHarness()
  await renderWithAppProviders(harness, <AuthContext.Provider value={{ user: teamUser, loading: false, status: 'authenticated', updateUser: vi.fn(), logout }}>
    <TeamProvider user={teamUser} api={{ ...api, confirmEmailChange, profile: async () => ({ ...teamProfile(), pending_email_change: { challenge_id: 'change-fixture', new_email: 'new@example.test', expires_at: '2099-01-01T00:00:00Z' } }) }}>
      <TeamAccessGate><TeamAccountMethods /></TeamAccessGate>
    </TeamProvider></AuthContext.Provider>, { auth: teamUser })
  await until('the pending member email is offered', () => harness.container.textContent?.includes('new@example.test') === true)
  await click('确认换邮箱'); await userEvent.fill(page.getByRole('textbox', { name: '验证码' }), '123456'); await click('确认换邮箱')
  await until('the actor confirms and signs out', () => logout.mock.calls.length === 1)
  expect(confirmEmailChange.mock.calls[0].slice(0, 2)).toEqual(['change-fixture', '123456'])
})

it('verifies email before creating a team and installs only the independent team session', async () => {
  const api = mockTeamApi(), create = vi.fn(api.create), verify = vi.fn(api.verify)
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamApiProvider api={{ ...api, create, verify }}><TeamAuthPane googleEnabled={false} onPersonal={vi.fn()} /></TeamApiProvider>, { auth: null })
  await userEvent.click(page.getByRole('tab', { name: '创建团队' }))
  await userEvent.fill(page.getByRole('textbox', { name: '团队名称' }), '测试团队')
  await userEvent.fill(page.getByRole('textbox', { name: '管理员邮箱' }), 'admin@example.test')
  await capture('create-team')
  await click('验证邮箱并创建')
  await until('the email code step opens', () => document.body.textContent?.includes('验证码已发送') === true)
  expect(create).not.toHaveBeenCalled(); expect(auth.accept).not.toHaveBeenCalled()
  await userEvent.fill(page.getByRole('textbox', { name: '验证码' }), '123456'); await click('验证并创建')
  await until('only the independent session is accepted', () => auth.accept.mock.calls.length === 1)
  expect(verify).toHaveBeenCalledWith('challenge-fixture', '123456')
  expect(create.mock.calls[0].slice(0, 2)).toEqual(['测试团队', 'receipt-fixture'])
  expect(auth.accept).toHaveBeenCalledWith(41, teamSignIn('superadmin').session)
  expect(harness.container.textContent).not.toMatch(/赠送|手机号|会员套餐|·/)
})

it('keeps verified team choices in the same login form and reuses the verified receipt once', async () => {
  const api = mockTeamApi(), verify = vi.fn(api.verify), signIn = vi.fn(api.signIn).mockRejectedValueOnce(new TeamApiError('context_required', 409, undefined, undefined,
    [{ team_id: 'team-ming', team_name: '明川研究院', role: 'member', member_state: 'active', region: 'cn' }]))
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamApiProvider api={{ ...api, signIn, verify }}><TeamAuthPane googleEnabled={false} onPersonal={vi.fn()} /></TeamApiProvider>, { auth: null })
  await userEvent.fill(page.getByRole('textbox', { name: '邮箱', exact: true }), 'lin@example.test'); await click('继续')
  await until('the verified-code field is available', () => !!harness.container.querySelector('input[autocomplete="one-time-code"]'))
  await userEvent.fill(page.getByRole('textbox', { name: '验证码' }), '123456'); await click('验证并登录')
  await until('verified team choices appear inline', () => document.body.textContent?.includes('请选择本次登录的团队') === true)
  await userEvent.click(page.getByRole('button', { name: /明川研究院.*成员/ }))
  await until('the chosen team session is accepted', () => auth.accept.mock.calls.length === 1)
  expect(verify).toHaveBeenCalledOnce(); expect(signIn).toHaveBeenLastCalledWith('receipt-fixture', 'team-ming')
})
