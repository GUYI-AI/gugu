/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createChatContext } from '../chat-context'
import { createChatState } from '../state/chat-state'
import { createChatView } from '../chat-view'
import type { TranscriptTurn } from '../model'
import { until } from '../../../../tests/support/awaitCondition'

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
})

// Reported on a phone: opening a long conversation again drew one frame about a screen above the
// latest reply, then jumped to it. Rows mounting in a frame measure taller than their estimate;
// the reader following the tail must see the bottom in that very frame, not one frame later.
it.each([390, 1024])(
  'a reader at the tail sees the bottom in every drawn frame while rows mount (%i)',
  async (width) => {
    await page.viewport(width, 800)
    const context = createChatContext({
      locale: () => 'en-US',
      layout: { preset: 'double', userGutter: 0, agentConversation: true }
    })
    const state = createChatState(context)
    const host = document.body.appendChild(document.createElement('div'))
    host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:700px`
    const turns = (extra: number) =>
      Array.from(
        { length: 40 },
        (_, n): TranscriptTurn => ({
          id: `turn-${n}`,
          seq: n,
          initiator: 'user',
          outcome: { kind: 'done' },
          items: [
            { kind: 'message', id: `user-${n}`, seq: 0, role: 'user', text: `Question ${n}` },
            {
              kind: 'message',
              id: `reply-${n}`,
              seq: 1,
              role: 'assistant',
              text: `Reply ${n}.${n >= 34 ? '\n\nMore since you left.'.repeat(extra) : ''}`
            }
          ]
        })
      )
    // First visit: every row measured, the heights kept for the next visit.
    state.transcript.history.seed(turns(0))
    const first = createChatView({
      context,
      state,
      parent: host,
      stickToBottom: true,
      padBottom: 140
    })
    first.setScrollMode({ kind: 'tail' })
    await until(
      'first visit rows mounted',
      () => host.querySelectorAll('[data-item-id]').length > 0
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    first.dispose()
    // While away the last replies grew, so the kept heights are now short of the real ones.
    state.transcript.history.seed(turns(4))
    const drawn: { rows: number; gap: number }[] = []
    let sampling = true
    // After each frame is drawn: how far the view is from the bottom of what is actually laid out.
    const sample = () =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          if (!sampling) return
          const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')
          const rows = host.querySelectorAll('[data-item-id]').length
          if (scroller && rows > 0)
            drawn.push({
              rows,
              gap: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
            })
          sample()
        }, 0)
      )
    sample()
    const view = createChatView({
      context,
      state,
      parent: host,
      stickToBottom: true,
      padBottom: 140
    })
    cleanup.push(() => {
      sampling = false
      view.dispose()
      state.dispose()
      context.dispose()
      host.remove()
    })
    await until('rows mounted', () => host.querySelectorAll('[data-item-id]').length > 0)
    await new Promise((resolve) => setTimeout(resolve, 600))
    sampling = false
    expect(drawn.length).toBeGreaterThan(3)
    expect(
      drawn.filter((frame) => frame.gap > 1),
      JSON.stringify(drawn.slice(0, 8))
    ).toEqual([])
  }
)

// The phone puts its composer into the slot after the conversation is drawn; the slot's height reaches the list
// through a ResizeObserver, after the frame's write phase. The latest reply must clear the composer in that frame.
it.each([390, 1024])(
  'the latest reply clears a composer that arrives under it in the same frame (%i)',
  async (width) => {
    await page.viewport(width, 800)
    const context = createChatContext({
      locale: () => 'en-US',
      layout: { preset: 'double', userGutter: 0, agentConversation: true }
    })
    const state = createChatState(context)
    const host = document.body.appendChild(document.createElement('div'))
    host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:700px`
    state.transcript.history.seed(
      Array.from(
        { length: 30 },
        (_, n): TranscriptTurn => ({
          id: `turn-${n}`,
          seq: n,
          initiator: 'user',
          outcome: { kind: 'done' },
          items: [
            { kind: 'message', id: `user-${n}`, seq: 0, role: 'user', text: `Question ${n}` },
            {
              kind: 'message',
              id: `reply-${n}`,
              seq: 1,
              role: 'assistant',
              text: `Reply ${n}.\n\nA second paragraph.`
            }
          ]
        })
      )
    )
    const view = createChatView({
      context,
      state,
      parent: host,
      stickToBottom: true,
      composer: 'slot'
    })
    cleanup.push(() => {
      sampling = false
      view.dispose()
      state.dispose()
      context.dispose()
      host.remove()
    })
    view.setScrollMode({ kind: 'tail' })
    await until('rows mounted', () => host.querySelectorAll('[data-item-id]').length > 0)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const slot = view.composerSlot!
    const last = () => [...host.querySelectorAll<HTMLElement>('[data-item-id]')].at(-1)
    const overlaps: number[] = []
    let sampling = true
    // After each frame is drawn: how far the last row reaches below the top of the composer.
    const sample = () =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          // A frame already queued when the test stops must not read a torn-down view.
          if (!sampling) return
          const row = last()
          if (row)
            overlaps.push(
              Math.round(row.getBoundingClientRect().bottom - slot.getBoundingClientRect().top)
            )
          sample()
        }, 0)
      )
    const composer = document.createElement('div')
    composer.style.height = '90px'
    slot.append(composer)
    sample()
    await new Promise((resolve) => setTimeout(resolve, 400))
    sampling = false
    expect(overlaps.length).toBeGreaterThan(3)
    expect(
      overlaps.filter((overlap) => overlap > 0),
      JSON.stringify(overlaps.slice(0, 8))
    ).toEqual([])
  }
)
