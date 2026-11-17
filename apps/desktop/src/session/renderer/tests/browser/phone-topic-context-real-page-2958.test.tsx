import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { closeInfoTab, closeTopicTab, topicTabOf, infoTabOf } from '@/session/renderer/features/chats/chat-tabs/chat-layouts'
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMobileWorkspaceCatalog'

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
afterEach(() => { harness?.cleanup(); closeInfoTab('context-room'); closeTopicTab('context-room'); document.documentElement.removeAttribute('data-phone-shell'); delete document.documentElement.dataset.theme })

async function waitForTopicDetailsPage() {
  await expect.element(page.getByTestId('chat-settings-panel')).toBeVisible()
  // ChatAreaPanel's real mobile RightPanel is this details root's parent.
  // Visibility alone is already true while its x=100% -> 0 entrance is moving.
  const panel = harness!.container.querySelector<HTMLElement>('[data-testid="chat-settings-panel"]')!.parentElement!
  const geometry = () => {
    const box = panel.getBoundingClientRect(), viewport = harness!.container.getBoundingClientRect()
    const style = getComputedStyle(panel)
    return {
      position: style.position, opacity: Number(style.opacity), transform: style.transform,
      animating: panel.getAnimations().some(animation => animation.pending || (animation.playState !== 'finished' && animation.playState !== 'idle')),
      edges: [box.left - viewport.left, box.top - viewport.top, box.right - viewport.right, box.bottom - viewport.bottom],
    }
  }
  const coversViewport = (reading: ReturnType<typeof geometry>) => reading.position === 'fixed' && reading.opacity === 1 &&
    !reading.animating && reading.edges.every(delta => Math.abs(delta) <= 0.5)
  await until('real topic details entrance covers the phone viewport', geometry, coversViewport)
  await untilStable('real topic details viewport geometry is stable across frames', geometry)
  expect(coversViewport(geometry()), 'the stable details page still covers the viewport before capture').toBe(true)
}

for (const width of [360, 390]) for (const theme of ['light', 'dark'] as const) {
  it(`${width}/${theme}: real room route selects topic B, switches to A and returns to its source`, async () => {
    await page.viewport(width, 844); setLocalePreference('zh-CN')
    writeThemePreference(theme); document.documentElement.setAttribute('data-phone-shell', '')
    closeInfoTab('context-room'); closeTopicTab('context-room'); harness = createReactHarness()
    Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column' })
    const group = chat({ id: 'context-room', kind: 'group', name: '来源群' })
    await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><PhoneViewportShell mobile data-phone-shell="" data-ta-scope="" style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ta-panel-bg)' }}>
      <ChatAreaPanel mobile onBack={vi.fn()} />
    </PhoneViewportShell></LocalizationProvider></ThemeProvider>, { chat: { activeChat: group, activeChatId: group.id,
      chats: [group, ...reads.topics.map(topic => chat({ id: topic.chat_id, kind: 'topic', source_chat_id: group.id, name: topic.name }))],
    } })
    const header = () => harness!.container.querySelector<HTMLElement>('[data-chat-area-header]')!
    await until('actual source header', () => header()?.dataset.chatContextId === 'context-room')
    await page.getByTestId('session-chat-panel').getByTestId('phone-room-topics').click()
    await page.getByTestId('phone-topics-search').fill('同名')
    expect(document.documentElement.dataset.theme).toBe(theme)
    expect(harness.container.textContent).not.toMatch(/agentWatch\.|shell\./)
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
    await waitForTopicDetailsPage()
    expect(infoTabOf(group.id)?.info.topic?.topicChatId).toBe('context-topic-a')
    expect(header().dataset.chatContextId).toBe('context-topic-a')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/L-topic-info-${width}-${theme}.png` })
    // Info is a real pushed page; its Back covers the retained topic header.
    // Click that visible page, never force-click the underlying topic button.
    await page.getByTestId('chat-settings-panel').getByRole('button', { name: '返回', exact: true }).click()
    await until('details Back restores its topic', () => !infoTabOf(group.id)?.shown && header()?.dataset.chatContextId === 'context-topic-a')
    await page.elementLocator(header().querySelector<HTMLButtonElement>('button')!).click()
    await until('actual Back returns to room', () => topicTabOf(group.id) === null && header()?.dataset.chatContextId === 'context-room')
    expect(header().textContent).toContain('来源群')
    await page.screenshot({ path: `__screenshots__/owner-phone-regression/L-return-${width}-${theme}.png` })
  })
}
