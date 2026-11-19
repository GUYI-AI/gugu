import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { page, userEvent } from 'vitest/browser'
import { i18n } from '@/i18n'
import { AuthContext } from '@/store/auth'
import { TeamApiProvider, TeamProvider, TeamAccessGate } from '@/features/team/context'
import { TeamPage } from '@/features/team/TeamPage'
import { TeamAuthPane } from '@/features/team/TeamAuthPane'
import { TeamAccountMembership, TeamAccountMethods } from '@/features/team/TeamAccount'
import { TeamApiError } from '@/features/team/errors'
import type { TeamApi, TeamRole, TeamDirectoryUsageMember } from '@/features/team/types'
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
async function mountTeam(role: TeamRole, api: TeamApi, node = <TeamPage onTopUp={vi.fn()} />) {
  harness = createReactHarness(); harness.container.style.cssText = 'height:900px;width:1300px;display:flex'
  await renderWithAppProviders(harness, <TeamProvider user={teamUser} api={api}><TeamAccessGate>{node}</TeamAccessGate></TeamProvider>, { auth: teamUser })
  await until('the verified team product is ready', () => !harness.container.querySelector('.gg-team-access-blocker') && Boolean(harness.container.textContent?.trim()))
}

it('shows Gugu IDs and searches names or exact IDs while omitting emails and management for ordinary members', async () => {
  const base = mockTeamApi('member'), directorySummary = vi.fn(base.directorySummary), summary = vi.fn(), setCaps = vi.fn()
  await mountTeam('member', { ...base, directorySummary, summary, setCaps })
  await until('the permitted member rows load', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 3)
  expect(harness.container.querySelector('.gg-team-nav')).toBeNull()
  expect(harness.container.textContent).not.toContain('成员账户管理')
  expect(harness.container.textContent).not.toContain('添加成员')
  expect(harness.container.textContent).not.toContain('充值')
  expect(harness.container.textContent).not.toContain('xu@example.test')
  expect(harness.container.textContent).toContain('1,236')
  await userEvent.fill(page.getByRole('searchbox', { name: '搜索名字或咕咕号' }), '许澄')
  await until('name search reaches the complete permitted directory', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 1)
  expect(directorySummary.mock.calls.at(-1)?.[0]?.query).toBe('许澄')
  expect(harness.container.textContent).toContain('许澄')
  expect(harness.container.textContent).toContain('咕咕号 635814')
  await userEvent.fill(page.getByRole('searchbox', { name: '搜索名字或咕咕号' }), '635813')
  await until('exact Gugu ID finds the permitted peer', () => Boolean(harness.container.textContent?.includes('周宁')) && !harness.container.textContent?.includes('许澄'))
  expect(harness.container.textContent).toContain('咕咕号 635813')
  await userEvent.fill(page.getByRole('searchbox', { name: '搜索名字或咕咕号' }), 'xu@example.test')
  await until('email-only queries do not discover members', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 0)
  expect(harness.container.textContent).not.toContain('共享资源')
  expect(harness.container.textContent).not.toContain('本周期')
  expect(harness.container.textContent).not.toContain('·')
  expect(summary).not.toHaveBeenCalled(); expect(setCaps).not.toHaveBeenCalled()
  await capture('member-settings')
})

