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

it('switching from a text draft to an empty chat reveals only the available controls', async () => {
  await page.viewport(390, 844); setLocalePreference('zh-CN')
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  const render = (chatId: string) => renderWithAppProviders(harness!, <LocalizationProvider><PhoneViewportShell mobile>
    <ChatBottomDock reserve={false}><div data-chat-composer="">
      <PhoneComposerControlRow conversationKey={chatId}><PhoneComposerControl label="话题" testId="topics" onClick={() => {}} /></PhoneComposerControlRow>
      <ChatMessageComposer key={chatId} chatId={chatId} isGroupChat onSend={vi.fn(async () => {})} />
    </div></ChatBottomDock>
  </PhoneViewportShell></LocalizationProvider>)
  const row = () => harness!.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  await render('with-draft')
  await until('idle menu is visible', () => row().getBoundingClientRect().height > 0)
  expect(row().querySelectorAll('button')).toHaveLength(1)
  await page.getByTestId('chat-composer').fill('保留文字草稿')
  keyboard(false)
  await until('text alone hides the entire row', () => !row().hasAttribute('data-editing') && row().hasAttribute('hidden'))
  expect(row().getBoundingClientRect().height).toBe(0)
  await render('empty')
  await until('empty chat menus are visible', () => !row().hasAttribute('hidden') && row().getBoundingClientRect().height > 0)
  expect(row().querySelectorAll('button')).toHaveLength(1)
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
  expect(row.hasAttribute('hidden')).toBe(false)
  expect(row.querySelectorAll('button')).toHaveLength(1)
})
