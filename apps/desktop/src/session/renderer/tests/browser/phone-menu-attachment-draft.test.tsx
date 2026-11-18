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

async function checkMenu({ collapsed = false, editing = false }: { collapsed?: boolean; editing?: boolean } = {}) {
  await vi.waitFor(() => {
    const current = row()
    expect(current, harness!.container.innerHTML).not.toBeNull()
    const items = current.querySelector<HTMLElement>('.gg-phone-composer-controls-items')!
    const toggle = current.querySelector<HTMLButtonElement>('[data-testid="phone-composer-menu-toggle"]')!
    expect(current.hasAttribute('data-editing'), current.outerHTML).toBe(editing)
    expect(current.hasAttribute('data-collapsed'), current.outerHTML).toBe(collapsed)
    expect(current.getAttribute('aria-hidden')).toBe(editing ? 'true' : null)
    expect(items.hidden).toBe(collapsed)
    expect(items.inert).toBe(collapsed)
    expect(toggle.getAttribute('aria-expanded')).toBe(String(!collapsed))
    expect(toggle.getAttribute('aria-label')).toBe(collapsed ? '展开输入框菜单栏' : '收起输入框菜单栏')
    if (editing) expect(current.getBoundingClientRect().height).toBe(0)
    else expect(current.getBoundingClientRect().height).toBeGreaterThan(40)
    expect(current.inert).toBe(editing)
    if (editing) expect(getComputedStyle(current).marginBottom).toBe('0px')
    else {
      expect(current.scrollWidth).toBeLessThanOrEqual(current.clientWidth)
      const box = toggle.getBoundingClientRect(), outer = current.getBoundingClientRect()
      const after = getComputedStyle(toggle, '::after')
      const touch = { left: box.left + parseFloat(after.left), right: box.right - parseFloat(after.right),
        top: box.top + parseFloat(after.top), bottom: box.bottom - parseFloat(after.bottom) }
      expect(toggle.getAttribute('data-mobile')).toBe('true')
      expect(touch.right - touch.left).toBe(44)
      expect(touch.bottom - touch.top).toBe(44)
      expect(touch.left).toBeGreaterThanOrEqual(outer.left)
      expect(touch.right).toBeLessThanOrEqual(outer.right)
      expect(touch.top).toBeGreaterThanOrEqual(outer.top)
      expect(touch.bottom).toBeLessThanOrEqual(outer.bottom)
      for (const [x, y] of [[touch.left + 1, box.top + box.height / 2], [touch.right - 1, box.top + box.height / 2],
        [box.left + box.width / 2, touch.top + 1], [box.left + box.width / 2, touch.bottom - 1]]) {
        expect(document.elementFromPoint(x!, y!)?.closest('button')).toBe(toggle)
      }
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

// Picked files and text collapse menu items while retaining the manual disclosure control.
// Only active composer keyboard editing hides/inerts the entire row (approved B).
it.each(['chat', 'creation-host'] as const)('%s: picked files collapse menu items until the last attachment is removed', async scope => {
  await mount(<div {...(scope === 'chat' ? { 'data-chat-composer': '' } : { className: 'gg-aw-create-host' })}>
    {menu}<ChatMessageComposer chatId={`attachment-draft-${scope}`} isGroupChat onSend={vi.fn(async () => {})} />
  </div>)
  expect(harness!.container.querySelector('[data-phone-attachment]')).not.toBeNull()
  await checkMenu()
  const input = editor(), blur = vi.fn(), end = vi.fn()
  input.focus()
  input.addEventListener('blur', blur); input.addEventListener('compositionend', end)
  await checkMenu()
  await pick('file', ['first.txt', 'second.txt'])
  await checkMenu({ collapsed: true })
  expect(input.textContent?.trim()).toBe('')
  expect(editor()).toBe(input); expect(document.activeElement).toBe(input)
  expect(blur).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(1))
  await checkMenu({ collapsed: true })
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  await checkMenu()
  expect(editor()).toBe(input)
})

it('a photo-only draft collapses menu items through the existing photo picker path', async () => {
  await mount(<div data-chat-composer="">{menu}<ChatMessageComposer chatId="attachment-photo" isGroupChat onSend={vi.fn(async () => {})} /></div>)
  await checkMenu()
  expect(editor().textContent).toBe('')
  await expect.element(page.getByTestId('chat-composer-attach-menu')).toBeVisible()
  await page.getByTestId('chat-composer-attach-menu').click()
  await expect.element(page.getByTestId('chat-composer-attach-photos')).toBeVisible()
  await pick('photo', ['test.png'])
  await checkMenu({ collapsed: true })
  expect(editor().textContent?.trim()).toBe('')
})

it('removing the final attachment keeps text items collapsed and keyboard editing hides the whole row', async () => {
  await mount(<div data-chat-composer="">{menu}<ChatMessageComposer chatId="attachment-and-text" isGroupChat onSend={vi.fn(async () => {})} /></div>)
  await pick('file', ['keep.txt'])
  await checkMenu({ collapsed: true })
  const input = editor() as HTMLElement & { editor: { commands: { setContent(html: string): void; clearContent(emit: boolean): void } } }
  await act(async () => input.editor.commands.setContent('<p>仍有文字</p>'))
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  await checkMenu({ collapsed: true })
  input.focus(); keyboard(true)
  await checkMenu({ collapsed: true, editing: true })
  await act(async () => input.editor.commands.clearContent(true))
  await checkMenu({ editing: true })
  keyboard(false)
  await checkMenu()
  expect(document.activeElement).toBe(input)
})

function PendingAttachment({ state }: { state: ComposerAttachment['state'] }) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([{ id: 'pending-file', name: 'pending.bin', kind: 'file', state, cancelable: true }])
  return <SessionUiTheme theme="dark"><MessageProvider locale="zh-CN" translate={translateSessionMessage}>
    <ChatComposer mobile renderPhoneHeader={() => menu} attachments={attachments} onAttachmentsChange={setAttachments}
      inputHeader={<span data-testid="selected-skill-label">代码检查</span>} onSubmit={vi.fn()} />
  </MessageProvider></SessionUiTheme>
}

it.each(['uploading', 'done', 'error'] as const)('%s attachment previews collapse nested menu items; a skill label alone does not', async state => {
  await mount(<PendingAttachment state={state} />)
  await vi.waitFor(() => expect(tiles()[0]?.getAttribute('data-state')).toBe(state))
  await checkMenu({ collapsed: true })
  expect(editor().textContent?.trim()).toBe('')
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  expect(harness!.container.querySelector('[data-testid="selected-skill-label"]')).not.toBeNull()
  await checkMenu()
})

it('an attachment draft keeps a usable manual disclosure without clearing files or moving composer focus', async () => {
  await mount(<div data-chat-composer="">{menu}<ChatMessageComposer chatId="attachment-manual-disclosure" isGroupChat onSend={vi.fn(async () => {})} /></div>)
  const input = editor(), blur = vi.fn(), end = vi.fn()
  input.focus()
  input.addEventListener('blur', blur); input.addEventListener('compositionend', end)
  await pick('file', ['keep.txt'])
  await checkMenu({ collapsed: true })
  const file = tiles()[0]
  await page.getByTestId('phone-composer-menu-toggle').click()
  await checkMenu()
  expect(tiles()[0]).toBe(file)
  expect(file?.textContent).toContain('keep.txt')
  expect(editor()).toBe(input); expect(document.activeElement).toBe(input)
  expect(blur).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
  await page.getByTestId('phone-composer-menu-toggle').click()
  await checkMenu({ collapsed: true })
  expect(tiles()).toHaveLength(1)
})
