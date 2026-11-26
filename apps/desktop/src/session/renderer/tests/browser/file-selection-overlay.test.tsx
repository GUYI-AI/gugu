import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { runFileSelection } from '@renderer/features/sessions/annotations/file-selection-overlay'
import { SelectionLineLayer } from '@renderer/features/sessions/annotations/selection-line'
import type { FileSelectionAsk } from '@shared/extensions/file-selection'
import { APP_COMPOSE_EVENT } from '@shared/extensions/app-runtime-protocol'
import { ChatStoreProvider } from '@/store/chatContext'
import { chatStore } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@/styles/tokens.css'

// Cite or Send pressed on an App page's selection menu reaches the window (the menu itself is the page's runtime's). Here
// the page is a plain box of the same size: what is judged is the host's half — a draft, or the person's own line.
let guest: HTMLDivElement, host: HTMLDivElement, root: Root
const sendMessageToChat = vi.fn(async () => 'message-1')
beforeEach(async () => {
  sendMessageToChat.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<ChatStoreProvider value={chatStore({ sendMessageToChat })}><SelectionLineLayer /></ChatStoreProvider>))
  guest = document.createElement('div')
  Object.assign(guest.style, { position: 'fixed', left: '20px', top: '20px', width: '400px', height: '300px' })
  guest.tabIndex = -1
  document.body.append(guest)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  guest.remove()
})

const chatId = crypto.randomUUID()
const ask = (action: 'cite' | 'send'): FileSelectionAsk => ({
  webContentsId: 7, action, conversation: { kind: 'chat', chatId },
  file: { name: 'AGENTS.md', target: '/home/me/work/AGENTS.md' },
  pick: { text: 'run the gates', places: [{ at: { lines: '12-13' } }] },
  rect: { x: 40, y: 60, width: 120, height: 18 }, viewport: { width: 400, height: 300 },
})
const line = () => document.querySelector('[data-annotation-editor]')

it('Cite drafts the words and the file\'s pill into the conversation; nothing is sent', async () => {
  const drafts: unknown[] = []
  const take = (event: Event) => drafts.push((event as CustomEvent).detail)
  document.addEventListener(APP_COMPOSE_EVENT, take)
  await act(async () => runFileSelection(guest, null, ask('cite')))
  document.removeEventListener(APP_COMPOSE_EVENT, take)
  // A file on a computer is named in words in a chat, its path written out (a chat has no pill that opens it).
  expect(drafts).toMatchObject([{ chatId, text: expect.stringMatching(/^> run the gates\n\nAGENTS\.md \([^)]+\): \/home\/me\/work\/AGENTS\.md$/), refs: [] }])
  expect(line()).toBeNull()
  expect(sendMessageToChat).not.toHaveBeenCalled()
})

it('Cite of a chat folder\'s file drafts its pill alone: the link names the lines, the words are not quoted beside it', async () => {
  const drafts: Array<{ chatId: string; text: string; refs: { label: string; link: string }[] }> = []
  const take = (event: Event) => drafts.push((event as CustomEvent).detail)
  const link = `gugu-file://${crypto.randomUUID()}?v=2#lines=57`
  document.addEventListener(APP_COMPOSE_EVENT, take)
  await act(async () => runFileSelection(guest, null, { ...ask('cite'), file: { name: 'RETENTION.md', target: link.replace(/#.*/, '') },
    pick: { text: 'large files skip project groups', places: [{ at: { lines: '57' } }] } }))
  document.removeEventListener(APP_COMPOSE_EVENT, take)
  expect(drafts).toHaveLength(1)
  expect(drafts[0]!.text).toBe('')
  expect(drafts[0]!.refs).toEqual([{ label: expect.stringMatching(/^RETENTION\.md \(/), link }])
  expect(sendMessageToChat).not.toHaveBeenCalled()
})

it('Send opens the host\'s own line at the selection; only the person\'s submit sends, and a press elsewhere dismisses it', async () => {
  await act(async () => runFileSelection(guest, null, ask('send')))
  await until('the line is open at the selection', () => !!line())
  expect(line()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(20)
  expect(sendMessageToChat).not.toHaveBeenCalled()
  await act(async () => { await userEvent.keyboard('Say which gates{Enter}') })
  await until('sent into the group', () => sendMessageToChat.mock.calls.length === 1)
  expect(sendMessageToChat).toHaveBeenCalledWith(chatId, expect.stringMatching(/^> run the gates\n\nAGENTS\.md \([^)]+\): \/home\/me\/work\/AGENTS\.md\n\nSay which gates$/), { toUserIds: [] })
  await until('the line goes once sent', () => !line())
  await act(async () => runFileSelection(guest, null, ask('send')))
  await until('opened again', () => !!line())
  await act(async () => { await userEvent.click(guest) })
  await until('a press elsewhere dismisses it', () => !line())
  expect(sendMessageToChat).toHaveBeenCalledTimes(1)
})