it('loads and searches a 128-person team while keeping the summary above the member scroll area', async () => {
  const base = mockTeamApi('admin'), first = await base.directorySummary()
  const people: TeamDirectoryUsageMember[] = Array.from({ length: 128 }, (_, index) => ({ ...first.members[0],
    id: `membership-${index}`, identity_id: `person-${index}`, name: `成员 ${index}`, email: `member-${index}@example.test` }))
  const directorySummary = vi.fn(async (input: Parameters<TeamApi['directorySummary']>[0]) => {
    const query = input?.query?.toLowerCase(), matched = people.filter(person => !query || person.name.includes(query) || person.email?.includes(query))
    const start = input?.cursor ? matched.findIndex(person => person.id === input.cursor) + 1 : 0
    const members = matched.slice(start, start + (input?.limit ?? 50))
    return { ...first, total_count: 128, matching_count: matched.length, members,
      next_cursor: start + members.length < matched.length ? members.at(-1)!.id : null }
  })
  await mountTeam('admin', { ...base, directorySummary })
  await until('the first bounded page loads', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 50)
  const list = harness.container.querySelector<HTMLDivElement>('.gg-team-settings-list')!
  const heading = harness.container.querySelector('.gg-team-settings-summary')!
  const before = heading.getBoundingClientRect().top
  list.scrollTop = list.scrollHeight
  list.dispatchEvent(new Event('scroll', { bubbles: true }))
  await until('the next page is appended', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 100)
  expect(heading.getBoundingClientRect().top).toBe(before)
  expect(directorySummary.mock.calls.some(([input]) => input?.cursor === 'membership-49')).toBe(true)
  await userEvent.fill(page.getByRole('searchbox', { name: '搜索名字、咕咕号或邮箱' }), 'member-127@')
  await until('search reaches the member beyond loaded pages', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 1)
  expect(harness.container.textContent).toContain('成员 127')
  expect(harness.container.textContent).toContain('member-127@example.test')
  expect(harness.container.querySelector('.gg-team-nav')).toBeNull()
})

it('blocks a restored team context for another principal before loading any product data', async () => {
  const api = mockTeamApi(), directorySummary = vi.fn(api.directorySummary)
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamProvider user={teamUser} api={{ ...api, directorySummary,
    context: async () => ({ ...await api.context(), member_identity_id: 'another-principal' }) }}>
    <TeamAccessGate><TeamPage onTopUp={vi.fn()} /></TeamAccessGate>
  </TeamProvider>, { auth: teamUser })
  await until('the restored identity mismatch is blocked', () => !!harness.container.querySelector('.gg-team-access-blocker[role="alert"]'))
  expect(harness.container.querySelector('[data-testid="team-page"]')).toBeNull()
  expect(directorySummary).not.toHaveBeenCalled()
})

it('shows the team and role above the real account email as separate elements', async () => {
  await mountTeam('admin', mockTeamApi('admin'), <div><TeamAccountMembership /><TeamAccountMethods /></div>)
  expect(harness.container.querySelector('.gg-team-account-role')?.textContent).toBe('管理员')
  expect(harness.container.textContent).toContain('明川研究院')
  expect(harness.container.textContent).toContain('lin@example.test')
  expect(harness.container.textContent).not.toContain('·')
  await capture('account-team-row')
})

it('projects verified display details once and preserves a later saved self edit', async () => {
  const api = mockTeamApi(), logout = vi.fn(async () => ({ success: true }))
  function StatefulAccount() {
    const [user, updateUser] = useState({ ...teamUser, email: 'internal-routing@example.test' })
    return <AuthContext.Provider value={{ user, updateUser, logout, loading: false, status: 'authenticated' }}>
      <TeamProvider user={user} api={api}><TeamAccessGate>
        <output data-testid="display-profile">{user.nickname} {user.email} {user.bio}</output>
        <button onClick={() => updateUser({ ...user, nickname: '林晓的新名称', bio: '新的简介' })}>保存个人资料</button>
      </TeamAccessGate></TeamProvider>
    </AuthContext.Provider>
  }
  harness = createReactHarness()
  await renderWithAppProviders(harness, <StatefulAccount />)
  await until('the verified visible email replaces the internal routing email', () => harness.container.querySelector('output')?.textContent?.includes('lin@example.test') === true)
  expect(harness.container.textContent).not.toContain('internal-routing@example.test')
  await click('保存个人资料')
  await until('the saved name remains after the account render', () => harness.container.querySelector('output')?.textContent?.includes('林晓的新名称') === true)
  expect(harness.container.querySelector('output')?.textContent).toContain('新的简介')
})

