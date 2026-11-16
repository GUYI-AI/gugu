import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { closeTopicTab, topicTabOf, infoTabOf } from '@/session/renderer/features/chats/chat-tabs/chat-layouts'
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import '@/i18n/registerMessagingCatalog'

// Only external reads are controlled. The real room, topic, header and tab-route
// components run together; no replacement heading or route callback is rendered.
const reads = vi.hoisted(() => ({ topics: [
  { chat_id: 'context-topic-a', name: '同名话题', source_message_id: 'anchor-a', creator_user_id: 'owner', last_message_at: null, message_count: 0, participant_count: 1, is_participant: true },
  { chat_id: 'context-topic-b', name: '同名话题', source_message_id: 'anchor-b', creator_user_id: 'owner', last_message_at: null, message_count: 0, participant_count: 1, is_participant: true },
] }))
vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => reads.topics) } }))
vi.mock('@/hooks/useRoomCollab', async original => ({ ...await original<object>(), useRoomCollab: () => ({ snapshot: null, error: null, reload: vi.fn(), authorityRevision: 0 }) }))
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { closeTopicTab('context-room'); harness?.cleanup(); document.documentElement.removeAttribute('data-phone-shell'); delete document.documentElement.dataset.theme })

for (const width of [360, 390]) for (const theme of ['light', 'dark']) {
  it(`${width}/${theme}: real room route selects topic B, switches to A and returns to its source`, async () => {
    await page.viewport(width, 844); setLocalePreference('zh-CN')
    document.documentElement.dataset.theme = theme; document.documentElement.setAttribute('data-phone-shell', '')
    closeTopicTab('context-room'); harness = createReactHarness()
    Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column' })
    const group = chat({ id: 'context-room', kind: 'group', name: '来源群' })
    await renderWithAppProviders(harness, <LocalizationProvider><PhoneViewportShell mobile style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ChatAreaPanel mobile onBack={vi.fn()} />
    </PhoneViewportShell></LocalizationProvider>, { chat: { activeChat: group, activeChatId: group.id,
      chats: [group, ...reads.topics.map(topic => chat({ id: topic.chat_id, kind: 'topic', source_chat_id: group.id, name: topic.name }))],
    } })
    const header = () => harness!.container.querySelector<HTMLElement>('[data-chat-area-header]')!
    await until('actual source header', () => header()?.dataset.chatContextId === 'context-room')
    await page.getByTestId('session-chat-panel').getByTestId('phone-room-topics').click()
    await page.getByTestId('phone-topics-search').fill('同名')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/J-real-room-${width}-${theme}.png` })
    await page.elementLocator(document.querySelector<HTMLElement>('[data-topic-id="context-topic-b"][role="radio"]')!).click()
    await until('actual B route and title', () => topicTabOf(group.id)?.topic.topicChatId === 'context-topic-b' && header()?.dataset.chatContextId === 'context-topic-b')
    expect(header().textContent).toContain('同名话题')
    expect(harness.container.querySelector('[data-testid="topic-split-pane"]')?.getAttribute('data-topic-id')).toBe('context-topic-b')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/L-topic-b-${width}-${theme}.png` })
    // The underlying room and its topic both retain their real controls; select the visible topic pane explicitly.
    await page.getByTestId('topic-split-pane').getByTestId('phone-room-topics').click()
    await page.elementLocator(document.querySelector<HTMLElement>('[data-topic-id="context-topic-a"][role="radio"]')!).click()
    await until('actual A route and title', () => topicTabOf(group.id)?.topic.topicChatId === 'context-topic-a' && header()?.dataset.chatContextId === 'context-topic-a')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/L-topic-a-${width}-${theme}.png` })
    await page.elementLocator(header().querySelector<HTMLElement>('[role="button"]')!).click()
    await until('topic details keep the actual topic identity', () => infoTabOf(group.id)?.info.topic?.topicChatId === 'context-topic-a' && header()?.dataset.chatContextId === 'context-topic-a')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/L-topic-info-${width}-${theme}.png` })
    await page.elementLocator(header().querySelector<HTMLButtonElement>('button')!).click()
    await until('details Back restores its topic', () => !infoTabOf(group.id)?.shown && header()?.dataset.chatContextId === 'context-topic-a')
    await page.elementLocator(header().querySelector<HTMLButtonElement>('button')!).click()
    await until('actual Back returns to room', () => topicTabOf(group.id) === null && header()?.dataset.chatContextId === 'context-room')
    expect(header().textContent).toContain('来源群')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/L-return-${width}-${theme}.png` })
  })
}
