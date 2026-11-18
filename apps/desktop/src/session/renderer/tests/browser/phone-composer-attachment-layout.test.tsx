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
type ComposerEngine = {
  isEmpty: boolean
  commands: { clearContent: (emitUpdate: boolean) => boolean; setContent: (html: string) => boolean }
  on: (event: 'update', callback: () => void) => unknown
  off: (event: 'update', callback: () => void) => unknown
}
async function clearComposer(editor: HTMLElement) {
  const engine = (editor as HTMLElement & { editor: ComposerEngine }).editor
  let committed = false
  const updated = () => { if (engine.isEmpty) committed = true }
  engine.on('update', updated)
  try {
    // The App clears this same way after send. fill('') instead selects only
    // the DOM and presses Delete, before ProseMirror must know that selection.
    engine.commands.clearContent(true)
    await until('empty editor transaction committed', () => committed && engine.isEmpty && !editor.textContent?.trim())
  } finally { engine.off('update', updated) }
}
it('keeps attachments reachable in every line state and adds expand at three lines', async () => {
  const { editor, composer, attach, input, blur } = await mount()
  const emptyLeft = editor.getBoundingClientRect().left
  const emptyWidth = editor.getBoundingClientRect().width
  expect(attach.getBoundingClientRect().width).toBe(44)
  expect(attach.getBoundingClientRect().right).toBeLessThanOrEqual(emptyLeft)
  await page.getByTestId('chat-composer').fill('一行文字')
  await until('one-line draft committed', () => composer.hasAttribute('data-phone-has-text'))
  expect(attach.getBoundingClientRect().right).toBeLessThanOrEqual(emptyLeft)
  expect(editor.getBoundingClientRect().left).toBe(emptyLeft)
  const engine = (editor as HTMLElement & { editor: ComposerEngine }).editor
  engine.commands.setContent('<p>第一行</p><p>第二行</p>')
  await until('two-line attachment replaces expand', () => composer.hasAttribute('data-phone-multiline') && getComputedStyle(attach).display !== 'none')
  const lines = () => [...editor.children].reduce((total, child) => total + child.getBoundingClientRect().height / parseFloat(getComputedStyle(editor).lineHeight), 0)
  expect(lines()).toBe(2)
  expect(editor.getBoundingClientRect().width).toBe(emptyWidth)
  expect(composer.hasAttribute('data-phone-attachment-row')).toBe(false)
  const twoLineHeight = input.getBoundingClientRect().height
  // Owner 2026-11-17: two lines stay compact; the three-control stack is reserved only from the third line.
  expect(twoLineHeight).toBe(80)
  expect(composer.querySelector('[data-phone-editor-toggle]')).toBeNull()
  expect(attach.getBoundingClientRect().height).toBe(32)
  engine.commands.setContent('<p>第一行</p><p>第二行</p><p>第三行</p>')
  await until('third line shows the expand control', () => composer.hasAttribute('data-phone-attachment-row') && !!composer.querySelector('[data-phone-editor-toggle]'))
  expect(lines()).toBe(3)
  expect(composer.hasAttribute('data-phone-multiline')).toBe(true)
  expect(input.getBoundingClientRect().height).toBe(128)
  const send = composer.querySelector<HTMLElement>('[data-phone-send]')!, expand = composer.querySelector<HTMLElement>('[data-phone-editor-toggle]')!
  const a = attach.getBoundingClientRect(), s = send.getBoundingClientRect(), x = expand.getBoundingClientRect()
  expect(Math.abs(a.x + a.width / 2 - s.x - s.width / 2)).toBeLessThan(1)
  expect(x.bottom).toBeLessThanOrEqual(a.top); expect(a.bottom).toBeLessThanOrEqual(s.top)
  expect(editor.getBoundingClientRect().left - input.getBoundingClientRect().left).toBe(16)
  engine.commands.setContent('<p>第一行</p><p>第二行</p>')
  await until('deleting the third line keeps attachment and hides expand', () => !composer.hasAttribute('data-phone-attachment-row') && getComputedStyle(attach).display !== 'none' && !composer.querySelector('[data-phone-editor-toggle]'))
  expect(lines()).toBe(2)
  expect(composer.hasAttribute('data-phone-multiline')).toBe(true)
  expect(input.getBoundingClientRect().height).toBe(twoLineHeight)
  expect(attach.getBoundingClientRect().height).toBe(32)
  expect(composer.querySelector('[data-phone-editor-toggle]')).toBeNull()
  engine.commands.setContent('<p>删回一行</p>')
  await until('single line restored', () => !composer.hasAttribute('data-phone-multiline') && attach.getBoundingClientRect().right <= editor.getBoundingClientRect().left)
  const height = input.getBoundingClientRect().height
  for (let i = 0; i < 6; i++) { await frames(1); expect(input.getBoundingClientRect().height).toBe(height); expect(composer.hasAttribute('data-phone-multiline')).toBe(false) }
  await clearComposer(editor)
  await until('empty capsule retains its attachment', () => !composer.hasAttribute('data-phone-has-text') && attach.getBoundingClientRect().width === 44)
  expect(editor.getBoundingClientRect().left).toBe(emptyLeft)
  expect(host!.querySelector('[contenteditable]')).toBe(editor); expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled()
})
it.each(['', '一行文字'])('opens the photo picker action from the attachment button with draft %j', async draft => {
  const { composer, attach } = await mount()
  if (draft) {
    await page.getByTestId('chat-composer').fill(draft)
    await until('single-line draft committed', () => composer.hasAttribute('data-phone-has-text'))
  }
  expect(composer.hasAttribute('data-phone-multiline')).toBe(false)
  const input = host!.querySelector<HTMLInputElement>('input[accept="image/*"][multiple]')!
  const pick = vi.spyOn(input, 'click').mockImplementation(() => {})
  await page.elementLocator(attach).click()
  await page.getByTestId('chat-composer-attach-photos').click()
  expect(pick).toHaveBeenCalledTimes(1)
  expect(host!.querySelector('[contenteditable]')?.textContent).toBe(draft)
})
it('defers the third-line expand control until compositionend without replacing the input or losing the caret', async () => {
  const { editor, composer, attach, blur, end } = await mount()
  await page.getByTestId('chat-composer').fill('第一行\n第二行')
  await until('two committed lines with attachment', () => composer.hasAttribute('data-phone-multiline') && getComputedStyle(attach).display !== 'none')
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  const engine = (editor as HTMLElement & { editor: { commands: { setContent: (text: string) => void } } }).editor
  engine.commands.setContent('<p>第一行</p><p>第二行</p><p>正在输入中文</p>')
  await frames()
  expect(composer.hasAttribute('data-phone-attachment-row')).toBe(false)
  expect(getComputedStyle(attach).display).not.toBe('none')
  expect(composer.querySelector('[data-phone-editor-toggle]')).toBeNull()
  expect(end).not.toHaveBeenCalled()
  const selection = getSelection()!, node = editor.lastElementChild!.firstChild!, range = document.createRange()
  range.setStart(node, 2); range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
  await until('third-line attachment committed', () => composer.hasAttribute('data-phone-attachment-row') && getComputedStyle(attach).display !== 'none')
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
  expect(selection.anchorNode).toBe(node); expect(selection.anchorOffset).toBe(2)
  expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledTimes(1)
})
it('freezes the empty-to-one-line layout throughout composition and applies it only after compositionend', async () => {
  const { editor, composer, attach, blur, end } = await mount(); editor.focus()
  const left = editor.getBoundingClientRect().left
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  const engine = (editor as HTMLElement & { editor: { commands: { setContent: (text: string) => void } } }).editor
  engine.commands.setContent('中'); editor.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '中' }))
  await frames()
  expect(composer.hasAttribute('data-phone-has-text')).toBe(false); expect(composer.hasAttribute('data-phone-multiline')).toBe(false)
  expect(editor.getBoundingClientRect().left).toBe(left); expect(attach.getBoundingClientRect().width).toBe(44); expect(end).not.toHaveBeenCalled()
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
  await until('committed one-line layout', () => composer.hasAttribute('data-phone-has-text') && attach.getBoundingClientRect().width === 44)
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

it('keeps attachments reachable on clear even if DOM selectionchange has not reached the editor', async () => {
  const { editor, composer, attach, blur } = await mount()
  await page.getByTestId('chat-composer').fill('删回一行')
  await until('one-line text committed', () => composer.hasAttribute('data-phone-has-text'))
  const defer = (event: Event) => event.stopImmediatePropagation()
  document.addEventListener('selectionchange', defer, true)
  try {
    const selection = getSelection()!, range = document.createRange()
    range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range)
    await clearComposer(editor)
    await until('attachment stays reachable after delayed selection', () => !composer.hasAttribute('data-phone-has-text') && attach.getBoundingClientRect().width === 44)
    expect(host!.querySelector('[contenteditable]')).toBe(editor)
    expect(document.activeElement).toBe(editor); expect(blur).not.toHaveBeenCalled()
  } finally { document.removeEventListener('selectionchange', defer, true) }
})
