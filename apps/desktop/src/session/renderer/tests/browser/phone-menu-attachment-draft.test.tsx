import { act, useState, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer, type ComposerAttachment, MessageProvider } from '@gugu/session-ui/react/components'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import { PhoneComposerControl, PhoneComposerControlRow } from '@/mobile/composer/PhoneComposerControls'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import '@/i18n/registerMessagingCatalog'

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => {
  harness?.cleanup()
  document.documentElement.removeAttribute('data-phone-shell')
  document.documentElement.removeAttribute('data-theme')
})
const keyboard = (visible: boolean) => window.dispatchEvent(Object.assign(new Event('gugu:phone-keyboard'), { visible }))
const row = () => harness!.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
const editor = () => harness!.container.querySelector<HTMLElement>('[contenteditable]')!
const tiles = () => harness!.container.querySelectorAll('[data-slot="composer-attachment"]')
const menu = <PhoneComposerControlRow><PhoneComposerControl label="工作" testId="attachment-draft-work" onClick={() => {}} /></PhoneComposerControlRow>

async function checkMenu(mode: 'expanded' | 'collapsed' | 'keyboard') {
  await vi.waitFor(() => {
    const current = row()
    expect(current, harness!.container.innerHTML).not.toBeNull()
    expect(current.hasAttribute('data-editing'), current.outerHTML).toBe(mode === 'keyboard')
    const items = current.querySelector<HTMLElement>('.gg-phone-composer-controls-items')!
    const toggle = current.querySelector<HTMLElement>('[data-testid="phone-composer-menu-toggle"]')!
    expect(items).not.toBeNull(); expect(toggle).not.toBeNull()
    if (mode === 'keyboard') {
      expect(current.getBoundingClientRect().height).toBe(0)
      expect(current.inert).toBe(true)
      expect(getComputedStyle(current).marginBottom).toBe('0px')
    } else {
      expect(current.hasAttribute('data-collapsed')).toBe(mode === 'collapsed')
      expect(current.inert).toBe(false)
      expect(toggle.getAttribute('aria-expanded')).toBe(String(mode === 'expanded'))
      if (mode === 'collapsed') {
        expect(current.getBoundingClientRect().height).toBe(44)
        expect(items.getBoundingClientRect().height).toBe(0)
      } else expect(items.getBoundingClientRect().height).toBeGreaterThan(40)
    }
  }, { timeout: 5000 })
}

async function mount(children: ReactNode) {
  await page.viewport(390, 844)
  setLocalePreference('zh-CN')
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  await renderWithAppProviders(harness, <LocalizationProvider><PhoneViewportShell mobile>
    <ChatBottomDock reserve={false}>{children}</ChatBottomDock>
  </PhoneViewportShell></LocalizationProvider>)
  await vi.waitFor(() => expect(editor()).not.toBeNull())
  keyboard(false)
}

