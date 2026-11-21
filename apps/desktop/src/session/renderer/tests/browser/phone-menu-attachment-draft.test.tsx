import { act, useState, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer, type ComposerAttachment, MessageProvider } from '@gugu/session-ui/react/components'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { registerImageViewerHost, type ImageViewerRequest } from '@/lib/imageViewer'
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

async function checkMenu({ draft = false, editing = false }: { draft?: boolean; editing?: boolean } = {}) {
  await vi.waitFor(() => {
    const current = row()
    expect(current).not.toBeNull()
    expect(current.hasAttribute('data-editing')).toBe(editing)
    expect(current.hidden).toBe(draft || editing)
    expect(current.getBoundingClientRect().height > 0).toBe(!(draft || editing))
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
    : new File([`Preview contents for ${name}`], name, { type: 'text/plain' }))
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

// An attachment remains draft content even after the keyboard closes.
it.each(['chat', 'creation-host'] as const)('%s: picked files hide the row until the last attachment is removed', async scope => {
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
  await checkMenu({ draft: true })
  expect(input.textContent?.trim()).toBe('')
  expect(editor()).toBe(input); expect(document.activeElement).toBe(input)
  expect(blur).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(1))
  await checkMenu({ draft: true })
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  await checkMenu()
  expect(editor()).toBe(input)
})

it('a photo-only draft hides the menu through the existing photo picker path', async () => {
  await mount(<div data-chat-composer="">{menu}<ChatMessageComposer chatId="attachment-photo" isGroupChat onSend={vi.fn(async () => {})} /></div>)
  await checkMenu()
  expect(editor().textContent).toBe('')
  await expect.element(page.getByTestId('chat-composer-attach-menu')).toBeVisible()
  await page.getByTestId('chat-composer-attach-menu').click()
  await expect.element(page.getByTestId('chat-composer-attach-photos')).toBeVisible()
  await pick('photo', ['test.png'])
  await checkMenu({ draft: true })
  expect(editor().textContent?.trim()).toBe('')
})

it('opens the selected draft file and leaves both attachments queued after closing', async () => {
  const send = vi.fn(async () => {})
  await mount(<ChatMessageComposer chatId="attachment-preview-text" isGroupChat onSend={send} />)
  await pick('file', ['first.txt', 'second.txt'])
  await act(async () => (tiles()[1] as HTMLElement).click())
  const preview = page.getByTestId('draft-attachment-preview')
  const panel = preview.getByTestId('message-file-preview-panel')
  await expect.element(panel.getByRole('heading', { name: 'second.txt' })).toBeVisible()
  await expect.element(panel.getByText('Preview contents for second.txt')).toBeVisible()
  await panel.getByRole('button', { name: '关闭' }).click()
  await expect.element(preview).not.toBeInTheDocument()
  expect(tiles()).toHaveLength(2)
  expect(send).not.toHaveBeenCalled()
})

it('opens the draft photo in the shared image viewer with the selected bytes', async () => {
  const view = vi.fn<(request: ImageViewerRequest) => void>()
  const unregister = registerImageViewerHost(view)
  try {
    await mount(<ChatMessageComposer chatId="attachment-preview-image" isGroupChat onSend={vi.fn(async () => {})} />)
    await pick('photo', ['picked.png'])
    await act(async () => (tiles()[0] as HTMLElement).click())
    expect(view).toHaveBeenCalledOnce()
    const image = view.mock.calls[0]![0].items[0]!
    expect(image.alt).toBe('picked.png')
    try {
      const url = await image.preview!()
      const file = await (await fetch(url)).blob()
      expect(file.type).toBe('image/png')
      expect(file.size).toBeGreaterThan(0)
    } finally {
      image.release?.()
    }
  } finally {
    unregister()
  }
})

it('an edited draft image takes the original\'s place, and its marker notes join the draft text', async () => {
  const view = vi.fn<(request: ImageViewerRequest) => void>()
  const unregister = registerImageViewerHost(view)
  try {
    await mount(<ChatMessageComposer chatId="attachment-edit-image" isGroupChat onSend={vi.fn(async () => {})} />)
    await pick('photo', ['first.png', 'second.png'])
    await act(async () => (tiles()[0] as HTMLElement).click())
    const image = view.mock.calls[0]![0].items[0]!
    const edited = new File([await (await fetch(await image.preview!())).blob()], 'first-annotated.png', { type: 'image/png' })
    image.release?.()
    await act(async () => image.replace!(edited, '① 这里'))
    await vi.waitFor(() => expect([...tiles()].map(tile => tile.getAttribute('title'))).toEqual([expect.stringContaining('first-annotated.png'), expect.stringContaining('second.png')]))
    expect(editor().textContent).toContain('① 这里')
  } finally {
    unregister()
  }
})

it('removing the final attachment keeps the menu hidden for text and keyboard editing hides the whole row', async () => {
  await mount(<div data-chat-composer="">{menu}<ChatMessageComposer chatId="attachment-and-text" isGroupChat onSend={vi.fn(async () => {})} /></div>)
  await pick('file', ['keep.txt'])
  await checkMenu({ draft: true })
  const input = editor() as HTMLElement & { editor: { commands: { setContent(html: string): void; clearContent(emit: boolean): void } } }
  await act(async () => input.editor.commands.setContent('<p>仍有文字</p>'))
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  await checkMenu({ draft: true })
  input.focus(); keyboard(true)
  await checkMenu({ draft: true, editing: true })
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

it.each(['uploading', 'done', 'error'] as const)('%s attachment previews hide the nested menu; a skill label alone does not', async state => {
  await mount(<PendingAttachment state={state} />)
  await vi.waitFor(() => expect(tiles()[0]?.getAttribute('data-state')).toBe(state))
  await checkMenu({ draft: true })
  expect(editor().textContent?.trim()).toBe('')
  await removeFirst()
  await vi.waitFor(() => expect(tiles()).toHaveLength(0))
  expect(harness!.container.querySelector('[data-testid="selected-skill-label"]')).not.toBeNull()
  await checkMenu()
})
