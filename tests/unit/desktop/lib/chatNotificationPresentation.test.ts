import { describe, expect, it, vi } from 'vitest'
import { chat, displayIdentity } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import {
  presentChatMessage,
  type PresentationSources,
} from '../../../../apps/desktop/src/lib/chatNotificationPresentation'

const ME = 'viewer'
/** Stands for the chat's own label for a member it cannot name. */
const UNKNOWN = 'Unknown member'
const AT = '2026-01-01T00:00:00.000Z'
const message = (sender: string | null, over: Partial<MessageItem> = {}): MessageItem => ({
  id: 'm1', chat_id: 'c1', seq: 1, content: 'hi', content_type: 'text', sender_user_id: sender, created_at: AT,
  to_user_ids: [ME], thread_root_id: null, ...over,
} as MessageItem)

function sources(directory: Record<string, DisplayIdentity>, faces: Record<string, string | null> = {}, group: string | null = 'group-face'): PresentationSources & { group: ReturnType<typeof vi.fn> } {
  const groupFace = vi.fn(async () => group)
  return {
    identity: async (id) => directory[id] ?? null,
    userFace: async (identity) => (identity.id in faces ? faces[identity.id]! : `face:${identity.id}`),
    groupFace,
    group: groupFace,
  }
}
const person = (id: string, name: string, over: Partial<DisplayIdentity> = {}) => displayIdentity(id, { display_name: name, ...over })

