import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { PhoneComposerControl, PhoneComposerControlRow } from '@/mobile/composer/PhoneComposerControls'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import '@/i18n/registerMessagingCatalog'

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); document.documentElement.removeAttribute('data-phone-shell') })
const keyboard = (visible: boolean) => window.dispatchEvent(Object.assign(new Event('gugu:phone-keyboard'), { visible }))

it('manual row collapse survives keyboard dismissal and resets on conversation change', async () => {
  await page.viewport(390, 844); setLocalePreference('zh-CN')
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  const render = async (chatId: string) => renderWithAppProviders(harness!, <LocalizationProvider><PhoneViewportShell mobile style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ flex: 1, minHeight: 0 }}>Messages</div>
    <ChatBottomDock reserve={false}><div data-chat-composer="">
      <PhoneComposerControlRow conversationKey={chatId}><PhoneComposerControl label="话题" testId="collapse-fixture-topics" onClick={() => {}} /></PhoneComposerControlRow>
      <ChatMessageComposer chatId={chatId} isGroupChat onSend={vi.fn(async () => {})} onSendAttachments={vi.fn(async () => {})} />
    </div></ChatBottomDock>
  </PhoneViewportShell></LocalizationProvider>)
  await render('collapse-first')
  await until('actual editor and toggle', () => !!harness!.container.querySelector('[contenteditable]') && !!harness!.container.querySelector('[data-testid="phone-composer-menu-toggle"]'))
  const row = () => harness!.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const toggle = () => row().querySelector<HTMLButtonElement>('[data-testid="phone-composer-menu-toggle"]')!
  const items = () => row().querySelector<HTMLElement>('.gg-phone-composer-controls-items')!
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(items().getBoundingClientRect().height).toBeGreaterThan(0)
  await page.getByTestId('phone-composer-menu-toggle').click()
  await until('only row arrow remains', () => row().hasAttribute('data-collapsed'))
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(items().getBoundingClientRect().width).toBe(0)
  expect(items().getBoundingClientRect().height).toBe(0)
  expect(row().getBoundingClientRect().height).toBeLessThanOrEqual(44)
  const stableItemsId = toggle().getAttribute('aria-controls')
  await render('collapse-first')
  expect(toggle().getAttribute('aria-controls')).toBe(stableItemsId)
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  const input = harness!.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const editor = input.querySelector<HTMLElement>('[contenteditable]')!
  const top = input.getBoundingClientRect().top, blur = vi.fn(), ended = vi.fn()
  editor.addEventListener('blur', blur); editor.addEventListener('compositionend', ended)
  editor.focus(); editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }))
  keyboard(true)
  await until('typing hides both controls and arrow', () => row().hasAttribute('data-editing'))
  expect(row().getBoundingClientRect().height).toBe(0)
  keyboard(false)
  await until('keyboard dismissal restores manual collapse', () => !row().hasAttribute('data-editing') && row().hasAttribute('data-collapsed'))
  expect(items().getBoundingClientRect().height).toBe(0)
  expect(document.activeElement).toBe(editor)
  expect(input.querySelector('[contenteditable]')).toBe(editor)
  expect(input.getBoundingClientRect().top).toBe(top)
  expect(blur).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  await page.getByTestId('phone-composer-menu-toggle').click()
  await until('same conversation manually expanded', () => !row().hasAttribute('data-collapsed'))
  keyboard(true); await until('typing hides expanded controls', () => row().hasAttribute('data-editing'))
  keyboard(false); await until('expanded choice returns', () => !row().hasAttribute('data-editing') && !row().hasAttribute('data-collapsed'))
  await page.getByTestId('phone-composer-menu-toggle').click()
  await render('collapse-second')
  await until('another conversation starts expanded', () => toggle().getAttribute('aria-expanded') === 'true' && !row().hasAttribute('data-collapsed'))
})

