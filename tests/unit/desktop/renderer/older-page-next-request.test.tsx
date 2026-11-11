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

/**
 * A reveal reads back to a message that may lie thousands of turns up. Each prepend rebuilds the list, so the pages on
 * the way land a batch at a time: neither one rebuild per page, nor everything in a single rebuild that holds the
 * window for seconds.
 */
const page = (from: number, count: number) => Array.from({ length: count }, (_unused, index) => turn(from + index))

function revealHarness(pages: TranscriptTurn[][], extra: Record<string, unknown> = {}) {
  const state = { committedTurns: [turn(10_000)] as readonly TranscriptTurn[], activeTurnSnapshot: null }
  const store = {
    sessionId: 'task-a',
    chatState: { transcript: { state } },
    get canLoadOlderHistory() { return pages.length > 0 },
    loadOlderHistory: vi.fn(async () => pages.shift() ?? []),
    historyEpoch: 0,
    ...extra,
  }
  const landed: TranscriptTurn[][] = []
  const view = { scrollToItem: vi.fn(), loadOlder: (older: TranscriptTurn[]) => {
    landed.push(older)
    state.committedTurns = [...older, ...state.committedTurns]
  } }
  let ask: ((until?: (turns: readonly TranscriptTurn[]) => boolean) => Promise<TranscriptTurn[]>) | null = null
  function Harness() {
    const viewRef = useRef(view as unknown as ChatView)
    ask = useSessionSourceMessage(store, viewRef, () => {}).loadOlder
    return null
  }
  act(() => root.render(<Harness />))
  return { store, state, landed, ask: (until?: (turns: readonly TranscriptTurn[]) => boolean) => ask!(until) }
}

it('reads back to a far message in batches, newest first, and stops at the page that holds it', async () => {
  // Ten pages of 100 turns, newest first; the target is in the eighth, and two more lie above it.
  const pages = Array.from({ length: 10 }, (_unused, index) => page(900 - index * 100, 100))
  const { store, state, landed, ask } = revealHarness(pages)
  const holds = (turns: readonly TranscriptTurn[]) => turns.some(one => one.seq === 250)

  await act(async () => { await ask(holds) })

  // Eight reads, and not the two pages above the target.
  expect(store.loadOlderHistory).toHaveBeenCalledTimes(8)
  expect(pages).toHaveLength(2)
  // Three prepends instead of eight, each within the batch size, and the history stays in order throughout.
  expect(landed.map(batch => batch.length)).toEqual([300, 300, 200])
  expect(landed.map(batch => [batch[0]!.seq, batch.at(-1)!.seq])).toEqual([[700, 999], [400, 699], [200, 399]])
  expect(state.committedTurns.map(one => one.seq)).toEqual([...Array.from({ length: 800 }, (_unused, index) => 200 + index), 10_000])
})

it('reads one page when nothing is being looked for', async () => {
  const { store, landed, ask } = revealHarness([page(900, 100), page(800, 100)])
  await act(async () => { await ask() })
  expect(store.loadOlderHistory).toHaveBeenCalledTimes(1)
  expect(landed.map(batch => batch.length)).toEqual([100])
})

it('lets the list join a reveal that is reading, without a second read of its own', async () => {
  const gate = Promise.withResolvers<void>()
  const pages = [page(900, 100), page(800, 100)]
  const { store, landed, ask } = revealHarness(pages, {
    loadOlderHistory: vi.fn(async () => { await gate.promise; return pages.shift() ?? [] }),
  })
  const reveal = ask(turns => turns.some(one => one.seq === 850))
  const list = ask()
  gate.resolve()
  await act(async () => { await Promise.all([reveal, list]) })
  expect(store.loadOlderHistory).toHaveBeenCalledTimes(2)
  expect(landed.map(batch => batch.length)).toEqual([200])
  expect(await list).toBe(await reveal)
})

it('drops the pages it holds when the conversation draws its history anew', async () => {
  const pages = [page(900, 100), page(800, 100), page(700, 100)]
  const { store, landed, ask } = revealHarness(pages)
  // The second read comes back after the store started over: what was read belongs to the history it dropped.
  store.loadOlderHistory = vi.fn(async () => { if (pages.length === 2) store.historyEpoch = 1; return pages.shift() ?? [] })
  let result: TranscriptTurn[] = []
  await act(async () => { result = await ask(turns => turns.some(one => one.seq === 0)) })
  expect(landed).toEqual([])
  expect(result).toEqual([])
  expect(store.loadOlderHistory).toHaveBeenCalledTimes(2)
})
