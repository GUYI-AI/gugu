import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
let root: Root | null = null, host: HTMLDivElement | null = null
const frames = async (count = 4) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame) }
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null })
async function mount() {
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div')); host.dataset.phoneShell = ''
  host.style.cssText = 'position:fixed;bottom:0;left:0;width:390px;padding:8px;box-sizing:border-box'
  root = createRoot(host); root.render(<LocalizationProvider><ChatMessageComposer onSend={vi.fn(async () => {})} /></LocalizationProvider>)
  await until('composer mounted', () => !!host?.querySelector('[contenteditable]'))
  const editor = host.querySelector<HTMLElement>('[contenteditable]')!, composer = host.querySelector<HTMLElement>('[data-phone-capsule]')!
  const attach = composer.querySelector<HTMLElement>('[data-phone-attachment]')!, input = composer.querySelector<HTMLElement>('[data-slot=composer-input]')!
  const blur = vi.fn(), end = vi.fn(); editor.addEventListener('blur', blur); editor.addEventListener('compositionend', end)
  return { editor, composer, attach, input, blur, end }
}
it('keeps empty attachments left, hides them on one text line, and returns without a layout flash', async () => {
  const { editor, composer, attach, input, blur } = await mount()
  const emptyLeft = editor.getBoundingClientRect().left
  expect(getComputedStyle(attach).display).not.toBe('none')
  await page.getByTestId('chat-composer').fill('一行文字')
  await until('one-line attachment hidden', () => composer.hasAttribute('data-phone-has-text') && getComputedStyle(attach).display === 'none')
  expect(editor.getBoundingClientRect().left).toBeLessThan(emptyLeft)
  await page.getByTestId('chat-composer').fill('第一行\n第二行')
  await until('attachment moved right', () => composer.hasAttribute('data-phone-multiline'))
  const send = composer.querySelector<HTMLElement>('[data-phone-send]')!, expand = composer.querySelector<HTMLElement>('[data-phone-editor-toggle]')!
  const a = attach.getBoundingClientRect(), s = send.getBoundingClientRect(), x = expand.getBoundingClientRect()
  expect(Math.abs(a.x + a.width / 2 - s.x - s.width / 2)).toBeLessThan(1)
  expect(x.bottom).toBeLessThanOrEqual(a.top); expect(a.bottom).toBeLessThanOrEqual(s.top)
  expect(editor.getBoundingClientRect().left - input.getBoundingClientRect().left).toBe(16)
  await page.getByTestId('chat-composer').fill('删回一行')
  await until('single line restored', () => !composer.hasAttribute('data-phone-multiline') && getComputedStyle(attach).display === 'none')
  const height = input.getBoundingClientRect().height
  for (let i = 0; i < 6; i++) { await frames(1); expect(input.getBoundingClientRect().height).toBe(height); expect(composer.hasAttribute('data-phone-multiline')).toBe(false) }
  await page.getByTestId('chat-composer').fill('')
  await until('empty attachment restored', () => !composer.hasAttribute('data-phone-has-text') && getComputedStyle(attach).display !== 'none')
  expect(editor.getBoundingClientRect().left).toBe(emptyLeft)
  expect(host!.querySelector('[contenteditable]')).toBe(editor); expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled()
})
it('freezes the empty-to-one-line layout throughout composition and applies it only after compositionend', async () => {
  const { editor, composer, attach, blur, end } = await mount(); editor.focus()
  const left = editor.getBoundingClientRect().left
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  const engine = (editor as HTMLElement & { editor: { commands: { setContent: (text: string) => void } } }).editor
  engine.commands.setContent('中'); editor.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '中' }))
  await frames()
  expect(composer.hasAttribute('data-phone-has-text')).toBe(false); expect(composer.hasAttribute('data-phone-multiline')).toBe(false)
  expect(editor.getBoundingClientRect().left).toBe(left); expect(getComputedStyle(attach).display).not.toBe('none'); expect(end).not.toHaveBeenCalled()
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
  await until('committed one-line layout', () => composer.hasAttribute('data-phone-has-text') && getComputedStyle(attach).display === 'none')
  expect(host!.querySelector('[contenteditable]')).toBe(editor); expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledTimes(1)
})
it('keeps a composing line-break in the original editor and preserves its caret when the committed layout changes', async () => {
  const { editor, composer, blur, end } = await mount()
  await page.getByTestId('chat-composer').fill('一行')
  await until('single text line', () => composer.hasAttribute('data-phone-has-text'))
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  const engine = (editor as HTMLElement & { editor: { commands: { setContent: (text: string) => void } } }).editor
  engine.commands.setContent('<p>第一行</p><p>正在输入中文</p>'); await frames()
  expect(composer.hasAttribute('data-phone-multiline')).toBe(false); expect(end).not.toHaveBeenCalled()
  const selection = getSelection()!, node = editor.lastElementChild!.firstChild!, range = document.createRange(); range.setStart(node, 2); range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
  await until('committed multi-line layout', () => composer.hasAttribute('data-phone-multiline'))
  expect(host!.querySelector('[contenteditable]')).toBe(editor); expect(selection.anchorNode).toBe(node); expect(selection.anchorOffset).toBe(2)
  expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledTimes(1)
})
