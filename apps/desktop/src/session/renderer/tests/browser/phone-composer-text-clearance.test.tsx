import { afterEach, expect, it, onTestFailed, vi } from 'vitest'
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
    const readDom = () => ({
      connected: composer.isConnected && editor.isConnected,
      textMatches: editor.textContent === text,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      phoneCapsule: composer.hasAttribute('data-phone-capsule'),
      controls: ['editor-toggle', 'attachment', 'send'].map(key => {
        const button = composer.querySelector<HTMLElement>(`[data-phone-${key}]`)
        const box = button?.getBoundingClientRect()
        return { key, exists: !!button, width: box?.width ?? 0, height: box?.height ?? 0,
          display: button ? getComputedStyle(button).display : null }
      }),
      html: composer.outerHTML,
    })
    let lastDom = readDom()
    onTestFailed(({ task }) => {
      const reason = new Error(`Phone composer DOM at failure: ${JSON.stringify(lastDom)}`)
      task.result?.errors?.push({ name: reason.name, message: reason.message, stack: reason.stack })
    })
    engine.commands.setContent(`<p>${text}</p>`)
    // Text can commit before the multiline controls mount. Wait on the actual boxes, not a frame delay.
    try {
      await vi.waitFor(() => {
        lastDom = readDom()
        expect(lastDom.connected && lastDom.textMatches).toBe(true)
        expect(lastDom.viewport.width).toBe(width)
        for (const control of lastDom.controls) {
          expect(control.exists, `${control.key} exists`).toBe(true)
          expect(control.width, `${control.key} width`).toBeGreaterThan(0)
          expect(control.height, `${control.key} height`).toBeGreaterThan(0)
          expect(control.display, `${control.key} display`).not.toBe('none')
        }
      }, { interval: 16, timeout: 45_000 })
    } catch (cause) {
      lastDom = readDom()
      throw new Error(`Phone controls did not become measurable: ${JSON.stringify(lastDom)}`, { cause })
    }
    await document.fonts.ready
    input.scrollTop = 0
    const glyphs = visibleGlyphs(editor, input.getBoundingClientRect())
    expect(glyphs.length).toBeGreaterThan(0)
    for (const key of ['editor-toggle', 'attachment', 'send']) {
      lastDom = readDom()
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
