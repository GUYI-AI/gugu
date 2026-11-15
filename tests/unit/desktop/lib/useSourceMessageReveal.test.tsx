// @vitest-environment jsdom
// #1708 来源消息定位(群右栏工作区 App 的 gugu.showMessage → 壳的 app-show-message 事件):
// 已加载的、没加载的都交给会话滚动记忆的 revealMessage(载锚点、落位、核对),落稳了才闪;
// 载不到 / 等不来 → fail-loud,不滚去别处。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { askReveal, useSourceMessageReveal } from '../../../../apps/desktop/src/hooks/useSourceMessageReveal'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function setup(reveal: (id: string) => Promise<void> = () => Promise.resolve()) {
  const input = {
    activeChatId: 'g1', navigationTarget: true,
    setFlashMessageId: vi.fn(),
    flashTimerRef: { current: null },
    revealMessage: vi.fn(reveal),
    onMissing: vi.fn(),
  }
  function Probe() { useSourceMessageReveal(input); return null }
  await harness.render(createNode(Probe))
  const show = (messageId: string, chatId = 'g1') =>
    act(async () => { askReveal(chatId, messageId); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } })) })
  return { input, show }
}

describe('source message reveal', () => {
  it('hands a loaded message to revealMessage too, and flashes it once it has settled there', async () => {
    const c = await setup()
    await c.show('m41')
    expect(c.input.revealMessage).toHaveBeenCalledWith('m41')
    expect(c.input.setFlashMessageId).toHaveBeenCalledWith('m41')
    expect(c.input.onMissing).not.toHaveBeenCalled()
  })

  it('hands a message the chat has not loaded to revealMessage, and flashes it once it has settled', async () => {
    let settle: () => void = () => {}
    const c = await setup(() => new Promise<void>((resolve) => { settle = resolve }))
    await c.show('m1')
    expect(c.input.revealMessage).toHaveBeenCalledWith('m1')
    expect(c.input.setFlashMessageId).not.toHaveBeenCalled()
    await act(async () => { settle() })
    expect(c.input.setFlashMessageId).toHaveBeenCalledWith('m1')
    expect(c.input.onMissing).not.toHaveBeenCalled()
  })

  it('says so when the message cannot be shown (in a thread, deleted, never settled)', async () => {
    const c = await setup(() => Promise.reject(new Error('Saved conversation message is no longer available')))
    await c.show('gone')
    await vi.waitFor(() => expect(c.input.onMissing).toHaveBeenCalledOnce())
    expect(c.input.setFlashMessageId).not.toHaveBeenCalled()
  })

  it('another conversation opened before it was shown: a cancellation, not 「not found」', async () => {
    // The scroll memory rejects a pending reveal when its conversation changes; the reason travels with the rejection.
    const c = await setup(() => Promise.reject(new DOMException('The conversation changed before the message was shown', 'AbortError')))
    await c.show('m1')
    await act(async () => {})
    expect(c.input.onMissing).not.toHaveBeenCalled()
    expect(c.input.setFlashMessageId).not.toHaveBeenCalled()
  })

  it('a later request wins: an earlier one that settles late neither flashes nor complains', async () => {
    const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
    const c = await setup(() => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }) }))
    await c.show('m1')
    await c.show('m41')
    await act(async () => { pending[0].reject(new Error('superseded')); pending[1].resolve() })
    expect(c.input.onMissing).not.toHaveBeenCalled()
    expect(c.input.setFlashMessageId).toHaveBeenCalledTimes(1)
    expect(c.input.setFlashMessageId).toHaveBeenCalledWith('m41')
  })

  it('keeps local quote callbacks and routed App requests with their presentation target', async () => {
    const a = { reveal: vi.fn(async () => {}), flash: vi.fn(), show: null as ((id: string) => void) | null }
    const b = { reveal: vi.fn(async () => {}), flash: vi.fn(), show: null as ((id: string) => void) | null }
    function Pane({ view, viewportKey }: { view: typeof a; viewportKey: string }) {
      view.show = useSourceMessageReveal({ activeChatId: 'g1', viewportKey,
        setFlashMessageId: view.flash, flashTimerRef: { current: null }, revealMessage: view.reveal, onMissing: vi.fn() })
      return null
    }
    await harness.render(createNode('div', null, createNode(Pane, { view: a, viewportKey: 'slot-a' }), createNode(Pane, { view: b, viewportKey: 'slot-b' })))
    await act(async () => { a.show!('m40') })
    expect(a.reveal).toHaveBeenCalledOnce()
    expect(b.reveal).not.toHaveBeenCalled()
    await act(async () => { askReveal('g1', 'm41', 'slot-b'); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked)) })
    expect(a.reveal).toHaveBeenCalledOnce()
    expect(b.reveal).toHaveBeenCalledWith('m41')
  })

  it('lets only the target panel make way, then consumes its pending reveal after the list mounts', async () => {
    const navigate = vi.fn(), reveal = vi.fn(async () => {}), sibling = vi.fn()
    function Pane({ ready }: { ready: boolean }) {
      useSourceMessageReveal({ activeChatId: 'g1', viewportKey: 'target', ready, onNavigate: navigate,
        setFlashMessageId: vi.fn(), flashTimerRef: { current: null }, revealMessage: reveal, onMissing: vi.fn() })
      useSourceMessageReveal({ activeChatId: 'g1', viewportKey: 'sibling', onNavigate: sibling,
        setFlashMessageId: vi.fn(), flashTimerRef: { current: null }, revealMessage: vi.fn(async () => {}), onMissing: vi.fn() })
      return null
    }
    await harness.render(createNode(Pane, { ready: false }))
    await act(async () => { askReveal('g1', 'm41', 'target'); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked)) })
    expect(navigate).toHaveBeenCalledOnce()
    expect(sibling).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
    await harness.render(createNode(Pane, { ready: true }))
    expect(reveal).toHaveBeenCalledWith('m41')
    expect(sibling).not.toHaveBeenCalled()
  })

  it('queues a filtered quote until the same viewport has exited search with current rows', async () => {
    const navigate = vi.fn(), reveal = vi.fn(async () => {})
    let quote!: (id: string) => void
    function Pane({ ready }: { ready: boolean }) {
      quote = useSourceMessageReveal({ activeChatId: 'g1', viewportKey: 'filtered', ready, onNavigate: navigate,
        setFlashMessageId: vi.fn(), flashTimerRef: { current: null }, revealMessage: reveal, onMissing: vi.fn() })
      return null
    }
    await harness.render(createNode(Pane, { ready: false }))
    await act(async () => { quote('old') })
    expect(navigate).toHaveBeenCalledOnce()
    expect(reveal).not.toHaveBeenCalled()
    await harness.render(createNode(Pane, { ready: true }))
    expect(reveal).toHaveBeenCalledWith('old')
  })

  it('ignores a request for another group', async () => {
    const c = await setup()
    await c.show('m41', 'g2')
    expect(c.input.revealMessage).not.toHaveBeenCalled()
  })
})
