import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
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

// Only the remote roster/activity are fixtures. ChatAreaPanel owns the actual
// dock, running slot, group menu, editor and their production spacing.
const activity = vi.hoisted(() => ({ count: 12 }))
vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => []) } }))
vi.mock('@/hooks/useRoomCollab', async original => ({ ...await original<object>(), useRoomCollab: () => ({ snapshot: null, error: null, reload: vi.fn(), authorityRevision: 0 }) }))
vi.mock('@/lib/groupRunningTokenModels', async original => ({ ...await original<object>(), groupRunningTokens: () => Array.from({ length: activity.count }, (_, i) => ({ id: `gap-agent-${i}`, name: `检查图片的智能体 ${i}`, avatarUrl: null, avatarSeed: String(i), stateKey: 'running', toolCount: 0, lastActiveAt: null })) }))

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); document.documentElement.removeAttribute('data-phone-shell'); delete document.documentElement.dataset.theme })

const phase = 'after'
const rect = (element: Element) => {
  const { top, bottom, left, right, width, height } = element.getBoundingClientRect()
  return { top, bottom, left, right, width, height }
}
const spacing = (element: Element) => {
  const css = getComputedStyle(element)
  return { paddingTop: css.paddingTop, paddingBottom: css.paddingBottom, marginTop: css.marginTop, marginBottom: css.marginBottom, gap: css.gap, height: css.height }
}

for (const width of [360, 390]) for (const theme of ['dark', 'light']) for (const count of [12, 0]) for (const keyboard of [false, true]) {
  it(`${width} ${theme} running=${count} keyboard=${keyboard}: measures the production group footer`, async () => {
    await page.viewport(width, 844)
    setLocalePreference('zh-CN')
    document.documentElement.dataset.theme = theme
    document.documentElement.setAttribute('data-phone-shell', '')
    activity.count = count
    harness = createReactHarness()
    Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', background: 'var(--bg)' })
    const group = chat({ id: 'gap-group', kind: 'group', name: '真实群聊组件' })
    await renderWithAppProviders(harness, <LocalizationProvider><PhoneViewportShell mobile style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ChatAreaPanel mobile />
    </PhoneViewportShell></LocalizationProvider>, { chat: {
      activeChat: group, activeChatId: group.id,
      messages: [message({ id: 'gap-last-message', chat_id: group.id, content: '同一条群聊消息，用于量运行状态、菜单和输入框的真实边界。' })],
    } })
    await until('production group editor and running row', () => {
      const root = harness!.container
      return !!root.querySelector('[contenteditable]') && !!root.querySelector('[data-phone-composer-controls]')
        && (count === 0 || !!root.querySelector('.rtb-bar > .rtb-more'))
    })
    const root = harness.container
    const editor = root.querySelector<HTMLElement>('[contenteditable]')!
    const row = root.querySelector<HTMLElement>('[data-phone-composer-controls]')!
    await act(async () => {
      if (keyboard) editor.focus(); else editor.blur()
      window.dispatchEvent(Object.assign(new Event('gugu:phone-keyboard'), { visible: keyboard }))
    })
    await until('menu reflects the composer keyboard', () => row.hasAttribute('data-editing') === keyboard)
    const dock = root.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
    const slot = dock.querySelector<HTMLElement>('[data-running-bar-slot]')!
    const composer = dock.querySelector<HTMLElement>('[data-chat-composer]')!
    const input = composer.querySelector<HTMLElement>('[data-slot="composer-input"]')!
    const token = root.querySelector<HTMLElement>('.rtb-bar > .rtb-tok .rtb-pill')
    const button = row.querySelector<HTMLElement>('button')!
    const data = { phase, width, theme, count, keyboard,
      dock: rect(dock), slot: rect(slot), slotSpacing: spacing(slot),
      bar: token ? rect(token.closest('.rtb-bar')!) : null, barSpacing: token ? spacing(token.closest('.rtb-bar')!) : null,
      pill: token ? rect(token) : null, row: rect(row), rowSpacing: spacing(row),
      button: rect(button), composer: rect(composer), composerSpacing: spacing(composer), input: rect(input),
      wrappers: Array.from(dock.children).map(child => ({ box: rect(child), spacing: spacing(child) })),
      pillToMenu: token && !keyboard ? rect(button).top - rect(token).bottom : null,
      rowToInput: rect(input).top - rect(row).bottom,
    }
    expect(dock.hasAttribute('data-running-status')).toBe(count > 0)
    expect(rect(button).height).toBe(44)
    expect(parseFloat(getComputedStyle(composer).paddingBottom)).toBeGreaterThanOrEqual(8)
    if (token) {
      expect(rect(slot).height).toBe(rect(token.closest('.rtb-bar')!).height + parseFloat(getComputedStyle(slot).paddingTop))
      if (!keyboard) {
        const gap = parseFloat(getComputedStyle(dock).getPropertyValue('--spacing-sm'))
        expect(data.pillToMenu).toBe(gap)
        // A native button's inline line box can exceed the fixed pill height in
        // fallback fonts. The visible pill-to-menu gap must stay the same.
        const bar = token.closest<HTMLElement>('.rtb-bar')!
        bar.style.fontFamily = 'Arial'
        await document.fonts.ready
        expect(rect(button).top - rect(token).bottom).toBe(gap)
        expect(rect(bar.querySelector('.rtb-more')!).height).toBe(rect(token).height)
        bar.style.removeProperty('font-family')
      }
    }
    if (keyboard) {
      expect(rect(row).height).toBe(0)
      expect(data.rowSpacing.marginBottom).toBe('0px')
    }
    if (count === 0) expect(rect(slot).height).toBe(0)
    if (!keyboard) expect(data.rowToInput).toBe(4)
    await page.screenshot({ element: harness.container, path: `__screenshots__/2904-${phase}-${width}-${theme}-${count}-${keyboard}.png` })
  })
}