it('a text draft keeps an arrow to expand manually without changing focus or the draft', async () => {
  await page.viewport(390, 844); setLocalePreference('zh-CN')
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><PhoneViewportShell mobile>
    <ChatBottomDock reserve={false}><div data-chat-composer="">
      <PhoneComposerControlRow conversationKey="text-collapse"><PhoneComposerControl label="话题" testId="text-collapse-topics" onClick={() => {}} /></PhoneComposerControlRow>
      <ChatMessageComposer chatId="text-collapse" isGroupChat onSend={vi.fn(async () => {})} />
    </div></ChatBottomDock>
  </PhoneViewportShell></LocalizationProvider>)
  await until('real editor', () => !!harness!.container.querySelector('[contenteditable]'))
  const editor = harness.container.querySelector<HTMLElement>('[contenteditable]')!
  const row = harness.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const items = row.querySelector<HTMLElement>('.gg-phone-composer-controls-items')!
  const engine = (editor as HTMLElement & { editor: { commands: { setContent: (text: string) => void } } }).editor
  const blur = vi.fn(), ended = vi.fn()
  editor.addEventListener('blur', blur); editor.addEventListener('compositionend', ended)
  editor.focus(); keyboard(true)
  engine.commands.setContent('<p>保留这段文字草稿</p>')
  await until('draft entered while typing', () => row.hasAttribute('data-editing') && !!editor.textContent?.trim())
  keyboard(false)
  await until('text auto-collapse leaves an active arrow', () => !row.hasAttribute('data-editing') && row.hasAttribute('data-collapsed'))
  expect(row.getBoundingClientRect().height).toBe(44)
  expect(items.getBoundingClientRect().height).toBe(0)
  expect(row.inert).toBe(false)
  await page.getByTestId('phone-composer-menu-toggle').click()
  await until('draft menu manually expanded', () => !row.hasAttribute('data-collapsed'))
  expect(items.getBoundingClientRect().height).toBe(44)
  expect(editor.textContent).toBe('保留这段文字草稿')
  expect(document.activeElement).toBe(editor)
  keyboard(true)
  await until('keyboard hides controls and arrow', () => row.getBoundingClientRect().height === 0)
  keyboard(false)
  await until('manual expansion survives typing', () => !row.hasAttribute('data-editing') && !row.hasAttribute('data-collapsed'))
  expect(items.getBoundingClientRect().height).toBe(44)
  expect(blur).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
})

it('human direct messages retain only the in-input paperclip with no menu or collapse arrow', async () => {
  await page.viewport(390, 844)
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><ChatMessageComposer chatId="human-direct-collapse" onSend={vi.fn(async () => {})} onSendAttachments={vi.fn(async () => {})} /></LocalizationProvider>)
  await until('human direct editor', () => !!harness!.container.querySelector('[contenteditable]'))
  expect(harness.container.querySelector('[data-phone-composer-controls]')).toBeNull()
  expect(harness.container.querySelector('[data-testid="phone-composer-menu-toggle"]')).toBeNull()
  expect(harness.container.querySelector('[data-testid="chat-composer-attach-menu"]')).not.toBeNull()
})


it('an empty capability row exposes neither controls nor the row arrow', async () => {
  await page.viewport(390, 844)
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><PhoneComposerControlRow conversationKey="empty">{null}</PhoneComposerControlRow></LocalizationProvider>)
  await until('empty capability row mounted', () => !!harness!.container.querySelector('[data-phone-composer-controls]'))
  const row = harness.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  expect(row.getBoundingClientRect().height).toBe(0)
  expect(getComputedStyle(row).display).toBe('none')
})

it('without a native keyboard observation the row retains the existing focus fallback', async () => {
  await page.viewport(390, 844)
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><div data-chat-composer="">
    <PhoneComposerControlRow conversationKey="focus-fallback"><PhoneComposerControl label="话题" testId="focus-fallback-topics" onClick={() => {}} /></PhoneComposerControlRow>
    <ChatMessageComposer chatId="focus-fallback" isGroupChat onSend={vi.fn(async () => {})} />
  </div></LocalizationProvider>)
  await until('fallback editor', () => !!harness!.container.querySelector('[contenteditable]'))
  const editor = harness.container.querySelector<HTMLElement>('[contenteditable]')!
  const row = harness.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const blur = vi.fn(), ended = vi.fn()
  editor.addEventListener('blur', blur); editor.addEventListener('compositionend', ended)
  editor.focus()
  await until('focused fallback hides the complete row', () => row.hasAttribute('data-editing'))
  expect(row.getBoundingClientRect().height).toBe(0)
  expect(blur).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  editor.blur()
  await until('user blur restores the empty row', () => !row.hasAttribute('data-editing'))
  expect(row.hasAttribute('data-collapsed')).toBe(false)
  expect(row.querySelector('[data-testid="phone-composer-menu-toggle"]')?.getAttribute('aria-expanded')).toBe('true')
})
