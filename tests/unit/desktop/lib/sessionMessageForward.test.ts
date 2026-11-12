import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatMessage, TranscriptTurn } from '@gugu/session-chat-ui'
import { sessionForwardPieces } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/session-message-forward'

const turns = [{ id: 't1', seq: 1, initiator: 'user', items: [
  { kind: 'message', id: 'q', role: 'user', text: 'Why does login fail?' },
  { kind: 'message', id: 'a', role: 'assistant', text: 'The token expired.' },
] }] as unknown as TranscriptTurn[]
const answer = { kind: 'message', id: 'a', role: 'assistant', text: 'The token expired.' } as ChatMessage
const sent = (overrides: Partial<MessageItem>) => ({ id: 'm1', chat_id: 'g1', sender_user_id: null, content: 'hi', content_type: 'text', ...overrides }) as MessageItem

describe('sessionForwardPieces', () => {
  it('forwards an answer with the prompt that opened its turn', () => {
    expect(sessionForwardPieces({ itemId: 'a', message: answer, text: answer.text, sender: 'Codex', turns })).toEqual([
      { kind: 'text', sender: null, senderId: null, text: 'Why does login fail?' },
      { kind: 'text', sender: 'Codex', text: 'The token expired.' },
    ])
  })

  it('cuts a long prompt', () => {
    const long = [{ ...turns[0], items: [{ kind: 'message', id: 'q', role: 'user', text: 'x'.repeat(500) }, turns[0]!.items[1]] }] as unknown as TranscriptTurn[]
    const [prompt] = sessionForwardPieces({ itemId: 'a', message: answer, text: answer.text, sender: 'Codex', turns: long })!
    expect(prompt).toMatchObject({ kind: 'text', text: `${'x'.repeat(279)}…` })
  })

  it('forwards an answer alone when no prompt opened its turn', () => {
    expect(sessionForwardPieces({ itemId: 'a', message: answer, text: answer.text, sender: 'Codex', turns: [] })).toEqual([{ kind: 'text', sender: 'Codex', text: 'The token expired.' }])
  })

  it('forwards one\'s own prompt under one\'s own name, whatever the timeline labels it', () => {
    const prompt = { kind: 'message', id: 'q', role: 'user', text: 'Why does login fail?' } as ChatMessage
    expect(sessionForwardPieces({ itemId: 'q', message: prompt, text: prompt.text, sender: 'Delivered via Gugu', turns })).toEqual([{ kind: 'text', sender: null, text: 'Why does login fail?' }])
  })

  it('names a delivered prompt by who sent it', () => {
    const delivered = { kind: 'message', id: 'd', role: 'user', text: 'Ship it?', guguDelivery: { body: 'Ship it?', segments: [{ body: 'Ship it?', facts: { from: 'Leo (咕咕号 7)', fromId: 'user:leo' } }] } } as unknown as ChatMessage
    expect(sessionForwardPieces({ itemId: 'd', message: delivered, text: 'Ship it?', sender: 'Leo (咕咕号 7)', turns })).toEqual([{ kind: 'text', sender: 'Leo (咕咕号 7)', senderId: 'leo', text: 'Ship it?' }])
  })

  it('forwards a chat message the agent sent as itself, named after the agent', () => {
    const carried = sent({ content_type: 'attachment', content: '[file]' })
    expect(sessionForwardPieces({ itemId: 's', message: answer, text: '', sender: 'Codex', carried, turns })).toEqual([{ kind: 'message', message: carried, sender: 'Codex' }])
  })

  it('forwards what the agent handed its owner as words, and offers nothing for a file kept in the task', () => {
    const words = sent({ chat_id: '', content: 'Done.' })
    expect(sessionForwardPieces({ itemId: 's', message: answer, text: '', sender: 'Codex', carried: words, turns })).toEqual([{ kind: 'text', sender: 'Codex', text: 'Done.' }])
    const file = sent({ chat_id: '', content_type: 'attachment', content: '[file]', session_file: { path: 'notes.md', sha256: 'x' } })
    expect(sessionForwardPieces({ itemId: 's', message: answer, text: '', sender: 'Codex', carried: file, turns })).toBeNull()
  })
})
