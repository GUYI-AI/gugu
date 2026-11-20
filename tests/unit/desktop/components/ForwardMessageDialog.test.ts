// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForwardMessageDialog } from '../../../../apps/desktop/src/components/chat/ForwardMessageDialog'
import { forwardPreview, sendableConversations, sendablePeople, sendablePickRows } from '../../../../apps/desktop/src/components/chat/forwardMessageUtils'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import messagingZhCN from '../../../../apps/desktop/src/i18n/locales/zh-CN/messaging'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'

// The note's editor and @ are the composer's (ForwardNoteEditor); here it is a plain field saying which chat it may @ in.
vi.mock('../../../../apps/desktop/src/components/chat/ForwardNoteEditor', async () => {
  const { createElement: h } = await import('react')
  return { ForwardNoteEditor: ({ chat, onChange }: { chat: ChatItem | null; onChange: (note: { text: string; toUserIds: string[] }) => void }) =>
    h('input', { 'data-testid': 'forward-note', 'data-mention-chat': chat?.id ?? '',
      onChange: (event: { target: { value: string } }) => onChange({ text: event.target.value, toUserIds: chat ? ['agent-1'] : [] }) }) }
})
// A person picked is their private chat once sending begins: here a fixed one, so the page's own steps are what is tested.
const resolved = vi.hoisted(() => ({ ids: (ids: readonly string[]) => ids.map((id) => id.replace(/^person:/, 'dm-')) }))
vi.mock('../../../../apps/desktop/src/components/chat/useResolveTargets', () => ({ useResolveTargets: () => async (ids: readonly string[]) => resolved.ids(ids) }))
function chat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'chat-x',
    kind: 'dm',
    status: 'active',
    name: 'Chat X',
    created_at: '2026-01-01T00:00:00.000Z',
    last_message_at: null,
    last_message_preview: null,
    unread_count: 0,
    pinned_message_id: null,
    last_read_seq: 0,
    next_message_seq: 1,
    ...overrides,
  }
}
function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: 'msg-1',
    chat_id: 'src',
    sender_user_id: 'u1',
    to_user_ids: null,
    seq: 1,
    content: 'hello world',
    content_type: 'text',
    reply_to_message_id: null,
    retracted_at: null,
    created_at: '2026-06-15T00:00:00.000Z',
    reactions: [],
    is_mine: false,
    delivered: true,
    delivery_status: null,
    ...overrides,
  }
}
describe('forward helpers', () => {
  it('forwardPreview labels non-text content and falls back for empty', () => {
    expect(messagingZhCN.forward.preview).toEqual({
      attachment: '[附件]',
      card: '[卡片]',
      empty: '[空消息]',
    })
    const labels = { attachment: '[attachment]', card: '[card]', empty: '[empty message]' }
    expect(forwardPreview({ content: 'hi', content_type: 'text' }, labels)).toBe('hi')
    expect(forwardPreview({ content: null, content_type: 'attachment' }, labels)).toBe('[attachment]')
    expect(forwardPreview({ content: '{}', content_type: 'card' }, labels)).toBe('[card]')
    expect(forwardPreview({ content: '   ', content_type: 'text' }, labels)).toBe('[empty message]')
  })
  const ids = (chats: ChatItem[], query = '', sourceChatId = 'src', displayName = (item: ChatItem) => item.name ?? '') =>
    sendableConversations(chats, { ownerId: 'me', sourceChatId, query, displayName, identitiesById: {} }).chats.map((c) => c.id)
  it('searches by the current canonical name: a peer renamed is found by the new name only', () => {
    const identities: Record<string, string> = { 'user-a': 'Alpha' }
    const chats = [
      chat({ id: 'src', name: '', peer_user_id: 'source-user', last_message_at: '2026-01-02T00:00:00Z' }),
      chat({ id: 'a', name: '', peer_user_id: 'user-a', last_message_at: '2026-01-02T00:00:00Z' }),
      chat({ id: 'b', kind: 'group', name: 'Beta Group' }),
    ]
    const displayName = (item: ChatItem) => item.kind === 'group' ? item.name : (identities[item.peer_user_id ?? ''] ?? '')
    expect(ids(chats, '', 'src', displayName)).toEqual(['a', 'b'])
    expect(ids(chats, 'alph', 'src', displayName)).toEqual(['a'])
    identities['user-a'] = 'Renamed Peer'
    expect(ids(chats, 'alph', 'src', displayName)).toEqual([])
    expect(ids(chats, 'renamed', 'src', displayName)).toEqual(['a'])
    expect(ids(chats, 'beta group', 'src', displayName)).toEqual(['b'])
  })
  it('lists as the chat list does: pinned first, then the latest; an empty private chat only when searched', () => {
    const chats = [
      chat({ id: 'old', kind: 'group', name: 'Old', last_message_at: '2026-09-02T00:00:00Z' }),
      chat({ id: 'new', name: 'New', last_message_at: '2026-09-20T00:00:00Z' }),
      chat({ id: 'empty', name: 'Never talked' }),
      chat({ id: 'pinned', name: 'Pinned', last_message_at: '2026-08-01T00:00:00Z', is_pinned: true }),
    ]
    const q = { ownerId: 'me', sourceChatId: '', displayName: (item: ChatItem) => item.name ?? '', identitiesById: {} }
    expect(sendableConversations(chats, { ...q, query: '' }).chats.map((c) => c.id)).toEqual(['pinned', 'new', 'old'])
    expect(sendableConversations(chats, { ...q, query: 'never' }).chats.map((c) => c.id)).toEqual(['empty'])
    expect(sendableConversations(chats, { ...q, query: '', drafts: { empty: 'half' } }).chats.map((c) => c.id)).toContain('empty')
  })
  it('nests topics under their group; a search for a topic brings its group; a topic of the source stands alone, its group named', () => {
    const chats = [
      chat({ id: 'src', kind: 'group', name: 'Source' }),
      chat({ id: 'g', kind: 'group', name: 'Design' }),
      chat({ id: 'g-t', kind: 'topic', name: 'Icons', source_chat_id: 'g' }),
      chat({ id: 'src-t', kind: 'topic', name: 'Launch', source_chat_id: 'src' }),
      chat({ id: 'd', kind: 'dm', name: '', peer_user_id: 'u-a', last_message_at: '2025-01-01T00:00:00Z' }),
    ]
    const name = (item: ChatItem) => item.kind === 'dm' ? 'Alpha' : item.name ?? ''
    const rows = (query: string) => sendablePickRows(sendableConversations(chats, { ownerId: 'me', sourceChatId: 'src', query, displayName: name, identitiesById: {} }), name, {}, { searching: query !== '' })
    const shape = (query: string) => rows(query).map((row) => ({ id: row.id, hint: row.hint, topics: row.topics?.map((topic) => topic.id) }))
    expect(shape('')).toEqual([
      { id: 'g', hint: undefined, topics: ['g-t'] },
      { id: 'src-t', hint: 'Source', topics: undefined },
      { id: 'd', hint: undefined, topics: undefined },
    ])
    expect(shape('icon')).toEqual([{ id: 'g', hint: undefined, topics: ['g-t'] }])
    expect(rows('')[0].topics?.[0].avatar).toBeUndefined()
  })
  it('folds a group\'s topics past the latest few behind 「更多话题」, opened by the group; a search shows every topic it finds', () => {
    const topics = Array.from({ length: 6 }, (_, i) => chat({ id: `t${i}`, kind: 'topic', name: `Topic ${i}`, source_chat_id: 'g', last_message_at: `2026-09-0${i + 1}T00:00:00Z` }))
    const chats = [chat({ id: 'g', kind: 'group', name: 'Group' }), ...topics, chat({ id: 't-unread', kind: 'topic', name: 'Unread', source_chat_id: 'g', unread_count: 2 })]
    const name = (item: ChatItem) => item.name ?? ''
    const sendable = (query: string) => sendableConversations(chats, { ownerId: 'me', query, displayName: name, identitiesById: {} })
    const [group] = sendablePickRows(sendable(''), name, {})
    expect(group.topics?.map((t) => t.id)).toEqual(['t5', 't4', 't3', 't-unread'])
    expect(group.moreTopics).toBe(3)
    const [open] = sendablePickRows(sendable(''), name, {}, { expanded: new Set(['g']) })
    expect(open.topics).toHaveLength(7)
    expect(open.moreTopics).toBeUndefined()
    const [found] = sendablePickRows(sendable('topic'), name, {}, { searching: true })
    expect(found.topics).toHaveLength(6)
    expect(found.moreTopics).toBeUndefined()
  })
  it('offers friends and own agents with no conversation listed; not someone else\'s agent, a removed one, or oneself', () => {
    const contact = (patch: Partial<ContactUser>): ContactUser => ({ id: 'x', display_name: 'X', avatar: null, bio: null, type: 'human', ...patch })
    const contacts = [
      contact({ id: 'me', display_name: 'Me' }),
      contact({ id: 'talked', display_name: 'Talked' }),
      contact({ id: 'quiet', display_name: 'Quiet', alias: 'Q' }),
      contact({ id: 'mine', display_name: 'My bot', type: 'agent', owner_user_id: 'me' }),
      contact({ id: 'theirs', display_name: 'Their bot', type: 'agent', owner_user_id: 'other' }),
      contact({ id: 'left', display_name: 'Left', removed_at: '2026-10-01T00:00:00Z' }),
    ]
    const shown = [chat({ id: 'c', peer_user_id: 'talked', last_message_at: '2026-01-01T00:00:00Z' })]
    expect(sendablePeople(contacts, shown, { ownerId: 'me', query: '' }).map((c) => c.id)).toEqual(['quiet', 'mine'])
    expect(sendablePeople(contacts, shown, { ownerId: 'me', query: 'q' }).map((c) => c.id)).toEqual(['quiet'])
    expect(sendablePeople(contacts, shown, { ownerId: 'me', query: '', source: chat({ id: 'from', peer_user_id: 'quiet' }) }).map((c) => c.id)).toEqual(['mine'])
  })
})
let container: HTMLDivElement
let root: Root
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const click = (el: Element | null) => act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
const $ = (selector: string) => document.body.querySelector(selector)
async function open(props: { messages?: MessageItem[]; chats?: ChatItem[]; contacts?: ContactUser[]; onForward: (...args: never[]) => Promise<void>; onClose?: () => void }) {
  await act(async () => {
    root.render(createElement(ForwardMessageDialog, {
      messages: props.messages ?? [message({ chat_id: 'src' })],
      chats: props.chats ?? [chat({ id: 'src', name: 'Source' }), chat({ id: 'a', name: 'Alpha', last_message_at: '2026-06-02T00:00:00Z' }), chat({ id: 'b', name: 'Beta', last_message_at: '2026-06-01T00:00:00Z' })],
      contacts: props.contacts, ownerId: 'me', sourceChatId: 'src', onForward: props.onForward as never, onClose: props.onClose ?? vi.fn(),
    }))
  })
  await flush()
}
const sentTo = () => [...document.body.querySelectorAll('[data-forward-to]')].map((el) => (el as HTMLElement).dataset.forwardTo)
async function typeNote(text: string) {
  const note = $('[data-testid="forward-note"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, text)
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ForwardMessageDialog: whom, then the send', () => {
  it('goes straight to the send with one tap: to whom, one line of what, then 发送', async () => {
    const onForward = vi.fn(async () => {})
    const onClose = vi.fn()
    await open({ onForward, onClose })
    expect($('[data-pick-row="src"]')).toBeNull()
    expect($('[data-testid="forward-confirm"]')).toBeNull()
    await click($('[data-pick-row="a"]'))
    expect(sentTo()).toEqual(['a'])
    expect($('[data-testid="forward-preview"]')!.textContent).toContain('详情')
    await click($('[data-testid="forward-send"]'))
    await flush()
    expect(onForward).toHaveBeenCalledWith(['a'], { text: '', toUserIds: [] }, expect.any(Function))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers a friend with no conversation under 联系人; sending reaches the private chat it opens, and unticks the friend', async () => {
    const onForward = vi.fn(async (_ids: string[], _note: unknown, sent: (chatId: string) => void) => { sent('dm-u9') })
    await open({ onForward, contacts: [{ id: 'u9', display_name: 'Nine', avatar: null, bio: null, type: 'human' }] })
    expect($('[data-pick-section="people"]')!.textContent).toContain('联系人')
    await click($('[data-pick-row="person:u9"]'))
    expect(sentTo()).toEqual(['person:u9'])
    expect($('[data-testid="forward-confirm"]')!.textContent).toContain('Nine')
    await click($('[data-testid="forward-send"]'))
    await flush()
    expect(onForward).toHaveBeenCalledWith(['dm-u9'], { text: '', toUserIds: [] }, expect.any(Function))
  })

  it('draws a group\'s latest topics and 「更多话题」 for the rest; pressing it draws them all', async () => {
    const topics = Array.from({ length: 5 }, (_, i) => chat({ id: `t${i}`, kind: 'topic', name: `T${i}`, source_chat_id: 'g', last_message_at: `2026-06-0${i + 1}T00:00:00Z` }))
    await open({ onForward: vi.fn(async () => {}), chats: [chat({ id: 'g', kind: 'group', name: 'G' }), ...topics] })
    expect(['t4', 't3', 't2', 't1'].map((id) => !!$(`[data-pick-row="${id}"]`))).toEqual([true, true, true, false])
    expect($('[data-pick-more-topics="g"]')!.textContent).toBe('更多话题（2）')
    await click($('[data-pick-more-topics="g"]'))
    expect($('[data-pick-row="t0"]')).not.toBeNull()
    expect($('[data-pick-more-topics="g"]')).toBeNull()
  })

  it('goes back to the pick on 取消, nothing picked, nothing sent', async () => {
    const onForward = vi.fn(async () => {})
    await open({ onForward })
    await click($('[data-pick-row="a"]'))
    await click($('[data-testid="forward-cancel"]'))
    expect($('[data-testid="forward-confirm"]')).toBeNull()
    expect($('[data-pick-row="a"]')!.getAttribute('aria-selected')).toBe('false')
    expect(onForward).not.toHaveBeenCalled()
  })

  it('ticks several once 多选 is on, then 下一步; the note offers no @ for several', async () => {
    const onForward = vi.fn(async () => {})
    await open({ onForward })
    await click($('[data-testid="forward-several"]'))
    await click($('[data-pick-row="a"]'))
    await click($('[data-pick-row="b"]'))
    expect($('[data-testid="forward-confirm"]')).toBeNull()
    await click($('[data-testid="forward-message-dialog-action"]'))
    expect(sentTo()).toEqual(['a', 'b'])
    expect(($('[data-testid="forward-note"]') as HTMLElement).dataset.mentionChat).toBe('')
    await click($('[data-testid="forward-send"]'))
    await flush()
    expect(onForward).toHaveBeenCalledWith(['a', 'b'], { text: '', toUserIds: [] }, expect.any(Function))
  })

  it('hands the typed note, and whom it @-s in the one chat picked, to the forward', async () => {
    const onForward = vi.fn(async () => {})
    await open({ onForward })
    await click($('[data-pick-row="a"]'))
    expect(($('[data-testid="forward-note"]') as HTMLElement).dataset.mentionChat).toBe('a')
    await typeNote('看一下这条')
    await click($('[data-testid="forward-send"]'))
    await flush()
    expect(onForward).toHaveBeenCalledWith(['a'], { text: '看一下这条', toUserIds: ['agent-1'] }, expect.any(Function))
  })

  it('after a failure part-way, stays on the send with only the chats still missing it', async () => {
    const onForward = vi.fn(async (_ids: string[], _note: unknown, sent: (chatId: string) => void): Promise<void> => { sent('a'); throw new Error('outbox refused') })
    const onClose = vi.fn()
    await open({ onForward, onClose })
    await click($('[data-testid="forward-several"]'))
    await click($('[data-pick-row="a"]'))
    await click($('[data-pick-row="b"]'))
    await click($('[data-testid="forward-message-dialog-action"]'))
    await click($('[data-testid="forward-send"]'))
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('outbox refused')
    expect(sentTo()).toEqual(['b'])
    onForward.mockImplementation(async () => {})
    await click($('[data-testid="forward-send"]'))
    await flush()
    expect(onForward).toHaveBeenLastCalledWith(['b'], { text: '', toUserIds: [] }, expect.any(Function))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // @@@multi-select (#988) — several messages: one line says how many, 详情 shows each.
  it('says how many messages on one line, each of them under 详情', async () => {
    await open({ onForward: vi.fn(async () => {}), messages: [
      message({ id: 'm1', chat_id: 'src', content: 'first' }), message({ id: 'm2', chat_id: 'src', content: 'second' }),
      message({ id: 'm3', chat_id: 'src', content: 'third' }),
    ] })
    await click($('[data-pick-row="a"]'))
    const preview = () => $('[data-testid="forward-preview"]')!.textContent ?? ''
    expect(preview()).toContain('转发 3 条消息')
    expect(preview()).not.toContain('second')
    await click($('[data-testid="forward-detail"]'))
    expect(preview()).toContain('first')
    expect(preview()).toContain('second')
    expect(preview()).toContain('third')
  })
})
