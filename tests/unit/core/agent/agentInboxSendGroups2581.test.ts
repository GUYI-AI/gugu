import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery'
import {
  pullAgentInbox,
  resetAgentInboxReaderStateForTests,
  SEND_GROUP_WAIT_MS,
  type AgentInboxInjectionInput,
  type AgentInboxReaderDeps,
  type AgentInboxUnreadRow,
} from '@gugu/core/local/agent/agentInboxReader'

// #2581 Files sent at once are one message: the agent gets them as one turn, every image on it. The send's files reach
// the conversation one after another, so a send not yet whole waits (with what came after it), for a while.
const AGENT = 'agent-0000-0000-0000-000000000001'
const HUMAN = 'human-0000-0000-0000-000000000002'
const CHAT = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const image = (name: string) => `[附件] ${name} (image/png)\n[URL] https://example.test/${name}\n[Size] 3\n[Kind] image`
const base: AgentInboxUnreadRow = {
  chatId: CHAT, chatKind: 'group', groupRules: '', chatPublicId: 1, chatName: 'g', chatCreatorUserId: HUMAN,
  listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0,
  id: id(1), seq: 1, senderUserId: HUMAN, senderType: 'human', senderDisplayName: 'Ada',
  senderGuguNumber: null, content: 'hi', contentType: 'text', toUserIds: null, isWhisper: false,
  replyToMessageId: null, replyToSenderUserId: null, replyToContent: null,
  threadRootId: null, isThreadRoot: false, createdAt: '2026-11-13T00:00:00.000Z',
}
const file = (seq: number, size = 3): AgentInboxUnreadRow =>
  ({ ...base, id: id(seq), seq, contentType: 'attachment', content: image(`p${seq}.png`), sendGroupId: 'send-1', sendGroupSize: size })
const ids = (input: AgentInboxInjectionInput) => (input.sources ?? []).map((source) => source.row.id)
const text = (seq: number, chatId = CHAT): AgentInboxUnreadRow => ({ ...base, chatId, id: id(seq), seq, content: `text ${seq}` })

function inbox(rows: AgentInboxUnreadRow[]) {
  const injected: AgentInboxInjectionInput[] = []
  const read = new Set<string>()
  const deps: AgentInboxReaderDeps = {
    accessToken: 'test',
    groupRulesLedger: memoryGroupRulesLedger(),
    fetchUnread: async () => rows.filter((row) => !read.has(row.id)),
    inject: async (input) => { injected.push(input); return 'accepted' },
    markRead: async ({ messageId }) => { read.add(messageId) },
    downloadAttachment: async (_source, name) => ({ bytes: Uint8Array.from([1, 2]), localPath: `/tmp/${name}` }),
  }
  return { injected, read, deps }
}

beforeEach(() => { resetAgentInboxReaderStateForTests() })
afterEach(() => { resetAgentInboxReaderStateForTests(); vi.useRealTimers() })

describe('#2581 a send of several files reaches the agent as one turn', () => {
  it('three images sent at once: one turn carrying the three; the next message is its own turn', async () => {
    const { injected, read, deps } = inbox([file(1), file(2), file(3), text(4)])
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 4, injected: 4, verdict: 'accepted' })
    expect(injected).toHaveLength(2)
    expect(injected[0]!.attachments?.map((attachment) => attachment.fileName)).toEqual(['p1.png', 'p2.png', 'p3.png'])
    for (const seq of [1, 2, 3]) expect(injected[0]!.text).toContain(`msg="msg:${id(seq)}"`)
    expect(ids(injected[0]!)).toEqual([id(1), id(2), id(3)])
    expect(injected[1]!.text).toContain('text 4')
    expect([...read].sort()).toEqual([id(1), id(2), id(3), id(4)])
  })

  it('a send not yet whole waits with what came after it in its conversation; other conversations go on', async () => {
    const rows = [file(1), file(2), text(5), text(6, OTHER)]
    const { injected, read, deps } = inbox(rows)
    await pullAgentInbox(AGENT, deps)
    expect(injected.map(ids)).toEqual([[id(6)]])
    expect(read.has(id(1)) || read.has(id(5))).toBe(false)
    rows.push(file(3))
    await pullAgentInbox(AGENT, deps)
    expect(injected.slice(1).map(ids)).toEqual([[id(1), id(2), id(3)], [id(5)]])
    expect(injected[1]!.attachments).toHaveLength(3)
  })

  it('a file that never arrives does not hold the conversation: after the wait, what came goes as it is', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'))
    const { injected, deps } = inbox([file(1), file(2), text(5)])
    await pullAgentInbox(AGENT, deps)
    expect(injected).toEqual([])
    vi.setSystemTime(new Date(Date.parse('2026-11-13T00:00:00Z') + SEND_GROUP_WAIT_MS))
    await pullAgentInbox(AGENT, deps)
    expect(injected.map(ids)).toEqual([[id(1), id(2)], [id(5)]])
    expect(injected[0]!.attachments).toHaveLength(2)
  })

  it('a file sent on its own is delivered as before, without waiting', async () => {
    const { injected, deps } = inbox([{ ...file(1), sendGroupId: null, sendGroupSize: null }])
    await pullAgentInbox(AGENT, deps)
    expect(injected).toHaveLength(1)
    expect(injected[0]!.attachments).toHaveLength(1)
  })
})
