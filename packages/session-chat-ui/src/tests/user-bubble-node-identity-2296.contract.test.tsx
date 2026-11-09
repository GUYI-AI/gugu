/** @jsxImportSource solid-js */
import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { TranscriptTurn } from '@session-chat/model'
import { connectSession, createChatState } from '@session-chat/state/chat-state'
import { batch } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { until } from '../../../../tests/support/awaitCondition'

/**
 * #2296 — one sent input keeps ONE bubble DOM node from submit to settled history.
 *
 * The sequence mirrors the desktop host: the store draws the pending input, the runtime's live turn
 * reaches the view through `connectSession` (native turn first without the withheld echo, then the
 * receipt-correlated echo), and on commit the host reconciles history in one batch that seeds the
 * finished turn and clears the retained live frame.
 *
 * Rows are rendered per visible index. Any intermediate units view in which the bubble's index is empty
 * (or held by another unit) unmounts that row and mounts a new one a pass later, so the assertions are:
 *  - the bubble card, its row and the per-index wrapper are the same nodes in every phase;
 *  - no row wrapper is removed and re-added for the same index within one synchronous flush (an index read
 *    as an undefined unit for one pass);
 *  - a selection made in the bubble while it is sending is still there, with the same text, once the turn
 *    has settled into history.
 */
const teardown: Array<() => void> = []
afterEach(() => { while (teardown.length) teardown.pop()?.() })

function live<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    set(next: T) { value = next; for (const listener of listeners) listener() },
  }
}

const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

function history(count: number): TranscriptTurn[] {
  const at = Date.now() - 60_000
  return Array.from({ length: count }, (_, seq) => ({
    id: `old-${seq}`, seq, initiator: 'user', startedAt: at + seq * 10, endedAt: at + seq * 10 + 5,
    items: [
      { kind: 'message', id: `old-${seq}-user`, seq: 0, role: 'user', text: `Previous input ${seq}` },
      { kind: 'thinking', id: `old-${seq}-think`, seq: 1, status: 'done', text: 'Thought', startedAt: at + seq * 10, durationMs: 900 },
      { kind: 'message', id: `old-${seq}-reply`, seq: 2, role: 'assistant', text: `Previous reply ${seq}` },
    ],
    outcome: { kind: 'done' },
  }) as TranscriptTurn)
}

describe.each([
  { previous: 0, nativeBeforeReceipt: true },
  { previous: 12, nativeBeforeReceipt: true },
  { previous: 0, nativeBeforeReceipt: false },
  { previous: 12, nativeBeforeReceipt: false },
])('user bubble node identity (#2296), $previous previous turns, native turn before receipt: $nativeBeforeReceipt', ({ previous, nativeBeforeReceipt }) => {
  it('keeps the bubble, row and wrapper nodes from sending to committed history', async () => {
    const context = createChatContext({ locale: () => 'en-US', theme: DEFAULT_THEME })
    context.setLayout({ preset: 'double', userGutter: 96, agentConversation: true })
    const state = createChatState(context)
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;width:640px;height:600px'
    document.body.append(host)
    const view = createChatView({ context, state, parent: host, pinUserMessages: true })
    const prior = history(previous)
    if (prior.length) state.transcript.history.seed(prior)
    view.setScrollMode({ kind: 'tail' })

    const activeTurn = live<TranscriptTurn | null>(null)
    const sessionState = live({ pendingPermissions: [], isGenerating: false })
    let committed: TranscriptTurn | null = null
    const disconnect = connectSession(state, { activeTurn, plan: live(null), sessionState }, {
      // The host reconciles history, then seeds the finished turn and clears the retained frame together.
      onTurnCommitted: () => queueMicrotask(() => batch(() => {
        state.transcript.history.seed([...prior, committed!])
        state.transcript.activeTurn.set(null)
      })),
    })
    teardown.push(() => { disconnect(); view.dispose(); state.dispose(); context.dispose(); host.remove() })

    const id = 'client-2296'
    const text = 'Check the bubble identity.'
    const sentAt = Date.now()
    const selector = `[data-user-card="${id}"]`
    const nodes = () => {
      const card = host.querySelector(selector)
      const row = card?.closest('[data-row-kind]') ?? null
      return { count: host.querySelectorAll(selector).length, card, row, wrapper: row?.closest('[data-index]') ?? null }
    }
    const canvas = host.querySelector('[data-chat-canvas]')!
    const remounted: string[] = []
    const phase = async (name: string, act: () => void) => {
      // One delivery holds the mutations of one synchronous flush. A wrapper removed and added again for the same
      // index there is a row whose unit was read as undefined (or as another unit) for one pass. Rows leaving and
      // re-entering the overscan window across frames are ordinary virtualization and arrive in separate deliveries.
      const observer = new MutationObserver(records => {
        const removed = new Set<string>()
        for (const record of records) {
          for (const node of record.removedNodes) if (node instanceof HTMLElement && node.dataset.index) removed.add(node.dataset.index)
          for (const node of record.addedNodes) if (node instanceof HTMLElement && node.dataset.index && removed.has(node.dataset.index)) remounted.push(`${name}: index ${node.dataset.index}`)
        }
      })
      observer.observe(canvas, { childList: true })
      act()
      await frames()
      observer.disconnect()
      return { name, ...nodes() }
    }

    state.session.setPendingPrompt({ id, text, sentAt, held: true, delivery: { state: 'sending' } })
    await until('the sending bubble is drawn', () => nodes().count === 1)
    const first = { name: 'sending', ...nodes() }
    expect(first.card && first.row && first.wrapper).toBeTruthy()
    // A reader's selection inside the bubble lives on its text nodes: it survives only if the nodes do.
    const selection = getSelection()!
    selection.selectAllChildren(first.card!.querySelector('[data-agent-conversation-message]') ?? first.card!)
    const selected = selection.toString()
    expect(selected).toContain(text)

    const echo = { kind: 'message', role: 'user', id, seq: 0, text, _meta: { guguClientMessageId: id, guguNativeMessageId: 'native-2296' } }
    const thinking = (status: 'streaming' | 'done') => ({ kind: 'thinking', id: 'think-2296', seq: 1, status, text: 'Reading', startedAt: sentAt + 1400, ...(status === 'done' ? { durationMs: 800 } : {}) })
    const turn = (items: unknown[]) => ({ id: 'native-2296', seq: previous, initiator: 'user', startedAt: sentAt + 1300, items }) as TranscriptTurn

    const phases = [first]
    phases.push(await phase('receiving', () => state.session.setPendingPrompt({ id, text, sentAt, held: true, delivery: { state: 'receiving' } })))
    if (nativeBeforeReceipt) {
      // The runtime withholds the uncorrelated echo: the native turn starts without the input.
      phases.push(await phase('native turn, echo withheld', () => { sessionState.set({ pendingPermissions: [], isGenerating: true }); activeTurn.set(turn([thinking('streaming')])) }))
    }
    phases.push(await phase('receipt binds the echo', () => { sessionState.set({ pendingPermissions: [], isGenerating: true }); activeTurn.set(turn([echo, thinking('streaming')])) }))
    phases.push(await phase('reply streams', () => activeTurn.set(turn([echo, thinking('done'), { kind: 'message', role: 'assistant', id: 'reply-2296', seq: 2, text: 'Done.' }]))))
    committed = { ...turn([echo, thinking('done'), { kind: 'message', role: 'assistant', id: 'reply-2296', seq: 2, text: 'Done.' }]), endedAt: sentAt + 9000, outcome: { kind: 'done' } } as TranscriptTurn
    phases.push(await phase('turn commits', () => { sessionState.set({ pendingPermissions: [], isGenerating: false }); activeTurn.set(null) }))
    await until('the committed turn owns the bubble', () => state.transcript.state.committedTurns.at(-1)?.id === 'native-2296' && !state.transcript.state.activeTurnSnapshot)
    phases.push({ name: 'settled history', ...nodes() })

    expect({
      phases: phases.map(p => ({ name: p.name, count: p.count, card: p.card === first.card, row: p.row === first.row, wrapper: p.wrapper === first.wrapper })),
      remounted,
      selection: { text: selection.toString(), inBubble: !!selection.anchorNode && first.card!.contains(selection.anchorNode) },
    }).toEqual({
      phases: phases.map(p => ({ name: p.name, count: 1, card: true, row: true, wrapper: true })),
      remounted: [],
      selection: { text: selected, inBubble: true },
    })
  })
})

