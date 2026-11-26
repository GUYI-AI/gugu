import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { ChatStoreProvider } from '@/store/chatContext'
import { i18n } from '@/i18n'
import { SelectionLineLayer } from '@renderer/features/sessions/annotations/selection-line'
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations'
import { chat, chatStore, createReactHarness, displayIdentity, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@/styles/tokens.css'

vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => []) } }))

// Selecting part of a member's message in a group and choosing 评论: the numbered box opens at the selection, and the
// comment joins the chat's draft (its tray counts it) — nothing is sent, and the whole message is not quoted.
const group = chat({ id: 'comment-group', kind: 'group', name: 'Group', member_user_ids: ['me', 'ada'] } as never)
const MESSAGES = [message({ id: 'm1', chat_id: 'comment-group', sender_user_id: 'ada', seq: 1, content: 'Run the gates before merge, then tag the beta.' })]
let harness: ReturnType<typeof createReactHarness>, layerHost: HTMLDivElement, layer: Root
const draft = () => sessionAnnotations.forConversation({ kind: 'chat', chatId: 'comment-group' })

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  draft().clear()
  layerHost = document.createElement('div')
  document.body.append(layerHost)
  layer = createRoot(layerHost)
  await act(async () => layer.render(<ChatStoreProvider value={chatStore()}><SelectionLineLayer /></ChatStoreProvider>))
})
afterEach(async () => {
  harness.cleanup()
  await act(async () => layer.unmount())
  layerHost.remove()
  draft().clear()
  window.getSelection()?.removeAllRanges()
})

function select(root: Element, words: string): DOMRect {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(words) ?? -1
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at); range.setEnd(node, at + words.length)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    return range.getBoundingClientRect()
  }
  throw new Error(`no "${words}" in the message`)
}

it('comments on part of a message at the selection, into the chat\'s draft', async () => {
  harness = createReactHarness()
  harness.container.style.height = '640px'
  await renderWithAppProviders(harness, <div style={{ height: 640, display: 'flex', flexDirection: 'column' }}><ChatAreaPanel /></div>, {
    auth: { id: 'me' },
    chat: { activeChat: group, activeChatId: 'comment-group', identitiesById: { ada: displayIdentity('ada', { display_name: 'Ada' }) }, messages: MESSAGES } as never,
  })
  await until('the message is drawn', () => !!harness.container.querySelector('[data-msg-id="m1"]'))
  const bubble = harness.container.querySelector<HTMLElement>('[data-msg-id="m1"]')!
  const box = select(bubble, 'Run the gates')
  await act(async () => { (document.elementFromPoint(box.left + 2, box.top + box.height / 2) ?? bubble).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 10, clientY: box.bottom + 4 })) })
  await until('the message menu', () => !!document.querySelector('[data-testid="message-action-menu"]'))
  const rows = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent?.trim())
  expect(rows).toEqual(['复制', '引用', '评论'])
  await act(async () => { await userEvent.click(document.querySelector<HTMLElement>('[data-testid="message-action-comment"]')!) })
  await until('the numbered box at the selection', () => !!document.querySelector('[data-selection-line] [data-annotation-editor]'))
  const line = document.querySelector<HTMLElement>('[data-selection-line]')!
  expect(line.textContent).toContain('1')
  expect(Math.abs(line.getBoundingClientRect().left - box.left)).toBeLessThan(40)
  // The box's input takes the page's selection away; the words being commented on stay marked while it is open.
  const marked = () => [...(CSS.highlights.get('gugu-selection-line') ?? [])].map((range) => range.toString())
  expect(window.getSelection()?.toString()).toBe('')
  expect(marked()).toEqual(['Run the gates'])
  await userEvent.keyboard('Which gates?')
  await userEvent.keyboard('{Enter}')
  await until('the comment joined the draft', () => draft().items.length === 1)
  expect(CSS.highlights.has('gugu-selection-line'), 'saved: the mark goes with the box').toBe(false)
  expect(draft().items[0]).toMatchObject({ kind: 'message', messageId: 'm1', authorId: 'ada', text: 'Run the gates', annotation: 'Which gates?' })
  expect(document.querySelector('[data-selection-line]')).toBeNull()
  await until('the tray counts it', () => harness.container.querySelector('[data-composer-annotations]')?.textContent?.includes('1 条评论') ?? false)
})
