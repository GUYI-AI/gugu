import { describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { forwardToChats } from '../../../../apps/desktop/src/components/chat/forwardToChats'

function message(overrides: Partial<MessageItem>): MessageItem {
  return { id: 'm', chat_id: 'src', sender_user_id: 'u-han', to_user_ids: null, seq: 1, content: 'hi', content_type: 'text',
    reply_to_message_id: null, retracted_at: null, created_at: '2026-11-09T00:00:00Z', reactions: [], ...overrides } as MessageItem
}
const note = (text: string, toUserIds: string[] = []) => ({ text, toUserIds })
const names: Record<string, string> = { 'u-han': 'Han', 'u-mei': 'Mei', me: 'Me' }
function io() {
  return { forwardMessage: vi.fn(async () => {}), sendMessageToChat: vi.fn(async () => undefined), knownName: (id: string | null) => names[id ?? 'me'], unknownName: 'Unknown member' }
}

describe('forwardToChats', () => {
  it('sends picked words as one quoted message linked to the first source, into each chat', async () => {
    const send = io()
    await forwardToChats([
      { kind: 'message', message: message({ id: 'a', content: 'Friday?', sender_user_id: 'u-mei' }) },
      { kind: 'message', message: message({ id: 'b', content: 'Agreed.', reply_to_message_id: 'a', reply_to_content: 'Friday?', reply_to_sender_user_id: 'u-mei' }) },
    ], ['g1', 'g2'], note('for you'), send)
    expect(send.forwardMessage).toHaveBeenCalledTimes(2)
    const [forwarded, chat] = send.forwardMessage.mock.calls[0] as unknown as [MessageItem, string]
    expect(chat).toBe('g1')
    expect(forwarded.id).toBe('a')
    expect(forwarded.reply_to_message_id).toBeNull()
    expect(forwarded.content).toBe('for you\n\n> **Mei**\n>\n> Friday?\n\n> **Han**\n>\n> > **Mei**：Friday?\n>\n> Agreed.')
    expect(send.sendMessageToChat).not.toHaveBeenCalled()
  })

  it('sends words with no chat message behind them as a new message', async () => {
    const send = io()
    await forwardToChats([{ kind: 'text', sender: null, text: 'Why?' }, { kind: 'text', sender: 'Han', text: 'Because.' }], ['g1'], note(''), send)
    expect(send.forwardMessage).not.toHaveBeenCalled()
    expect(send.sendMessageToChat).toHaveBeenCalledWith('g1', '> **Me**\n>\n> Why?\n\n> **Han**\n>\n> Because.', { toUserIds: [] })
  })

  it('forwards a file as itself, with the note after it', async () => {
    const send = io()
    const file = message({ id: 'f', content_type: 'attachment', content: '[file]' })
    await forwardToChats([{ kind: 'message', message: file }], ['g1'], note(' look '), send)
    expect(send.forwardMessage).toHaveBeenCalledWith(file, 'g1')
    expect(send.sendMessageToChat).toHaveBeenCalledWith('g1', 'look', { toUserIds: [] })
  })

  it('leaves a retracted message out', async () => {
    const send = io()
    await forwardToChats([{ kind: 'message', message: message({ retracted_at: '2026-11-09T00:00:00Z' }) }], ['g1'], note(''), send)
    expect(send.forwardMessage).not.toHaveBeenCalled()
    expect(send.sendMessageToChat).not.toHaveBeenCalled()
  })
})

const lead = { kind: 'text' as const, sender: 'Han', text: 'Context.' }
const LEAD = '> **Han**\n>\n> Context.\n\n'

describe('forwardToChats, a message whose row names no sender', () => {
  it('quotes it under the name the piece gives', async () => {
    const send = io()
    await forwardToChats([lead, { kind: 'message', message: message({ id: 's', sender_user_id: null, content: 'Shipped.' }), sender: 'Codex' }], ['g1'], note(''), send)
    expect((send.forwardMessage.mock.calls[0] as unknown as [MessageItem])[0].content).toBe(LEAD + '> **Codex**\n>\n> Shipped.')
  })
})

describe('forwardToChats, delivered words', () => {
  it('names them as this account knows the sender, not as the delivery labelled them', async () => {
    const send = io()
    await forwardToChats([lead, { kind: 'text', sender: 'Mei (咕咕号 7)', senderId: 'u-mei', text: 'Friday?' }], ['g1'], note(''), send)
    expect(send.sendMessageToChat).toHaveBeenCalledWith('g1', LEAD + '> **Mei**\n>\n> Friday?', { toUserIds: [] })
  })
})

describe('forwardToChats, speakers no name is known for', () => {
  it('quotes them as an unknown member and still forwards: a reply to someone never loaded, a sender who left', async () => {
    const send = io()
    await forwardToChats([lead, { kind: 'message', message: message({ id: 'r', sender_user_id: 'u-gone', content: 'Agreed.', reply_to_message_id: 'x', reply_to_content: 'Friday?', reply_to_sender_user_id: 'u-never-loaded' }) }], ['g1', 'g2'], note(''), send)
    expect(send.forwardMessage).toHaveBeenCalledTimes(2)
    expect((send.forwardMessage.mock.calls[0] as unknown as [MessageItem])[0].content).toBe(LEAD + '> **Unknown member**\n>\n> > **Unknown member**：Friday?\n>\n> Agreed.')
  })
})

describe('forwardToChats, a single piece', () => {
  it('is quoted under its speaker too, with the line it answered, the note first', async () => {
    const send = io()
    const agreed = message({ id: 'b', content: 'Agreed.', reply_to_message_id: 'a', reply_to_content: 'Friday?', reply_to_sender_user_id: 'u-mei' })
    await forwardToChats([{ kind: 'message', message: agreed }], ['g1'], note('for you'), send)
    expect((send.forwardMessage.mock.calls[0] as unknown as [MessageItem])[0].content).toBe('for you\n\n> **Han**\n>\n> > **Mei**：Friday?\n>\n> Agreed.')
    expect(send.sendMessageToChat).not.toHaveBeenCalled()
  })
})

describe('forwardToChats, a failure part-way', () => {
  it('reports each chat once it has its copy, and not the one that failed or those after it', async () => {
    const send = io()
    const forwardMessage = vi.fn(async (_message: unknown, chatId: string) => { if (chatId === 'g2') throw new Error('outbox refused') })
    const sent: string[] = []
    await expect(forwardToChats([{ kind: 'message', message: message({ id: 'a', content: 'Friday?' }) }], ['g1', 'g2', 'g3'], note(''), { ...send, forwardMessage }, id => sent.push(id))).rejects.toThrow('outbox refused')
    expect(sent).toEqual(['g1'])
  })
})

describe('forwardToChats, a note that @-s', () => {
  it('addresses the message carrying the note, whether quoted words or the note alone', async () => {
    const send = io()
    await forwardToChats([lead, { kind: 'text', sender: 'Han', text: 'Because.' }], ['g1'], note('@[Bot](aid:bot) look', ['bot']), send)
    expect(send.sendMessageToChat).toHaveBeenCalledWith('g1', '@[Bot](aid:bot) look\n\n' + LEAD + '> **Han**\n>\n> Because.', { toUserIds: ['bot'] })
    const file = message({ id: 'f', content_type: 'attachment', content: '[file]' })
    const again = io()
    await forwardToChats([{ kind: 'message', message: file }], ['g1'], note('see', ['bot']), again)
    expect(again.forwardMessage).toHaveBeenCalledWith(file, 'g1')
    expect(again.sendMessageToChat).toHaveBeenCalledWith('g1', 'see', { toUserIds: ['bot'] })
  })
})

describe('forwardToChats, the line a reply answered', () => {
  it('is quoted as plain text, not as the markdown it was written in', async () => {
    const send = io()
    await forwardToChats([lead, { kind: 'message', message: message({ id: 'r', content: 'Agreed.', reply_to_message_id: 'x', reply_to_content: '> **Mei**\n>\n> ship **Friday**', reply_to_sender_user_id: 'u-mei' }) }], ['g1'], note(''), send)
    expect((send.forwardMessage.mock.calls[0] as unknown as [MessageItem])[0].content).toContain('> > **Mei**：Mei ship Friday')
  })
})
