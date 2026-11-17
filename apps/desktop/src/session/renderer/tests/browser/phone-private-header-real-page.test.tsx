import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { DisplayIdentity } from '@/lib/displayIdentity'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { ThemeProvider } from '@/store/theme'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { closeInfoTab, closeTopicTab, infoTabOf } from '@renderer/features/chats/chat-tabs/chat-layouts'
import { chat, displayIdentity, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMobileWorkspaceCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

// The production private conversation, heading, details and Back handlers stay real.
// The account's selected chat/identities and external reads are controlled. This is
// not a MainLayout entry, an AgentWatch task, a native phone or a live host test.
vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'))
let harness: ReturnType<typeof createReactHarness> | undefined
const ids = ['private-header-a', 'private-header-b', 'private-header-agent'] as const
afterEach(() => {
  harness?.cleanup(); harness = undefined
  for (const id of ids) { closeInfoTab(id); closeTopicTab(id) }
  document.documentElement.removeAttribute('data-phone-shell')
  delete document.documentElement.dataset.theme
})

for (const width of [360, 390]) for (const theme of ['light', 'dark'] as const) {
  it(`${width}/${theme}: actual private heading follows peer identity, alias and route without a task title`, async () => {
    await page.viewport(width, 844); setLocalePreference('zh-CN'); writeThemePreference(theme)
    document.documentElement.setAttribute('data-phone-shell', '')
    for (const id of ids) { closeInfoTab(id); closeTopicTab(id) }
    harness = createReactHarness()
    Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column' })
    const a = chat({ id: ids[0], kind: 'dm', peer_user_id: 'private-peer-a', name: '历史会话标题', avatar: null })
    const b = chat({ id: ids[1], kind: 'dm', peer_user_id: 'private-peer-b', name: '另一条历史标题', avatar: null })
    const agent = chat({ id: ids[2], kind: 'ai', peer_user_id: 'private-agent', name: '整理项目文档', avatar: null })
    const identities: Record<string, DisplayIdentity> = {
      'private-peer-a': displayIdentity('private-peer-a', { display_name: '林舟' }),
      'private-peer-b': displayIdentity('private-peer-b', { display_name: '林舟' }),
      'private-agent': displayIdentity('private-agent', { type: 'agent', display_name: '代码助手', owner_user_id: 'another-owner' }),
    }
    const back = vi.fn()
    const draw = (active: ChatItem, directory = identities) => renderWithAppProviders(harness!,
      <ThemeProvider><LocalizationProvider><PhoneViewportShell mobile data-phone-shell="" data-ta-scope=""
        style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ta-panel-bg)' }}>
        <ChatAreaPanel mobile onBack={back} />
      </PhoneViewportShell></LocalizationProvider></ThemeProvider>,
      { auth: { id: 'private-header-owner' }, chat: { activeChat: active, activeChatId: active.id, chats: [a, b, agent], identitiesById: directory } })
    const header = () => harness!.container.querySelector<HTMLElement>('[data-chat-area-header]')!
    const heading = () => header()?.querySelector<HTMLElement>('[role="button"]')
    const current = async (active: ChatItem, name: string) => {
      await until('the actual current private peer heading', () => header()?.dataset.chatContextId === active.id && heading()?.textContent === name)
      expect(header().dataset.chatContextKind).toBe('chat')
      expect(header().textContent).not.toContain(active.name)
      expect(header().textContent).not.toMatch(/agentWatch\.|shell\.|Unchanged alias/)
      expect(document.documentElement.dataset.theme).toBe(theme)
    }
    const capture = (phase: string) => page.screenshot({ path: `__screenshots__/owner-phone-regression/N-private-${width}-${theme}-${phase}.png` })

    await draw(a); await current(a, '林舟'); await capture('human-a')
    expect(harness.container.querySelector('[data-testid="phone-room-topics"]')).toBeNull()
    await draw(b); await current(b, '林舟'); await capture('human-b-same-name')
    const renamed = { ...identities, 'private-peer-b': { ...identities['private-peer-b']!, display_name: '吴桐' } }
    await draw(b, renamed); await current(b, '吴桐'); await capture('human-b-renamed')
    const aliased = { ...b, peer_alias: '项目伙伴' }
    await draw(aliased, renamed); await current(aliased, '项目伙伴'); await capture('human-b-alias')
    await draw(agent, renamed); await current(agent, '代码助手'); await capture('agent-private')
    await draw(a); await current(a, '林舟')
    await page.elementLocator(heading()!).click()
    await until('private details belong to the current chat', () => infoTabOf(a.id)?.shown === true)
    expect(infoTabOf(b.id)?.shown).not.toBe(true)
    await expect.element(page.getByTestId('chat-settings-panel')).toBeVisible()
    await capture('human-details')
    await page.getByTestId('chat-settings-panel').getByRole('button', { name: '返回', exact: true }).click()
    await until('details Back restores the current private chat', () => !infoTabOf(a.id)?.shown)
    await current(a, '林舟'); await capture('human-details-return')
    await page.elementLocator(header().querySelector<HTMLButtonElement>('button')!).click()
    expect(back).toHaveBeenCalledExactlyOnceWith()
  })
}