async function pick(kind: 'file' | 'photo', names: string[]) {
  const picker = harness!.container.querySelector<HTMLInputElement>(kind === 'photo'
    ? 'input[type="file"][accept="image/*"][multiple]'
    : 'input[type="file"][multiple]:not([accept])')!
  expect(picker).not.toBeNull()
  const transfer = new DataTransfer()
  for (const name of names) transfer.items.add(kind === 'photo'
    ? new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMngAAAAASUVORK5CYII='), char => char.charCodeAt(0))], name, { type: 'image/png' })
    : new File(['测试附件'], name, { type: 'text/plain' }))
  await act(async () => {
    picker.files = transfer.files
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await vi.waitFor(() => expect(tiles()).toHaveLength(names.length))
}

async function removeFirst() {
  const remove = tiles()[0]!.querySelector<HTMLButtonElement>('button[aria-label]')!
  expect(remove).not.toBeNull()
  await act(async () => remove.click())
}

// Owner 2026-11-16 16:25 supersedes #2881's attachment exclusion.
// A mounted paperclip is not a draft; selected files and their previews are.
it.each(['chat', 'creation-host'] as const)('%s: picked files collapse the menu to its row arrow until the final attachment is removed', async scope => {
  await mount(<div {...(scope === 'chat' ? { 'data-chat-composer': '' } : { className: 'gg-aw-create-host' })}>
    {menu}<ChatMessageComposer chatId={`attachment-draft-${scope}`} isGroupChat onSend={vi.fn(async () => {})} />
  </div>)
  expect(harness!.container.querySelector('[data-phone-attachment]')).not.toBeNull()
  await checkMenu('expanded')
  const input = editor(), blur = vi.fn(), end = vi.fn()
  input.focus()
  input.addEventListener('blur', blur); input.addEventListener('compositionend', end)
  await checkMenu('expanded')
  await pick('file', ['first.txt', 'second.txt'])
  await checkMenu('collapsed')
  expect(input.textContent?.trim()).toBe('')
  expect(editor()).toBe(input); expect(document.activeElement).toBe(input)
  expect(blur).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(1))
  await checkMenu('collapsed')
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  await checkMenu('expanded')
  expect(editor()).toBe(input)
})

it('a photo-only draft leaves the menu arrow through the existing photo picker path', async () => {
  await mount(<div data-chat-composer="">{menu}<ChatMessageComposer chatId="attachment-photo" isGroupChat onSend={vi.fn(async () => {})} /></div>)
  await checkMenu('expanded')
  await page.getByTestId('chat-composer-attach-menu').click()
  await expect.element(page.getByTestId('chat-composer-attach-photos')).toBeVisible()
  await pick('photo', ['test.png'])
  await checkMenu('collapsed')
  expect(editor().textContent?.trim()).toBe('')
})

it('removing the final attachment retains the draft arrow or full keyboard hiding as appropriate', async () => {
  await mount(<div data-chat-composer="">{menu}<ChatMessageComposer chatId="attachment-and-text" isGroupChat onSend={vi.fn(async () => {})} /></div>)
  await pick('file', ['keep.txt'])
  await checkMenu('collapsed')
  const input = editor() as HTMLElement & { editor: { commands: { setContent(html: string): void; clearContent(emit: boolean): void } } }
  await act(async () => input.editor.commands.setContent('<p>仍有文字</p>'))
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  await checkMenu('collapsed')
  input.focus(); keyboard(true)
  await act(async () => input.editor.commands.clearContent(true))
  await checkMenu('keyboard')
  keyboard(false)
  await checkMenu('expanded')
  expect(document.activeElement).toBe(input)
})

function PendingAttachment({ state }: { state: ComposerAttachment['state'] }) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([{ id: 'pending-file', name: 'pending.bin', kind: 'file', state, cancelable: true }])
  return <SessionUiTheme theme="dark"><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
    <ChatComposer mobile renderPhoneHeader={() => menu} attachments={attachments} onAttachmentsChange={setAttachments}
      inputHeader={<span data-testid="selected-skill-label">代码检查</span>} onSubmit={vi.fn()} />
  </MessageProvider></SessionUiTheme>
}

it.each(['uploading', 'done', 'error'] as const)('%s attachment previews leave a usable nested menu arrow; a skill label alone does not', async state => {
  await mount(<PendingAttachment state={state} />)
  await vi.waitFor(() => expect(tiles()[0]?.getAttribute('data-state')).toBe(state))
  await checkMenu('collapsed')
  expect(editor().textContent?.trim()).toBe('')
  const input = editor()
  input.focus()
  await page.getByTestId('phone-composer-menu-toggle').click()
  await checkMenu('expanded')
  expect(tiles()[0]?.getAttribute('data-state')).toBe(state)
  expect(editor()).toBe(input); expect(document.activeElement).toBe(input)
  keyboard(true); await checkMenu('keyboard')
  keyboard(false); await checkMenu('expanded')
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  expect(harness!.container.querySelector('[data-testid="selected-skill-label"]')).not.toBeNull()
  await checkMenu('expanded')
})


it('desktop composers ignore the phone menu render slot even at phone viewport widths', async () => {
  await mount(<SessionUiTheme theme="dark"><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
    <ChatComposer mobile={false} renderPhoneHeader={() => menu} onSubmit={vi.fn()} />
  </MessageProvider></SessionUiTheme>)
  expect(harness!.container.querySelector('[data-phone-composer-controls]')).toBeNull()
  expect(harness!.container.querySelector('[data-testid="phone-composer-menu-toggle"]')).toBeNull()
  expect(editor()).not.toBeNull()
})
