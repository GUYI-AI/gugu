// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionItem } from '@gugu/session-ui/react/components'
import { pillCite } from '@gugu/session-shared/markdown'
import { selectionSendBody } from '@/session/shared/extensions/selection-send'

/**
 * API 55 Send into a chat (SelectionSend.tsx): the box offers that chat's members to @ (`useChatNote`, a forward's note's),
 * and sends into the chat's outbox the cite as shown and the person's words, addressed by the people they @ — picked or
 * typed — and by no @ inside the words they picked. A private chat offers no one. The chat's members, its store and the
 * rich editor are fakes (the editor: a field that says what it was given); the box, the note and the @ reading are real.
 */

vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GROUP = 'group-1', DM = 'dm-1'
const members = [{ id: 'user-alice', name: 'Alice', type: 'human' as const }, { id: 'user-bob', name: 'Bob', type: 'human' as const }]
const sendMessageToChat = vi.fn(async (_chat: string, _text: string, _opts?: { toUserIds?: string[] }) => 'message-1')
const chats = [{ id: GROUP, kind: 'group' }, { id: DM, kind: 'dm' }]
// Stable as the real stores are: a fresh object per render would re-render the note forever.
const stable = { snapshot: { agents: [] }, statuses: {}, contacts: { contacts: [] }, members: new Map(), tools: { byEngine: {}, renderMentionIcon: () => null }, auth: { user: { id: 'user-me' } }, toast: { toast: () => undefined } }
const store = { chats, sendMessageToChat, identitiesById: {} }
const editor: { props: { mentionProvider?: { search(query: string): Promise<MentionItem[]> }; onMentionInsert?(item: MentionItem): void; onChange(text: string): void } | null } = { props: null }

vi.mock('@/store/chatContext', () => ({
  useChatStore: () => store,
  useChatStoreSelect: (select: (store: { chats: typeof chats }) => unknown) => select({ chats }),
}))
vi.mock('@/store/auth', () => ({ useAuth: () => stable.auth }))
vi.mock('@/store/contactsContext', () => ({ useContactsStore: () => stable.contacts }))
vi.mock('@/hooks/useRoomCollab', () => ({ useRoomCollab: (chatId: string | null) => ({ snapshot: chatId ? stable.snapshot : null }) }))
vi.mock('@/hooks/useAgentDisplayStatus', () => ({ useAgentDisplayStatuses: () => stable.statuses }))
vi.mock('@/lib/projectGroupChatsBridge', () => ({ useProjectGroupMembers: () => stable.members }))
vi.mock('@/session/renderer/lib/chat/use-session-agent-creation-tools', () => ({ useSessionAgentCreationTools: () => stable.tools }))
vi.mock('@/lib/mention', async (original) => ({ ...(await original<object>()), buildGroupRosterCandidates: () => members }))
vi.mock('@/components/chat/NoteEditor', () => ({
  NoteEditor: (props: NonNullable<typeof editor.props>) => { editor.props = props; return null },
}))
vi.mock('@/components/toastContext', () => ({ useToast: () => stable.toast }))

const { SelectionSendLayer } = await import('@/components/chat/SelectionSend')
const { openSelectionSend } = await import('@/components/chat/selectionSendAsk')

let host: HTMLDivElement, root: Root
beforeEach(async () => {
  sendMessageToChat.mockClear()
  editor.props = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(SelectionSendLayer) as ReactNode))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const cite = pillCite('> 让 @Bob 也看看这段', [{ label: 'proof.md (第 3–4 行)', target: 'gugu-file://item-1?v=7#lines=3-4' }])
const open = async (chat: string) => {
  let answer!: Promise<string>
  await act(async () => { answer = openSelectionSend({ cite, to: { chat }, anchor: { left: 10, top: 10, right: 50, bottom: 26, width: 40, height: 16, x: 10, y: 10 } as DOMRect }) })
  // Wrapped: an async function returning the box's own promise would wait for its answer.
  return { answer }
}
const send = () => act(async () => { document.querySelector<HTMLButtonElement>('.gg-selection-send-actions button')!.click() })

describe('Send into a chat', () => {
  it('shows the cite it sends, offers the group\'s members, and addresses the picked and the typed @ only', async () => {
    const { answer } = await open(GROUP)
    const box = document.querySelector('.gg-selection-send')!
    expect(box.textContent).toContain('proof.md (第 3–4 行)')
    expect(box.textContent).toContain('让 @Bob 也看看这段')
    const offered = await editor.props!.mentionProvider!.search('Al')
    expect(offered.map(item => item.id)).toContain('user-alice')
    await act(async () => { editor.props!.onMentionInsert!(offered.find(item => item.id === 'user-alice')!) })
    await act(async () => { editor.props!.onChange('@Alice 看下这里') })
    await send()
    expect(await answer).toBe('sent')
    expect(sendMessageToChat).toHaveBeenCalledExactlyOnceWith(GROUP, selectionSendBody(cite.draft, '@Alice 看下这里'), { toUserIds: ['user-alice'] })
  })

  it('reads a typed @ as one picked', async () => {
    const { answer } = await open(GROUP)
    await act(async () => { editor.props!.onChange('@Bob 你也看看') })
    await send()
    expect(await answer).toBe('sent')
    expect(sendMessageToChat.mock.calls[0]![2]).toEqual({ toUserIds: ['user-bob'] })
  })

  it('in a private chat offers no one and addresses no one', async () => {
    const { answer } = await open(DM)
    expect(await editor.props!.mentionProvider!.search('Al')).toEqual([])
    await act(async () => { editor.props!.onChange('@Alice 看下') })
    await send()
    expect(await answer).toBe('sent')
    expect(sendMessageToChat).toHaveBeenCalledExactlyOnceWith(DM, selectionSendBody(cite.draft, '@Alice 看下'), { toUserIds: [] })
  })
})