it('updates the running marker when activity ends, editing hides the menu, and the room changes', async () => {
  await page.viewport(390, 844)
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column' })
  const draw = async (id: string, count: number) => {
    activity.count = count
    const group = chat({ id, kind: 'group', name: id })
    await renderWithAppProviders(harness!, <LocalizationProvider><PhoneViewportShell mobile style={{ height: '100%', display: 'flex', flexDirection: 'column' }}><ChatAreaPanel mobile /></PhoneViewportShell></LocalizationProvider>, {
      chat: { activeChat: group, activeChatId: id, messages: [message({ id: `${id}-${count}`, chat_id: id, content: 'Activity changes without a reserved blank strip.' })] },
    })
    await until('the current room publishes its own running marker', () => {
      const dock = harness!.container.querySelector('[data-chat-bottom-dock]')
      return !!dock && dock.hasAttribute('data-running-status') === (count > 0)
    })
  }
  await draw('room-a', 12)
  await draw('room-a', 0)
  expect(harness.container.querySelector('[data-running-bar-slot]')!.getBoundingClientRect().height).toBe(0)
  await draw('room-a', 12)
  const editor = harness.container.querySelector<HTMLElement>('[contenteditable]')!
  await act(async () => { editor.focus(); window.dispatchEvent(Object.assign(new Event('gugu:phone-keyboard'), { visible: true })) })
  await until('editing hides the menu while keeping actual running status', () => harness!.container.querySelector('[data-phone-composer-controls]')!.getBoundingClientRect().height === 0)
  expect(harness.container.querySelector('[data-chat-bottom-dock]')!.hasAttribute('data-running-status')).toBe(true)
  await act(async () => { window.dispatchEvent(Object.assign(new Event('gugu:phone-keyboard'), { visible: false })); editor.blur() })
  await draw('room-b', 0)
  await until('the new empty room restores its menu without an old running slot', () => harness!.container.querySelector('[data-phone-composer-controls]')!.getBoundingClientRect().height > 40)
  expect(harness.container.querySelector('[data-running-bar-slot]')!.getBoundingClientRect().height).toBe(0)
})
