import { useState, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { Button } from '@/components/ui/Button'
import { Popover } from '@/components/ui/Popover'
import type { ActiveMemberProfile } from '@/components/memberProfileModels'
import { PhoneComposerControl, PhoneComposerControlRow, PhoneComposerSheet } from '@/mobile/composer/PhoneComposerControls'
import { PhoneRoomComposerControls } from '@/mobile/chat/PhoneRoomComposerControls'
import { PhoneSkillsManager } from '@/mobile/local-agent/PhoneTaskSkillsButton'
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { NATIVE_BACK_EVENT } from '@/components/ui/sheetStack'
import '@/mobile/agent-watch/create-controls-catalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn(async () => ({
  conversationId: 'session', revision: 1, updatedAt: null, editable: true, busy: false,
  skills: [{ id: '11111111-1111-4111-8111-111111111111', name: '会议记录', description: '', instructions: '整理会议记录', enabled: true }],
  limits: { maxSkills: 8, maxNameChars: 80, maxDescriptionChars: 160, maxInstructionChars: 10000, maxTotalBytes: 64000 },
})) }))
let harness: ReturnType<typeof createReactHarness> | null = null
const closed = vi.fn()
function Menus() {
  const [view, setView] = useState<'root' | 'child' | null>(null)
  return <><PhoneComposerControlRow>
    <PhoneComposerControl label="工作" testId="work" menuExpanded={view !== null} onClick={() => setView('root')} />
    <PhoneComposerControl label="选择文件" testId="action" onClick={() => {}} />
  </PhoneComposerControlRow>
    <PhoneComposerSheet open={view !== null} title={view === 'child' ? '子面板' : '工作'} testId="work-sheet" onClose={() => setView(null)}
      onBack={view === 'child' ? () => setView('root') : undefined}>
      <Button onClick={() => setView('child')}>打开子面板</Button>
    </PhoneComposerSheet></>
}
function Room() {
  const [handle] = useState(() => Popover.createHandle<ActiveMemberProfile>())
  return <PhoneRoomComposerControls chatId="room" topics={[]} current={null} onPick={() => {}} members={[]}
    roster={{ ready: true, failed: false, retry: () => {} }} userId="owner" profileOpener={{ handle, openedFrom: 'main' }} />
}
function Skills() {
  const [open, setOpen] = useState(true)
  return open ? <PhoneSkillsManager deviceId="phone" sessionId="session" busy={false} onClose={() => { closed(); setOpen(false) }} /> : null
}
async function mount(children: ReactNode, theme: 'light' | 'dark' = 'dark') {
  await page.viewport(360, 780)
  setLocalePreference('zh-CN'); document.documentElement.dataset.theme = theme
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  harness.container.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:8px'
  await renderWithAppProviders(harness, <LocalizationProvider><SessionUiTheme theme={theme}>{children}</SessionUiTheme></LocalizationProvider>,
    { auth: { id: 'owner' }, chat: { chats: [chat({ id: 'room', kind: 'group' })] }, contacts: { contacts: [] } })
}
function direction(id: string, open: boolean) {
  const trigger = harness!.container.querySelector(`[data-testid="${id}"]`)!
  expect(trigger.getAttribute('aria-expanded')).toBe(String(open))
  expect(trigger.querySelector('svg[data-phone-menu-direction]')?.getAttribute('data-phone-menu-direction')).toBe(open ? 'down' : 'up')
}
afterEach(() => {
  harness?.cleanup(); harness = null; closed.mockClear()
  document.documentElement.removeAttribute('data-phone-shell'); document.documentElement.removeAttribute('data-theme')
})
it.each(['light', 'dark'] as const)('%s: the shared menu reflects open state and closes both root and child views with the same close action', async theme => {
  await mount(<Menus />, theme)
  await until('menu mounted', () => !!harness?.container.querySelector('[data-testid="work"]'))
  direction('work', false)
  const action = harness!.container.querySelector('[data-testid="action"]')!
  expect(action.hasAttribute('aria-expanded')).toBe(false)
  expect(action.querySelector('svg[data-phone-menu-direction]')).toBeNull()
  await page.getByTestId('work').click(); direction('work', true)
  await page.getByRole('button', { name: '打开子面板', exact: true }).click()
  await expect.element(page.getByRole('heading', { name: '子面板', exact: true })).toBeVisible()
  direction('work', true)
  await page.getByTestId('work-sheet-back').click()
  await expect.element(page.getByRole('heading', { name: '工作', exact: true })).toBeVisible()
  direction('work', true)
  await page.getByRole('button', { name: '打开子面板', exact: true }).click()
  window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT))
  await expect.element(page.getByRole('heading', { name: '工作', exact: true })).toBeVisible()
  direction('work', true)
  await page.getByRole('button', { name: '打开子面板', exact: true }).click()
  document.querySelector<HTMLButtonElement>('[data-testid="work-sheet-back"]')!.focus()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('heading', { name: '工作', exact: true })).toBeVisible()
  direction('work', true)
  await page.getByRole('button', { name: '打开子面板', exact: true }).click()
  await page.getByTestId('work-sheet-close').click()
  await until('child sheet closed', () => !document.querySelector('[data-testid="work-sheet"]'))
  direction('work', false)
  await page.getByTestId('work').click()
  await page.getByTestId('work-sheet-close').click()
  await until('root sheet closed', () => !document.querySelector('[data-testid="work-sheet"]'))
  direction('work', false)
})
it('the real room Topics and Agents entries both expose and reset their own expanded state', async () => {
  await mount(<Room />)
  await until('room menu mounted', () => !!harness?.container.querySelector('[data-testid="phone-room-topics"]'))
  for (const id of ['phone-room-topics', 'phone-room-agents']) {
    direction(id, false)
    await page.getByTestId(id).click(); direction(id, true)
    await page.getByTestId('phone-room-controls-sheet-close').click()
    await until('room menu closed', () => !document.querySelector('[data-testid="phone-room-controls-sheet"]'))
    direction(id, false)
  }
})
it('the native skill child view uses Close without discarding an unsaved draft', async () => {
  await mount(<Skills />)
  await expect.element(page.getByRole('button', { name: /会议记录/ })).toBeVisible()
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/E-native-skills-root-360-dark.png' })
  await page.getByRole('button', { name: /会议记录/ }).click()
  await page.getByTestId('phone-skill-name').fill('已修改的名称')
  await expect.element(page.getByTestId('phone-task-skills-close')).toBeVisible()
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/E-native-skills-dirty-child-360-dark.png' })
  await page.getByTestId('phone-task-skills-close').click()
  await expect.element(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible()
  expect(closed).not.toHaveBeenCalled()
  await expect.element(page.getByTestId('phone-skill-name')).toHaveValue('已修改的名称')
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/E-native-skills-close-confirm-360-dark.png' })
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await page.getByRole('button', { name: '返回 Skill 列表', exact: true }).click()
  await page.getByTestId('phone-task-skills-close').click()
  expect(closed).not.toHaveBeenCalled()
  await page.getByTestId('phone-skills-discard').click()
  expect(closed).toHaveBeenCalledOnce()
  await until('native skill sheet closed', () => !document.querySelector('[data-testid="phone-task-skills"]'))
  await page.screenshot({ path: '__screenshots__/owner-phone-regression/E-native-skills-discard-closed-360-dark.png' })
})
