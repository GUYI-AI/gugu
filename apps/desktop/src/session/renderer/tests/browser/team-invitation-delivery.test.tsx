import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { page, userEvent } from 'vitest/browser'
import { i18n } from '@/i18n'
import { TeamProvider, TeamAccessGate } from '@/features/team/context'
import { TeamInviteDialog } from '@/features/team/TeamInviteDialog'
import { createTeamApi, type TeamTransport } from '@/features/team/api'
import { createTeamInviteIntentStore } from '@/features/team/inviteIntentStore'
import { mockTeamApi, teamInvitationFixture, teamInvitationCapability, teamUser } from '../../../../../../../tests/fixtures/teamEdition'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/features/team/team.css'

let harness: ReturnType<typeof createReactHarness>
const prefix = 'gugu:team-invite:v1:team-ming:team-person-lin:'
const click = (name: string) => userEvent.click(page.getByRole('button', { name, exact: true }))
beforeEach(async () => {
  await page.viewport(1440, 960); await i18n.changeLanguage('zh-CN')
  document.documentElement.setAttribute('data-theme', 'light')
  for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key)
})
afterEach(() => harness?.cleanup())
async function mount(transport: TeamTransport) {
  const invite = createTeamApi(transport).invite, onClose = vi.fn(), fixture = mockTeamApi('admin', { invite })
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamProvider user={teamUser} api={fixture}><TeamAccessGate>
    <TeamInviteDialog onClose={onClose} onSaved={async () => {}} />
  </TeamAccessGate></TeamProvider>, { auth: teamUser })
  await until('the administrator invitation dialog is ready', () => !!document.querySelector('.gg-team-dialog input[type="email"]'))
  return onClose
}
async function submit() {
  await userEvent.fill(page.getByRole('textbox', { name: '成员邮箱', exact: true }), 'Member@example.test')
  await click('发送邀请')
}
function assertNoCapabilityOutsideMemory() {
  expect(JSON.stringify(Object.entries(localStorage))).not.toContain(teamInvitationCapability)
  expect([...document.querySelectorAll<HTMLInputElement>('input')].some(input => input.value.includes(teamInvitationCapability))).toBe(false)
  expect(document.body.textContent).not.toContain(teamInvitationCapability)
}

it.each(['lost-response', 'database-unknown'])('restores the original command after %s without an automatic retry or replacement key', async kind => {
  const transport = vi.fn<TeamTransport>().mockImplementationOnce(async () => {
    if (kind === 'lost-response') throw new Error('synthetic response loss')
    return { ok: false, status: 503, error: { code: 'dependency_unavailable' }, data: {
      operation_id: null, invitation_created: null, delivery: { operation_id: null, state: 'unknown', reason_code: 'invitation_outcome_unknown' } } }
  }).mockResolvedValue({ ok: true, data: teamInvitationFixture() })
  const onClose = await mount(transport)
  await submit()
  await until('the uncertain original result is shown', () => document.body.textContent?.includes('邀请结果待确认') === true)
  expect(transport).toHaveBeenCalledOnce(); const original = transport.mock.calls[0][0]
  expect(JSON.stringify(Object.entries(localStorage))).toContain(original.body!.idempotency_key)
  assertNoCapabilityOutsideMemory()
  await userEvent.click(document.querySelector<HTMLButtonElement>('.gg-team-dialog-actions button')!)
  expect(onClose).toHaveBeenCalledOnce(); harness.cleanup()
  await mount(transport)
  expect((document.querySelector('.gg-team-dialog input[type="email"]') as HTMLInputElement).value).toBe('Member@example.test')
  expect(transport).toHaveBeenCalledOnce()
  await click('继续原邀请')
  await until('the original request returns its accepted mail receipt', () => document.body.textContent?.includes('邮件服务器已接收') === true)
  expect(transport.mock.calls[1][0]).toEqual(original)
  expect(document.body.textContent).not.toMatch(/已送达|已收到/)
  expect(document.body.textContent).toContain('确认是否收到')
  await expect.element(page.getByRole('button', { name: '复制邀请链接', exact: true })).toBeEnabled()
  assertNoCapabilityOutsideMemory()
})