it('edits an exact decimal monthly cap using cap_revision rather than membership revision', async () => {
  const api = mockTeamApi('admin'), setCaps = vi.fn(api.setCaps)
  await mountTeam('admin', { ...api, setCaps })
  await until('the current member credit rows load', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 3)
  await click('管理林晓')
  await click('设置成员上限')
  await capture('admin-credits')
  await userEvent.fill(page.getByRole('textbox', { name: '上限积分' }), '150.25')
  await capture('monthly-cap')
  await click('保存')
  await until('the cap command is sent', () => setCaps.mock.calls.length === 1)
  expect(setCaps.mock.calls[0][0]).toEqual([{ member_id: 'member-lin', cap_credits: '150.25', expected_revision: 17 }])
  expect(setCaps.mock.calls[0][0][0].expected_revision).not.toBe(93)
  await until('the saved cap is read back', () => harness.container.querySelector('.gg-team-settings-member')?.textContent?.includes('150.25') === true)
})

it('sets an optional cap for a selected batch with one command', async () => {
  const api = mockTeamApi('superadmin'), setCaps = vi.fn(api.setCaps)
  await mountTeam('superadmin', { ...api, setCaps })
  await until('the member selection loads', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 3)
  await click('批量设置上限')
  await userEvent.click(page.getByRole('checkbox', { name: '选择已加载成员' }))
  await click('设置成员上限'); await click('保存')
  await until('the atomic batch is submitted', () => setCaps.mock.calls.length === 1)
  expect(setCaps.mock.calls[0][0]).toHaveLength(3)
  expect(setCaps.mock.calls[0][0].every(row => row.cap_credits === null)).toBe(true)
})

it('keeps disablement pending until effective revocation is read back', async () => {
  const api = mockTeamApi('superadmin'), revocationResult = vi.fn(api.revocationResult)
    .mockResolvedValueOnce({ state: 'revoking', operation_id: 'revocation-fixture' })
  await mountTeam('superadmin', { ...api, revocationResult })
  await until('the member actions load', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 3)
  await click('管理许澄')
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
  await until('the active member loads', () => harness.container.querySelectorAll('.gg-team-settings-member').length === 3)
  await click('管理许澄')
  await click('停用并交接'); await click('停用并交接')
  await until('the lost response is reported', () => !!document.querySelector('[role="dialog"] [role="alert"]'))
  const original = disable.mock.calls[0]
  harness.cleanup()
  await mountTeam('superadmin', { ...api, disable })
  await click('成员账户管理'); await userEvent.click(page.getByRole('tab', { name: '已停用', exact: true }))
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

it('accepts an invitation only after verifying the invited email while keeping its token out of visible inputs', async () => {
  const api = mockTeamApi(), challenge = vi.fn(api.challenge), acceptInvitation = vi.fn(api.acceptInvitation)
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamApiProvider api={{ ...api, challenge, acceptInvitation }}>
    <TeamAuthPane googleEnabled={false} onPersonal={vi.fn()} invitationLink={{ token: 'synthetic-invitation-secret', region: 'cn' }} />
  </TeamApiProvider>, { auth: null })
  await until('the safe invitation summary is shown', () => document.body.textContent?.includes('明川研究院') === true)
  expect(harness.container.textContent).not.toContain('synthetic-invitation-secret')
  expect([...harness.container.querySelectorAll('input')].some(input => input.value.includes('synthetic-invitation-secret'))).toBe(false)
  await userEvent.fill(page.getByRole('textbox', { name: '邮箱', exact: true }), 'lin@example.test')
  await click('继续')
  await until('invitation email verification is requested', () => !!harness.container.querySelector('input[autocomplete="one-time-code"]'))
  expect(challenge).toHaveBeenCalledWith({ email: 'lin@example.test', purpose: 'accept_invitation', invitation_token: 'synthetic-invitation-secret' })
  expect(acceptInvitation).not.toHaveBeenCalled()
  await userEvent.fill(page.getByRole('textbox', { name: '验证码' }), '123456'); await click('加入团队')
  await until('the invitation installs its independent team session', () => auth.accept.mock.calls.length === 1)
  expect(acceptInvitation.mock.calls[0].slice(0, 2)).toEqual(['synthetic-invitation-secret', 'receipt-fixture'])
  expect(auth.accept).toHaveBeenCalledWith(41, teamSignIn().session)
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
