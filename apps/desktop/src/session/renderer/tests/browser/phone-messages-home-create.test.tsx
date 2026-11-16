import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatListPanel } from '@/components/ChatListPanel'
import { NeedsYouHost } from '@/components/needsYou/NeedsYouHost'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { platform } from '../../../../../../../tests/support/capacitorPlatformTestDouble'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerContactsCatalog'

vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', () => import('../../../../../../../tests/support/contactsChatServiceTestDouble'))
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'))
vi.mock('@/components/needsYou/useNeedsYouTasks', async original => ({ ...await original<object>(), useNeedsYouTasks: () => ({ tasks: [], count: 0, attention: null, error: null }) }))
vi.mock('@/lib/passwordBetaNotifications', async original => ({ ...await original<object>(), usePasswordNotifications: () => [], usePasswordSnapshot: () => null }))

let harness: ReturnType<typeof createReactHarness> | undefined
const capabilities = platform.capabilities as typeof platform.capabilities & { barcodeScan?: boolean }
const originalScan = capabilities.barcodeScan
afterEach(() => { harness?.cleanup(); document.documentElement.removeAttribute('data-phone-shell'); if (originalScan === undefined) delete capabilities.barcodeScan; else capabilities.barcodeScan = originalScan })

for (const theme of ['dark', 'light']) it(`${theme}: phone home exposes the direct Agent pen between notifications and More`, async () => {
  await page.viewport(390, 844)
  setLocalePreference('zh-CN')
  document.documentElement.dataset.theme = theme
  document.documentElement.setAttribute('data-phone-shell', '')
  capabilities.barcodeScan = true
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', background: 'var(--bg)' })
  const create = vi.fn(), project = vi.fn(), scan = vi.fn()
  await renderWithAppProviders(harness, <LocalizationProvider>
    <ChatListPanel mobile onOpenSessionCreate={create} onNewProject={project} onScan={scan} />
    <NeedsYouHost />
  </LocalizationProvider>, { chat: { chats: [], activeChatId: null } })
  const find = (id: string) => harness!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await until('the actual notification portal and both header actions have positive geometry', () => [find('notification-toggle'), find(AUTOMATION_TEST_IDS.mobileSessionCreateAction), find(AUTOMATION_TEST_IDS.chatListPlusButton)].every(element => !!element && element.getBoundingClientRect().width > 0))
  const bell = find('notification-toggle')!, pen = find(AUTOMATION_TEST_IDS.mobileSessionCreateAction)!, more = find(AUTOMATION_TEST_IDS.chatListPlusButton)!
  expect(bell.getBoundingClientRect().right).toBeLessThanOrEqual(pen.getBoundingClientRect().left)
  expect(pen.getBoundingClientRect().right).toBeLessThanOrEqual(more.getBoundingClientRect().left)
  await page.screenshot({ element: harness.container, path: `__screenshots__/home-create-${theme}.png` })
  await page.getByTestId(AUTOMATION_TEST_IDS.mobileSessionCreateAction).click()
  expect(create).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await page.getByTestId(AUTOMATION_TEST_IDS.chatListPlusButton).click()
  await until('the four existing More actions are visible', () => document.querySelectorAll('[role="menuitem"]').length === 4)
  const ids = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.getAttribute('data-testid'))
  expect(ids).toEqual(['plus-menu-create-group', 'plus-menu-new-project', 'plus-menu-add-friend', 'plus-menu-scan'])
  await page.screenshot({ element: document.body, path: `__screenshots__/home-more-${theme}.png` })
  await page.getByTestId('plus-menu-new-project').click()
  expect(project).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledOnce()
  console.log('PHONE_HOME_CREATE ' + JSON.stringify({ theme, order: ['notifications', 'createAgent', 'more'], penCallbackCalls: create.mock.calls.length, moreItems: ids, localSessionHost: platform.capabilities.sessionHost }))
})
