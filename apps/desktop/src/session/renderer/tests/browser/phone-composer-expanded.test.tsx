import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { root?.unmount(); host?.remove(); document.documentElement.removeAttribute('data-theme'); root = null; host = null })

async function mount(width = 390) {
  await page.viewport(width, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = `position:fixed;bottom:0;left:0;width:${width}px;padding:8px;box-sizing:border-box`
  const send = vi.fn(async () => {})
  root = createRoot(host)
  root.render(<LocalizationProvider><ChatMessageComposer onSend={send} /></LocalizationProvider>)
  await until('phone editor mounted', () => !!host?.querySelector('[contenteditable]'))
  return { editor: host.querySelector<HTMLElement>('[contenteditable]')!, send }
}

it.each([320, 390, 600])('%ipx: text scrolls after four lines and both bottom controls stay inside the capsule', async (width) => {
  const { editor } = await mount(width)
  const input = host!.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const attach = host!.querySelector<HTMLElement>('[data-testid="chat-composer-attach-menu"]')!
  const send = host!.querySelector<HTMLElement>('[data-phone-send]')!
  const height = input.getBoundingClientRect().height
  expect(host!.querySelector('[data-phone-editor-toggle]')).toBeNull()
  await page.getByTestId('chat-composer').fill('第一行\n第二行\n第三行\n第四行')
  await until('expand control appears', () => !!host?.querySelector('[data-phone-editor-toggle]'))
  const four = input.getBoundingClientRect().height
  expect(four).toBeGreaterThan(height)
  await page.getByTestId('chat-composer').fill(Array.from({ length: 16 }, (_, i) => `第 ${i} 行中文`).join('\n'))
  await until('long input scrolls', () => input.scrollHeight > input.clientHeight)
  expect(input.getBoundingClientRect().height).toBe(four)
  const bounds = input.getBoundingClientRect()
  for (const control of [attach, send]) {
    const box = control.getBoundingClientRect()
    expect(box.left).toBeGreaterThanOrEqual(bounds.left)
    expect(box.right).toBeLessThanOrEqual(bounds.right)
    expect(box.bottom).toBeLessThanOrEqual(bounds.bottom)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
  const text = editor.getBoundingClientRect()
  expect(text.left).toBeGreaterThanOrEqual(attach.getBoundingClientRect().right)
  expect(text.right).toBeLessThanOrEqual(send.getBoundingClientRect().left)
})

it.each(['dark', 'light'] as const)('%s: expand/collapse preserves editor identity, selection and an ongoing composition without blur', async (theme) => {
  document.documentElement.dataset.theme = theme
  const { editor, send } = await mount()
  await page.getByTestId('chat-composer').fill('第一行\n第二行，继续输入中文')
  await until('expand control appears', () => !!host?.querySelector('[data-phone-editor-toggle]'))
  const selection = window.getSelection()!
  const range = document.createRange()
  const textNode = editor.lastElementChild!.firstChild!
  range.setStart(textNode, 3); range.collapse(true)
  selection.removeAllRanges(); selection.addRange(range)
  const before = { node: selection.anchorNode, offset: selection.anchorOffset, text: editor.textContent }
  const blur = vi.fn(), compositionEnd = vi.fn()
  editor.addEventListener('blur', blur)
  editor.addEventListener('compositionend', compositionEnd)
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
  editor.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'zhong' }))
  // Browser pointer input exercises preventDefault instead of programmatic .click().
  await page.getByRole('button', { name: translateSessionMessage('composer.expandEditor') }).click()
  await until('expanded layout', () => !!host?.querySelector('[data-phone-expanded]'))
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
  expect(document.activeElement).toBe(editor)
  expect(selection.anchorNode).toBe(before.node)
  expect(selection.anchorOffset).toBe(before.offset)
  expect(editor.textContent).toBe(before.text)
  expect(blur).not.toHaveBeenCalled()
  expect(compositionEnd).not.toHaveBeenCalled()
  const panel = host!.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
  await until('panel has finished rising inside the viewport', () => panel.getBoundingClientRect().bottom <= 844)
  const expanded = panel.getBoundingClientRect()
  expect(expanded.left).toBe(0)
  expect(expanded.right).toBe(390)
  expect(expanded.top).toBeLessThan(60)
  expect(expanded.bottom).toBeLessThanOrEqual(844)
  await page.getByRole('button', { name: translateSessionMessage('composer.collapseEditor') }).click()
  await until('collapsed layout', () => !host?.querySelector('[data-phone-expanded]'))
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
  expect(document.activeElement).toBe(editor)
  expect(selection.anchorNode).toBe(before.node)
  expect(selection.anchorOffset).toBe(before.offset)
  expect(blur).not.toHaveBeenCalled()
  expect(compositionEnd).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  // A real completion is still delivered to the original node after both transitions.
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
  expect(compositionEnd).toHaveBeenCalledTimes(1)
})

it('sending from the expanded editor collapses it and dismisses keyboard focus', async () => {
  const { editor, send } = await mount()
  await page.getByTestId('chat-composer').fill('第一行\n第二行')
  await until('expand control appears', () => !!host?.querySelector('[data-phone-editor-toggle]'))
  await page.getByRole('button', { name: translateSessionMessage('composer.expandEditor') }).click()
  await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage') }).click()
  await until('sent', () => send.mock.calls.length === 1)
  expect(host!.querySelector('[data-phone-expanded]')).toBeNull()
  expect(editor.textContent).toBe('')
  expect(document.activeElement).toBe(document.body)
})