it.each([
  ['pending', '邮件尚未发送'], ['sending', '邮件正在发送'], ['failed', '邮件发送失败'], ['unknown', '邮件发送结果待确认'],
] as const)('shows %s from partial failed data and never resends on a render, close or reopen', async (state, copy) => {
  const transport = vi.fn<TeamTransport>().mockResolvedValue({ ok: false, status: 503, error: { code: 'dependency_unavailable' }, data: {
    operation_id: 'identity-operation-fixture', invitation_created: true,
    delivery: { operation_id: 'mail-operation-fixture', state, reason_code: 'synthetic_mail_result' } } })
  await mount(transport); await submit()
  await until('the safe failed delivery receipt is shown', () => document.body.textContent?.includes(copy) === true)
  expect([...document.querySelectorAll('button')].some(button => /复制.*链接/.test(button.textContent ?? ''))).toBe(false)
  await act(async () => { window.dispatchEvent(new Event('storage')) })
  expect(transport).toHaveBeenCalledOnce()
  harness.cleanup(); await mount(transport)
  expect(document.body.textContent).toContain(copy)
  expect(transport).toHaveBeenCalledOnce()
  await click('继续原邀请')
  await until('the explicit replay has completed', () => transport.mock.calls.length === 2 && !document.querySelector('.gg-team-dialog input:disabled'))
  expect(transport.mock.calls[1][0]).toEqual(transport.mock.calls[0][0])
  expect(JSON.stringify(Object.entries(localStorage))).toContain('identity-operation-fixture')
  expect(JSON.stringify(Object.entries(localStorage))).toContain('mail-operation-fixture')
  assertNoCapabilityOutsideMemory()
})

it('only offers returned, verified failure links and never presents an unknown SMTP result as delivered', async () => {
  const data = { ...teamInvitationFixture(), delivery: { operation_id: 'mail-operation-fixture', state: 'unknown', reason_code: 'smtp_result_unknown' } }
  const transport = vi.fn<TeamTransport>().mockResolvedValue({ ok: false, status: 503, error: { code: 'dependency_unavailable' }, data })
  await mount(transport); await submit()
  await until('an established anchor has a manually copyable invitation', () => [...document.querySelectorAll('button')].some(button => button.textContent === '复制链接'))
  expect(document.body.textContent).toContain('邮件发送结果待确认')
  expect(document.body.textContent).not.toMatch(/已送达|已收到/)
  assertNoCapabilityOutsideMemory()
  expect(transport).toHaveBeenCalledOnce()
})

it('blocks a corrupt durable command instead of generating a new key or sending an invitation', async () => {
  const store = createTeamInviteIntentStore(localStorage, 'team-ming', teamUser.id)
  store.prepare('Member@example.test')
  const key = Object.keys(localStorage).find(key => key.startsWith(prefix) && !key.endsWith(':active'))!
  localStorage.setItem(key, 'corrupt')
  const transport = vi.fn<TeamTransport>()
  await mount(transport)
  expect(document.body.textContent).toContain('无法读写邀请记录')
  await expect.element(page.getByRole('button', { name: '发送邀请', exact: true })).toBeDisabled()
  expect(transport).not.toHaveBeenCalled()
})

it('persists the command before HTTP and refuses the write if storage is unavailable', async () => {
  const transport = vi.fn<TeamTransport>()
  await mount(transport)
  const original = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith(prefix)) throw new Error('synthetic storage quota failure')
    original.call(this, key, value)
  })
  await submit()
  await until('the failed intent persistence is visible', () => document.body.textContent?.includes('无法读写邀请记录') === true)
  expect(transport).not.toHaveBeenCalled()
})

it.each([
  ['zh-CN', 1440], ['zh-CN', 390], ['en-US', 1440], ['en-US', 390],
] as const)('keeps %s delivery controls inside a %ipx shared-render dialog', async (language, width) => {
  await i18n.changeLanguage(language); await page.viewport(width, width === 390 ? 844 : 960)
  const data = { ...teamInvitationFixture(), delivery: { operation_id: 'mail-operation-fixture', state: 'unknown', reason_code: 'smtp_result_unknown' } }
  await mount(vi.fn<TeamTransport>().mockResolvedValue({ ok: false, status: 503, error: { code: 'dependency_unavailable' }, data }))
  await userEvent.fill(document.querySelector<HTMLInputElement>('.gg-team-dialog input[type="email"]')!, 'Member@example.test')
  await userEvent.click(document.querySelectorAll<HTMLButtonElement>('.gg-team-dialog-actions button')[1])
  await until('the partial result exposes its established anchor controls', () => document.querySelectorAll('.gg-team-dialog-actions button').length === 3)
  const popup = document.querySelector<HTMLElement>('.gg-team-dialog')!, bounds = popup.getBoundingClientRect()
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width)
  expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1)
  const padding = getComputedStyle(popup)
  for (const button of popup.querySelectorAll('.gg-team-dialog-actions button')) {
    const rect = button.getBoundingClientRect()
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left + parseFloat(padding.paddingLeft) - 1)
    expect(rect.right).toBeLessThanOrEqual(bounds.right - parseFloat(padding.paddingRight) + 1)
  }
  expect(popup.textContent).not.toContain('identity-operation-fixture')
  expect(popup.textContent).not.toContain('mail-operation-fixture')
  assertNoCapabilityOutsideMemory()
  if (import.meta.env.VITE_TEAM_CAPTURE === '1') await page.screenshot({ element: popup, path: `__screenshots__/team-invitation-delivery-${language}-${width}.png` })
})
