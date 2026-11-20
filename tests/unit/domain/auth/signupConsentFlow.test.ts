// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMainCatalog'
import { TeamApiProvider } from '../../../../apps/desktop/src/features/team/context'
import { teamInvitation } from '../../../../apps/desktop/src/features/team/invitation'
import { mockTeamApi } from '../../../fixtures/teamEdition'

const m = vi.hoisted(() => ({ enabled: true, accept: vi.fn(), request: vi.fn(), verify: vi.fn(), receive: null as null | ((link: string) => void) }))
vi.mock('../../../../apps/desktop/src/features/team/invitation', async () => {
  const { createTeamInvitationInbox } = await import('../../../../apps/desktop/src/features/team/invitation-state')
  const inbox = createTeamInvitationInbox(receive => { m.receive = receive; return () => {} })
  inbox.start()
  return { teamInvitation: inbox }
})
vi.mock('../../../../apps/desktop/src/pages/login/signupConsentRuntime', () => ({ signupConsentAdapter: {
  get enabled() { return m.enabled },
  documentVersion: (language: string) => `hk-signup-v1-${language}`,
  accept: m.accept,
} }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: { requestLoginOtp: m.request, verifyLoginOtp: m.verify } }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: {
  beginInteractiveLogin: () => 1, acceptInteractiveSession: vi.fn(),
} }))
const googleState = { phase: 'idle', busy: false }
vi.mock('../../../../apps/desktop/src/lib/googleLogin', () => ({ googleLogin: {
  available: false, subscribe: () => () => {}, getSnapshot: () => googleState,
} }))
vi.mock('../../../../apps/desktop/src/pages/login/AuthBrandMotion', () => ({ AuthBrandMotion: () => null }))
vi.mock('../../../../apps/desktop/src/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))
const { LoginPage } = await import('../../../../apps/desktop/src/pages/LoginPage')
let host: HTMLDivElement, root: Root
let teamApi: ReturnType<typeof mockTeamApi>
const renderLogin = () => root.render(createElement(TeamApiProvider, { api: teamApi, children: createElement(LoginPage) }))
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!
async function click(text: string) { await act(async () => button(text).click()) }
async function input(email: string) {
  await act(async () => {
    const node = host.querySelector<HTMLInputElement>('input[type="email"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, email)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function send() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  m.enabled = true
  m.accept.mockImplementation(async (language: string, acceptedAt: string) => ({ document_version: `hk-signup-v1-${language}`, accepted_at: acceptedAt }))
  m.request.mockResolvedValue({ success: true })
  teamInvitation.clear()
  teamApi = mockTeamApi()
  await i18n.changeLanguage('zh-CN')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => renderLogin())
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); teamInvitation.clear(); vi.restoreAllMocks() })

it('keeps existing-account sign-in on the original screen without asking for consent', async () => {
  expect(host.querySelector('[data-signup-consent]')).toBeNull()
  await input('existing@example.test'); await send()
  expect(m.accept).not.toHaveBeenCalled()
  expect(m.request).toHaveBeenCalledExactlyOnceWith('existing@example.test', { kind: 'login' })
})

it('retains the original request when the preview adapter is disabled', async () => {
  m.enabled = false
  await act(async () => renderLogin())
  expect(button('新用户注册')).toBeUndefined()
  await input('normal@example.test'); await send()
  expect(m.request).toHaveBeenCalledExactlyOnceWith('normal@example.test')
  expect(m.accept).not.toHaveBeenCalled()
})

it('does not expose or submit an email before a separate affirmative consent', async () => {
  await input('not-submitted@example.test')
  await click('新用户注册')
  expect(host.querySelector('input')).toBeNull()
  expect(host.querySelector('[data-signup-consent]')?.textContent).toContain('未满 14 周岁的，请让父母或其他监护人来点同意。')
  expect(host.querySelector<HTMLAnchorElement>('[data-signup-consent] a')?.href).toBe('https://gugu.nextmind.space/zh/privacy.html')
  await click('不同意')
  expect(host.querySelector('[role="status"]')?.textContent).toContain('你的邮箱地址不会被发送。')
  expect(host.querySelector('input')).toBeNull()
  expect(m.accept).not.toHaveBeenCalled()
  expect(m.request).not.toHaveBeenCalled()
  expect(JSON.stringify(localStorage)).not.toContain('not-submitted@example.test')
})

it('waits for acknowledgement and carries its original version and click time to signup', async () => {
  let finish!: (value: unknown) => void
  m.accept.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await click('新用户注册'); await click('同意并继续')
  expect(host.querySelector('[data-signup-consent]')).not.toBeNull()
  expect(host.querySelector('input[type="email"]')).toBeNull()
  expect(host.querySelector('input')).toBeNull()
  expect(m.request).not.toHaveBeenCalled()
  const acceptedAt = m.accept.mock.calls[0]![1] as string
  expect(acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  const consent = { document_version: 'hk-signup-v1-zh', accepted_at: acceptedAt }
  await act(async () => finish(consent))
  expect(host.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe('')
  await input('new@example.test'); await send()
  expect(m.request).toHaveBeenCalledExactlyOnceWith('new@example.test', { kind: 'signup', consent })
})

it('takes a team invitation into the real TeamAuthPane while personal signup is awaiting consent', async () => {
  const challenge = vi.spyOn(teamApi, 'challenge')
  await click('新用户注册')
  expect(host.querySelector('[data-signup-consent]')).not.toBeNull()
  const token = 'a'.repeat(64)
  await act(async () => { m.receive!(`gugu-dev://team/invite?region=cn#invitation_token=${token}`) })
  expect(host.querySelector('.gg-team-auth')).not.toBeNull()
  expect(host.querySelector('[data-signup-consent]')).toBeNull()
  expect(host.querySelector('.gugu-signup-consent-pane')).toBeNull()
  expect(host.textContent).toContain('明川研究院')
  await input('invitee@example.test'); await send()
  expect(challenge).toHaveBeenCalledExactlyOnceWith({ email: 'invitee@example.test', purpose: 'accept_invitation', invitation_token: token })
  expect(host.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull()
  expect(m.accept).not.toHaveBeenCalled()
  expect(m.request).not.toHaveBeenCalled()
})

it('keeps a team invitation route available with the original consent adapter disabled', async () => {
  m.enabled = false
  await act(async () => { m.receive!(`gugu-dev://team/invite?region=cn#invitation_token=${'b'.repeat(64)}`) })
  expect(host.querySelector('.gg-team-auth')).not.toBeNull()
  expect(host.querySelector('[data-signup-consent]')).toBeNull()
  expect(host.textContent).toContain('明川研究院')
  expect(m.request).not.toHaveBeenCalled()
})

it('keeps a rejected or unknown consent write blocked until an explicit retry succeeds', async () => {
  m.accept.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
  await click('新用户注册'); await click('同意并继续')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('无法保存同意记录，请重试。')
  expect(host.querySelector('input')).toBeNull()
  expect(m.accept).toHaveBeenCalledTimes(1)
  await click('同意并继续')
  expect(host.querySelector('input')).toBeNull()
  expect(m.accept).toHaveBeenCalledTimes(2)
  await click('同意并继续')
  expect(host.querySelector('input[type="email"]')).not.toBeNull()
  expect(m.accept).toHaveBeenCalledTimes(3)
  expect(m.request).not.toHaveBeenCalled()
})

it('ignores a delayed acknowledgement after returning to sign-in', async () => {
  let finish!: (value: unknown) => void
  m.accept.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await click('新用户注册'); await click('同意并继续')
  const acceptedAt = m.accept.mock.calls[0]![1] as string
  await click('返回登录')
  await act(async () => finish({ document_version: 'hk-signup-v1-zh', accepted_at: acceptedAt }))
  expect(button('新用户注册')).toBeDefined()
  await input('existing@example.test'); await send()
  expect(m.request).toHaveBeenCalledExactlyOnceWith('existing@example.test', { kind: 'login' })
})

it('blocks account verification if the registration request fails', async () => {
  m.request.mockResolvedValueOnce({ success: false, reason: 'signup_consent_required', error: '请升级到新版咕咕后再注册。' })
  await click('新用户注册'); await click('同意并继续')
  await input('new@example.test'); await send()
  await send()
  expect(m.verify).not.toHaveBeenCalled()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('请升级到新版咕咕后再注册。')
})
