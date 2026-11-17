import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
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

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); document.documentElement.removeAttribute('data-phone-shell') })

for (const width of [320, 390]) for (const theme of ['dark', 'light'] as const) {
  it(`${width}px ${theme}: two real text lines stay compact and controls do not overlap`, async () => {
    await page.viewport(width, 844)
    writeThemePreference(theme)
    document.documentElement.setAttribute('data-phone-shell', '')
    harness = createReactHarness()
    Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' })
    const send = vi.fn(async () => {})
    await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><ChatBottomDock reserve={false}>
      <ChatMessageComposer isGroupChat onSend={send} onSendAttachments={vi.fn(async () => {})} />
    </ChatBottomDock></LocalizationProvider></ThemeProvider>)
    await until('mounted production editor', () => !!harness!.container.querySelector('[contenteditable]'))
    await document.fonts.ready
    const composer = harness.container.querySelector<HTMLElement>('[data-phone-capsule]')!
    const editor = composer.querySelector<HTMLElement>('[contenteditable]')!
    const input = composer.querySelector<HTMLElement>('[data-slot="composer-input"]')!
    const engine = (editor as HTMLElement & { editor: { commands: { setContent: (html: string) => void } } }).editor
    const line = Number.parseFloat(getComputedStyle(editor).lineHeight)
    const padding = Number.parseFloat(getComputedStyle(input).paddingTop) + Number.parseFloat(getComputedStyle(input).paddingBottom)
    expect(line).toBeGreaterThan(0)
    const setLines = async (count: number) => {
      engine.commands.setContent(Array.from({ length: count }, (_, i) => `<p>第${i + 1}行</p>`).join(''))
      await until(`${count} paragraphs and line state`, () => editor.children.length === count
        && composer.hasAttribute('data-phone-multiline') === (count > 1)
        && composer.hasAttribute('data-phone-attachment-row') === (count > 2))
    }
    await setLines(1)
    const oneHeight = input.getBoundingClientRect().height
    expect(Math.abs(oneHeight - (line + padding))).toBeLessThanOrEqual(1)
    await setLines(2)
    await vi.waitFor(() => expect(Math.abs(input.getBoundingClientRect().height - (2 * line + padding))).toBeLessThanOrEqual(1))
    expect(input.scrollHeight).toBeLessThanOrEqual(input.clientHeight + 1)
    expect(composer.querySelector('[data-phone-editor-toggle]')).toBeNull()
    const attachment = composer.querySelector<HTMLElement>('[data-phone-attachment]')!
    const sendButton = composer.querySelector<HTMLElement>('[data-phone-send]')!
    const attachmentBox = attachment.getBoundingClientRect(), sendBox = sendButton.getBoundingClientRect()
    expect(attachmentBox.height).toBeGreaterThanOrEqual(32)
    expect(sendBox.height).toBeGreaterThanOrEqual(44)
    expect(attachmentBox.bottom, 'Attachment and Send retain distinct touch targets').toBeLessThanOrEqual(sendBox.top + 0.5)
    await page.screenshot({ element: harness.container, path: `__screenshots__/owner-phone-regression/H-shared-composer-${width}-${theme}-two-lines.png` })
    await setLines(3)
    const attach = composer.querySelector<HTMLElement>('[data-phone-attachment]')!
    expect(getComputedStyle(attach).display).not.toBe('none')
    const expand = composer.querySelector<HTMLElement>('[data-phone-editor-toggle]')!
    const controls = [expand, attach, sendButton].map(node => node.getBoundingClientRect())
    for (let i = 1; i < controls.length; i++) expect(controls[i - 1]!.bottom).toBeLessThanOrEqual(controls[i]!.top + 0.5)
    await setLines(2)
    await vi.waitFor(() => expect(Math.abs(input.getBoundingClientRect().height - (2 * line + padding))).toBeLessThanOrEqual(1))
    await setLines(1)
    await vi.waitFor(() => expect(Math.abs(input.getBoundingClientRect().height - oneHeight)).toBeLessThanOrEqual(1))
    expect(composer.querySelector('[contenteditable]'), 'line changes preserve the mounted editor').toBe(editor)
    expect(send).not.toHaveBeenCalled()
  })
}
