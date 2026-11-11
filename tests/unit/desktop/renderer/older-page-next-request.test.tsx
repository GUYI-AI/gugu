// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatView, TranscriptTurn } from '@gugu/session-chat-ui'
import { useSessionSourceMessage } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-session-source-message'

/**
 * The list asks for the page above as soon as a page lands: its rows changed and the reader is still at the top.
 * That ask arrives while the hook is still finishing the request that brought the page (it waits one frame for the
 * layout). It must be a new read. Handed the finished request instead, the list has asked, got nothing new, and does
 * not ask again until the reader scrolls away and back: the transcript looks like it has no more history.
 */
const turn = (seq: number): TranscriptTurn => ({
  id: `turn-${seq}`, seq, initiator: 'user',
  items: [{ kind: 'message', id: `message-${seq}`, role: 'user', text: `message ${seq}` }],
} as unknown as TranscriptTurn)

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('reads the page above when the list asks for it the moment a page lands', async () => {
  const pages = [[turn(2)], [turn(1)], [turn(0)]]
  const state = { committedTurns: [turn(3)] as readonly TranscriptTurn[], activeTurnSnapshot: null }
  const store = {
    sessionId: 'task-a',
    chatState: { transcript: { state } },
    get canLoadOlderHistory() { return pages.length > 0 },
    loadOlderHistory: vi.fn(async () => pages.shift() ?? []),
  }
  let ask: (() => Promise<TranscriptTurn[]>) | null = null
  const asked: Promise<unknown>[] = []
  const view = {
    scrollToItem: vi.fn(),
    // What the list does on a landed page: its rows changed, the reader is still at the top, so it asks again.
    loadOlder: (older: TranscriptTurn[]) => {
      state.committedTurns = [...older, ...state.committedTurns]
      asked.push(ask!())
    },
  }
  function Harness() {
    const viewRef = useRef(view as unknown as ChatView)
    ask = useSessionSourceMessage(store, viewRef, () => {}).loadOlder
    return null
  }
  act(() => root.render(<Harness />))

  asked.push(ask!())
  // Every ask the list made, including the ones it made while an earlier page was landing.
  await act(async () => { while (asked.length) await asked.shift() })

  expect(state.committedTurns.map(item => item.seq)).toEqual([0, 1, 2, 3])
  // One read per page, and one more that finds the start of the history.
  expect(store.loadOlderHistory).toHaveBeenCalledTimes(4)
})

it('still shares one read between two asks made while it is running', async () => {
  const page = Promise.withResolvers<TranscriptTurn[]>()
  const state = { committedTurns: [turn(1)] as readonly TranscriptTurn[], activeTurnSnapshot: null }
  const store = {
    sessionId: 'task-a',
    chatState: { transcript: { state } },
    canLoadOlderHistory: true,
    loadOlderHistory: vi.fn(() => page.promise),
  }
  const landed: TranscriptTurn[][] = []
  const view = { scrollToItem: vi.fn(), loadOlder: (older: TranscriptTurn[]) => { landed.push(older) } }
  let ask: (() => Promise<TranscriptTurn[]>) | null = null
  function Harness() {
    const viewRef = useRef(view as unknown as ChatView)
    ask = useSessionSourceMessage(store, viewRef, () => {}).loadOlder
    return null
  }
  act(() => root.render(<Harness />))

  const first = ask!(), second = ask!()
  page.resolve([turn(0)])
  await act(async () => { await Promise.all([first, second]) })

  expect(store.loadOlderHistory).toHaveBeenCalledTimes(1)
  expect(landed).toEqual([[turn(0)]])
})
