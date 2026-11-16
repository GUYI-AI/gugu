import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { PhoneComposerControl, PhoneComposerControlRow, PhoneComposerSheet } from '@/mobile/composer/PhoneComposerControls'
import { LocalizationProvider } from '@/i18n'
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

it.each([false, true])('native keyboard dismissal restores an empty menu but retains hiding a text draft=%s', async hasText => {
  const group = true
  await page.viewport(390, 844)
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><PhoneViewportShell mobile style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ flex: 1, minHeight: 0 }}>Messages remain above the input</div>
    <ChatBottomDock reserve={false}><div data-chat-composer="">
      {group && <PhoneComposerControlRow><PhoneComposerControl label="话题" testId="keyboard-fixture-topics" onClick={() => {}} /></PhoneComposerControlRow>}
      <ChatMessageComposer chatId="keyboard-test" isGroupChat={group} onSend={vi.fn(async () => {})} onSendAttachments={vi.fn(async () => {})} />
    </div></ChatBottomDock>
  </PhoneViewportShell></LocalizationProvider>)
  await until('native fixture composer', () => !!harness!.container.querySelector('[contenteditable]'))
  const input = harness.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const editor = input.querySelector<HTMLElement>('[contenteditable]')!
  const row = harness.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const initialTop = input.getBoundingClientRect().top
  const blur = vi.fn(), ended = vi.fn()
  editor.addEventListener('blur', blur); editor.addEventListener('compositionend', ended)
  editor.focus()
  if (hasText) {
    const engine = (editor as HTMLElement & { editor: { commands: { setContent: (text: string) => void } } }).editor
    engine.commands.setContent('<p>仍有文字草稿</p>')
    await until('real draft committed', () => editor.textContent === '仍有文字草稿')
  }
  keyboard(true)
  await page.viewport(390, 500)
  await until('menu hidden during native input', () => row.hasAttribute('data-editing'))
  expect(row.getBoundingClientRect().height).toBe(0)
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }))
  keyboard(false)
  await page.viewport(390, 844)
  await until('menu restored after native keyboard closes', () => row.hasAttribute('data-editing') === hasText && (hasText ? row.getBoundingClientRect().height === 0 : row.getBoundingClientRect().height > 40))
  expect(document.activeElement).toBe(editor)
  expect(input.querySelector('[contenteditable]')).toBe(editor)
  expect(blur).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  expect(input.getBoundingClientRect().top).toBe(initialTop)
  // Tapping an already-focused Android editor opens the IME without another focusin.
  keyboard(true)
  await until('native keyboard reopens without a focus change', () => row.hasAttribute('data-editing'))
  keyboard(false)
  await until('second dismissal respects whether text remains', () => row.hasAttribute('data-editing') === hasText)
  expect(document.activeElement).toBe(editor)
  expect(blur).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
  const engine = (editor as HTMLElement & { editor: { commands: { clearContent: (emit: boolean) => void } } }).editor
  engine.commands.clearContent(true)
  await until('clearing the text restores the menu with keyboard closed', () => !editor.textContent?.trim() && !row.hasAttribute('data-editing'))
  expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled(); expect(ended).toHaveBeenCalledTimes(1)
})

it('a keyboard belonging to panel search does not hide the empty composer menu', async () => {
  await page.viewport(390, 844)
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><PhoneViewportShell mobile>
    <ChatBottomDock reserve={false}><div data-chat-composer="">
      <PhoneComposerControlRow><PhoneComposerControl label="技能" testId="panel-search-skills" onClick={() => {}} /></PhoneComposerControlRow>
      <ChatMessageComposer chatId="panel-search" isGroupChat onSend={vi.fn(async () => {})} />
      <PhoneComposerSheet open onClose={() => {}} title="技能" testId="keyboard-search-sheet"><input aria-label="技能搜索" /></PhoneComposerSheet>
    </div></ChatBottomDock>
  </PhoneViewportShell></LocalizationProvider>)
  await page.getByRole('textbox', { name: '技能搜索' }).fill('检查')
  keyboard(true)
  const row = harness.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  await until('panel keyboard leaves the empty menu available', () => !row.hasAttribute('data-editing') && row.getBoundingClientRect().height > 40)
  expect(document.activeElement?.getAttribute('aria-label')).toBe('技能搜索')
  expect(harness.container.querySelector('[contenteditable]')?.textContent?.trim()).toBe('')
})
