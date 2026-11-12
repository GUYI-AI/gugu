import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageList, type ChatListRowItem, type MessageListRowProps } from '@/components/chat/MessageList'
import { useConversationScrollMemory } from '@/components/chat/useConversationScrollMemory'
import { useFollowingTail, useTailPinning } from '@/components/chat/useFollowingTail'
import { askReveal, useSourceMessageReveal } from '@/hooks/useSourceMessageReveal'
import { ChatHistoryWindow } from '@/store/chatHistoryWindow'
import type { FlowListHandle } from '@/lib/flowList'
import { UI_EVENTS } from '@/lib/uiEvents'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness> | undefined
let frame = 0
afterEach(() => { cancelAnimationFrame(frame); harness?.cleanup() })

const noop = () => {}
const rowsOf = (chat: string) => Array.from({ length: 40 }, (_, i) => message({
  id: `${chat}-${i + 1}`, seq: i + 1, chat_id: chat, sender_user_id: 'sender',
  created_at: '2026-11-10T08:00:00Z', content: `Message ${i + 1}. ${'A long conversation. '.repeat(i % 5 + 1)}`,
}))

describe('a message link into another chat', () => {
  it('scrolls the chat it opens to the linked message over the place the reader had left it, and flashes it there', async () => {
    await page.viewport(1100, 760)
    harness = createReactHarness()
    const windows = new Map(['a', 'b'].map((chat) => {
      const history = new ChatHistoryWindow('reader')
      history.reset(chat, rowsOf(chat))
      return [chat, history] as const
    }))
    const flashes: string[] = [], missing = vi.fn()
    const scroller = () => harness!.container.querySelector<HTMLElement>('[data-testid="chat-message-list"]')!
    function Conversation() {
      const [chat, setChat] = useState('b')
      const history = windows.get(chat)!
      const window = useSyncExternalStore(history.subscribe, history.getSnapshot)
      const messages = window.messages
      const rows: ChatListRowItem[] = messages.map((message) => ({ type: 'message', message }))
      const listRef = useRef<FlowListHandle | null>(null), isAtBottomRef = useRef(true)
      const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
      const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
      const setFollowingTail = (following: boolean | undefined) => { if (following !== undefined) history.setFollowingTail(following) }
      const memory = useConversationScrollMemory({ listRef, chatId: chat, viewportKey: 'primary', activationKey: chat, enabled: true,
        messageIds: messages.map((row) => row.id), isAtBottomRef, setFollowingTail, loadMessageAnchor: () => Promise.reject(new Error('loaded already')) })
      const resetKey = `${chat}#${window.viewVersion}`
      const { onAtBottomChange } = useFollowingTail({ resetKey, unreadNavigationPending: false, hasNewer: window.hasNewer,
        loading: !!window.loading, isPreservingPosition: memory.isPreservingPosition, isAtBottomRef, setFollowingTail })
      const { onTotalListHeightChanged } = useTailPinning({ resetKey, messages, enabled: true, messageWindow: window, scrollerEl: memory.scrollerEl,
        scrollerRef: memory.scrollerRef, listRef, isAtBottomRef, isPreservingPosition: memory.isPreservingPosition,
        prepareForSavedPosition: memory.prepareForSavedPosition, forgetSavedPosition: memory.forgetSavedPosition, returnToLatest: async () => {}, onError: noop })
      useSourceMessageReveal({ activeChatId: chat, navigationTarget: true, revealMessage: memory.revealMessage, flashTimerRef, onMissing: missing,
        setFlashMessageId: (id) => { if (id) flashes.push(id); setFlashMessageId(id) } })
      const follow = () => {
        // What a gugu-chat:// or gugu-widget:// link does (useLinkNavigation): ask the reveal, then bring the chat up.
        askReveal('b', 'b-5')
        setChat('b')
        globalThis.window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked))
      }
      const rowProps: MessageListRowProps = { rows, messages, mobile: false, memberReadSeqs: {}, deliveryWaits: new Map(), memberProfiles: {},
        isGroupChat: true, onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, selectMode: false,
        selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop, flashMessageId, threeParty: undefined,
        readReceiptHandle: undefined, memberProfileOpener: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
        agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onMentionMember: undefined }
      return <><button onClick={() => setChat('a')}>Open chat a</button><button onClick={follow}>Follow the link</button>
        <div data-chat={chat} style={{ height: 560, width: '100%', display: 'flex', flexDirection: 'column' }}>
          <MessageList key={chat} rows={rows} rowProps={rowProps} resetKey={resetKey} listRef={listRef} scrollerRef={memory.setScrollerRef}
            initialTopMostItemIndex={memory.openLocation()} followTail={!window.hasNewer} onAtBottomChange={onAtBottomChange}
            onTotalListHeightChanged={onTotalListHeightChanged} />
        </div></>
    }
    await renderWithAppProviders(harness, createElement(Conversation))
    const laidOut = () => Number(scroller()?.querySelector('[aria-setsize]')?.getAttribute('aria-setsize')) === 40
    await until('chat b has laid out its tail', laidOut)
    // The reader had scrolled chat b up a little: opening it again restores that place.
    const surface = scroller()
    const scrolled = new Promise<void>((resolve) => surface.addEventListener('scroll', () => resolve(), { once: true }))
    surface.scrollTop = surface.scrollHeight - surface.clientHeight - 500
    await scrolled
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)))
    await page.getByRole('button', { name: 'Open chat a' }).click()
    await until('chat a has replaced chat b', () => !!harness!.container.querySelector('[data-chat="a"]') && laidOut())
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)))

    const shown: boolean[] = []
    const sample = () => {
      const surface = scroller(), row = surface?.querySelector<HTMLElement>('[data-msg-id="b-5"]')
      if (surface && row) {
        const bounds = surface.getBoundingClientRect(), rect = row.getBoundingClientRect()
        shown.push(rect.bottom > bounds.top && rect.top < bounds.bottom)
      } else shown.push(false)
      frame = requestAnimationFrame(sample)
    }
    await page.getByRole('button', { name: 'Follow the link' }).click()
    await until('the linked message flashes', () => flashes.includes('b-5'))
    frame = requestAnimationFrame(sample)
    await until('thirty frames after the flash are recorded', () => shown.length >= 30)
    cancelAnimationFrame(frame)
    expect(shown.every(Boolean), JSON.stringify({ shown, scrollTop: scroller().scrollTop })).toBe(true)
    expect(missing).not.toHaveBeenCalled()
  })
})