describe('presentChatMessage', () => {
  it('uses the peer for a direct message, not the chat row picture the projection leaves empty', async () => {
    const dm = chat({ id: 'c1', kind: 'dm', peer_user_id: 'peer', avatar: 'https://cdn.example/stale-chat-row.png', name: 'Peer' })
    const { presentation } = await presentChatMessage({ accountId: ME, chat: dm, message: message('peer'), title: 'Peer', unknownAuthorName: UNKNOWN },
      sources({ peer: person('peer', 'Peer') }), 50)
    expect(presentation).toEqual({
      accountId: ME, messageId: 'm1', sentAt: Date.parse(AT),
      conversation: { id: 'c1', kind: 'dm', name: 'Peer', avatar: 'face:peer' },
      author: { id: 'peer', name: 'Peer', avatar: 'face:peer' },
    })
  })

  it('treats an agent peer chat as a direct conversation with the agent face', async () => {
    const ai = chat({ id: 'c1', kind: 'ai', peer_user_id: 'bot', name: 'Bot' })
    const { presentation } = await presentChatMessage({ accountId: ME, chat: ai, message: message('bot'), title: 'Bot', unknownAuthorName: UNKNOWN },
      sources({ bot: person('bot', 'Bot', { type: 'agent' }) }), 50)
    expect(presentation.conversation).toMatchObject({ kind: 'dm', avatar: 'face:bot' })
  })

  it('shows the group face for a group and keeps each message author as its own person', async () => {
    const group = chat({ id: 'c1', kind: 'group', name: 'Team', avatar: 'https://cdn.example/team.png' })
    const directory = { ann: person('ann', 'Ann'), bob: person('bob', 'Bob') }
    const s = sources(directory)
    const first = (await presentChatMessage({ accountId: ME, chat: group, message: message('ann'), title: 'Team', unknownAuthorName: UNKNOWN }, s, 50)).presentation
    const second = (await presentChatMessage({ accountId: ME, chat: group, message: message('bob', { id: 'm2' }), title: 'Team', unknownAuthorName: UNKNOWN }, s, 50)).presentation
    expect(first.conversation).toEqual({ id: 'c1', kind: 'group', name: 'Team', avatar: 'group-face' })
    expect(second.conversation).toEqual(first.conversation)
    expect([first.author, second.author]).toEqual([
      { id: 'ann', name: 'Ann', avatar: 'face:ann' },
      { id: 'bob', name: 'Bob', avatar: 'face:bob' },
    ])
    expect(s.group).toHaveBeenCalledWith({ id: 'c1', name: 'Team', avatar: 'https://cdn.example/team.png' })
  })

  it('follows the chat list for a topic: its own picture and id, never a guessed source group', async () => {
    const topic = chat({ id: 'c1', kind: 'topic', name: 'Topic', avatar: null, source_chat_id: 'parent' })
    const s = sources({ ann: person('ann', 'Ann') })
    const { presentation } = await presentChatMessage({ accountId: ME, chat: topic, message: message('ann'), title: 'Topic', unknownAuthorName: UNKNOWN }, s, 50)
    expect(presentation.conversation).toEqual({ id: 'c1', kind: 'group', name: 'Topic', avatar: 'group-face' })
    expect(s.group).toHaveBeenCalledWith({ id: 'c1', name: 'Topic', avatar: null })
  })

  it('leaves a picture that cannot be drawn empty instead of substituting another face', async () => {
    const dm = chat({ id: 'c1', kind: 'dm', peer_user_id: 'peer', name: 'Peer' })
    const { presentation } = await presentChatMessage({ accountId: ME, chat: dm, message: message('peer'), title: 'Peer', unknownAuthorName: UNKNOWN },
      sources({ peer: person('peer', 'Peer', { avatar: 'https://cdn.example/gone.png' }) }, { peer: null }), 50)
    expect(presentation.conversation.avatar).toBeNull()
    expect(presentation.author).toEqual({ id: 'peer', name: 'Peer', avatar: null })
  })

  it('names an unknown or deleted author with the chat\'s own label, never with the conversation or a made-up person', async () => {
    const group = chat({ id: 'c1', kind: 'group', name: 'Team' })
    const unknown = (await presentChatMessage({ accountId: ME, chat: group, message: message('ghost'), title: 'Team', unknownAuthorName: UNKNOWN }, sources({}), 50)).presentation
    const deleted = (await presentChatMessage({ accountId: ME, chat: group, message: message(null), title: 'Team', unknownAuthorName: UNKNOWN }, sources({}), 50)).presentation
    expect(unknown.author).toEqual({ id: 'ghost', name: UNKNOWN, avatar: null })
    expect(deleted.author).toEqual({ id: null, name: UNKNOWN, avatar: null })
    expect(unknown.author.name).not.toBe('Team')
  })

  it('does not wait for slow pictures: posts at once, then offers the same message with its pictures', async () => {
    const dm = chat({ id: 'c1', kind: 'dm', peer_user_id: 'peer', name: 'Peer' })
    let release: (face: string) => void = () => undefined
    const slow: PresentationSources = {
      identity: async (id) => person(id, 'Peer'),
      userFace: () => new Promise((resolve) => { release = resolve }),
      groupFace: async () => null,
    }
    const result = await presentChatMessage({ accountId: ME, chat: dm, message: message('peer'), title: 'Peer', unknownAuthorName: UNKNOWN }, slow, 10)
    expect(result.presentation.conversation.avatar).toBeNull()
    expect(result.presentation.update).toBeUndefined()
    expect(result.refresh).not.toBeNull()
    release('late-face')
    const refreshed = await result.refresh!
    expect(refreshed).toMatchObject({ messageId: 'm1', update: true, conversation: { avatar: 'late-face' }, author: { avatar: 'late-face' } })
  })

  it('does not claim a name it has not read: a slow identity goes out as the generic label, then as the real name', async () => {
    const dm = chat({ id: 'c1', kind: 'dm', peer_user_id: 'peer', name: 'Peer' })
    let release: (identity: DisplayIdentity) => void = () => undefined
    const slow: PresentationSources = {
      identity: () => new Promise((resolve) => { release = resolve }),
      userFace: async () => 'face', groupFace: async () => null,
    }
    const result = await presentChatMessage({ accountId: ME, chat: dm, message: message('peer'), title: 'Peer', unknownAuthorName: UNKNOWN }, slow, 10)
    expect(result.presentation.author).toEqual({ id: 'peer', name: UNKNOWN, avatar: null })
    release(person('peer', 'Peer'))
    expect((await result.refresh!).author).toEqual({ id: 'peer', name: 'Peer', avatar: 'face' })
  })

  it('offers no refresh when everything was ready in time', async () => {
    const dm = chat({ id: 'c1', kind: 'dm', peer_user_id: 'peer', name: 'Peer' })
    const result = await presentChatMessage({ accountId: ME, chat: dm, message: message('peer'), title: 'Peer', unknownAuthorName: UNKNOWN },
      sources({ peer: person('peer', 'Peer') }), 50)
    expect(result.refresh).toBeNull()
  })

  it('survives a source that throws: the notification is still presented, without that picture', async () => {
    const dm = chat({ id: 'c1', kind: 'dm', peer_user_id: 'peer', name: 'Peer' })
    const broken: PresentationSources = {
      identity: async () => { throw new Error('directory offline') },
      userFace: async () => 'x', groupFace: async () => 'x',
    }
    const { presentation } = await presentChatMessage({ accountId: ME, chat: dm, message: message('peer'), title: 'Peer', unknownAuthorName: UNKNOWN }, broken, 50)
    expect(presentation.conversation).toEqual({ id: 'c1', kind: 'dm', name: 'Peer', avatar: null })
    expect(presentation.author).toEqual({ id: 'peer', name: UNKNOWN, avatar: null })
  })
})