/**
 * @@@sizes-follow-units — the virtualizer keeps one size per index. When the committed tier grows in the same
 * pass as the active tier (no intermediate pass any more, see @@@committed-tier-same-pass), a pending input can be
 * pushed one slot down onto an index that a hidden, zero-height A2A child held a moment ago. It must not inherit
 * that 0: a zero-size row is left out of the visible set and would never mount to measure itself.
 */
it('mounts a pending input pushed one slot down onto a hidden A2A child index (#2296)', async () => {
  const sender = 'user:fixture-2296-agent'
  const context = createChatContext({ locale: () => 'en-US',
    layout: { preset: 'double', userGutter: 0, agentConversation: true },
    actor: id => id === sender ? { id, name: 'Fixture peer', type: 'agent' } : null })
  const state = createChatState(context)
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;width:640px;height:600px'
  document.body.append(host)
  const view = createChatView({ context, state, parent: host, stickToBottom: true })
  teardown.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove() })
  const prior = history(3)
  state.transcript.history.seed(prior)
  const activityText = `<gugu_delivery route="session-direct" from="Fixture peer" from_id="${sender}" from_type="agent" msg="msg:fixture-2296"><![CDATA[Prior pending activity]]></gugu_delivery>`
  state.session.setPendingMessages([{ id: 'receiving-activity-2296', text: activityText, held: true, received: true,
    delivery: { state: 'receiving' }, afterTurnId: prior.at(-1)!.id }])
  await until('the receiving A2A header is drawn', () => !!host.querySelector('[data-agent-activity]'))
  view.setScrollMode({ kind: 'tail' })
  state.session.setPendingPrompt({ id: 'own-2296', text: 'My input after the pending Agent activity', held: true,
    delivery: { state: 'receiving' }, afterTurnId: prior.at(-1)!.id })
  const bubble = () => host.querySelector<HTMLElement>('[data-agent-conversation-message="own-2296"]')
  await until('the pending input is drawn', () => !!bubble())
  // The activity lands as a committed turn (header + hidden child) in front of the still pending input.
  batch(() => {
    state.transcript.history.seed([...prior, { id: 'committed-activity-2296', seq: prior.length, initiator: 'agent', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: 'native-activity-2296', seq: 0, role: 'user', text: activityText }] } as TranscriptTurn])
    state.session.setPendingMessages([])
  })
  await until('the pushed-down pending input is mounted again', () => !!bubble())
  await frames()
  const rect = bubble()!.getBoundingClientRect()
  expect({ height: rect.height > 0, inViewport: rect.bottom > 0 && rect.top < 600 }).toEqual({ height: true, inViewport: true })
})
