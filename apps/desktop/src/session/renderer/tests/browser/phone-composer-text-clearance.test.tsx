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

function visibleGlyphs(editor: HTMLElement, input: DOMRect) {
  const boxes: DOMRect[] = [], walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let offset = 0
    for (const character of node.textContent ?? '') {
      const range = document.createRange()
      range.setStart(node, offset); offset += character.length; range.setEnd(node, offset)
      for (const box of range.getClientRects()) {
        if (box.width && box.height && box.top >= input.top && box.bottom <= input.bottom) boxes.push(box)
      }
    }
  }
  return boxes
}

for (const width of [360, 390]) for (const theme of ['dark', 'light'] as const) {
  it.each([
    ['CJK', '测量文字与按钮之间的实际距离。'.repeat(12)],
    ['Latin', 'i'.repeat(400)],
  ])(`${width}px ${theme}: rendered %s glyphs stay at least 12px clear of right-hand controls`, async (sample, text) => {
    await page.viewport(width, 844)
    writeThemePreference(theme); document.documentElement.setAttribute('data-phone-shell', '')
    harness = createReactHarness()
    Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' })
    await renderWithAppProviders(harness, <ThemeProvider><LocalizationProvider><ChatBottomDock reserve={false}>
      <ChatMessageComposer isGroupChat onSend={vi.fn(async () => {})} onSendAttachments={vi.fn(async () => {})} />
    </ChatBottomDock></LocalizationProvider></ThemeProvider>)
    await until('real composer', () => !!harness!.container.querySelector('[contenteditable]'))
    const composer = harness.container.querySelector<HTMLElement>('[data-phone-capsule]')!
    const editor = composer.querySelector<HTMLElement>('[contenteditable]')!
    const input = composer.querySelector<HTMLElement>('[data-slot="composer-input"]')!
    const engine = (editor as HTMLElement & { editor: { commands: { setContent: (value: string) => void } } }).editor
    engine.commands.setContent(`<p>${text}</p>`)
    await until('dense text rendered with its attachment control', () => editor.textContent === text
      && getComputedStyle(composer.querySelector<HTMLElement>('[data-phone-attachment]')!).display !== 'none')
    await document.fonts.ready
    await new Promise(requestAnimationFrame)
    input.scrollTop = 0
    const glyphs = visibleGlyphs(editor, input.getBoundingClientRect())
    expect(glyphs.length).toBeGreaterThan(0)
    for (const key of ['editor-toggle', 'attachment', 'send']) {
      const button = composer.querySelector<HTMLElement>(`[data-phone-${key}]`)!
      expect(button).not.toBeNull()
      expect(getComputedStyle(button).display).not.toBe('none')
      const box = button.getBoundingClientRect()
      const sameRow = glyphs.filter(glyph => glyph.top < box.bottom && glyph.bottom > box.top)
      expect(sameRow.length, `${key} must be measured against actual text alongside it`).toBeGreaterThan(0)
      const textRight = Math.max(...sameRow.map(glyph => glyph.right))
      expect(box.left - textRight, JSON.stringify({ width, theme, sample, key, textRight, controlLeft: box.left })).toBeGreaterThanOrEqual(12)
    }
  })
}
