import { describe, expect, it } from 'vitest'
import { parseGuguLink, parseShortRef } from '@gugu/core/shared/ui/guguLink'

// Owner 2026-11-27: a reference is a whole link the product wrote, or a short id — nothing in between.
describe('short ids and whole links', () => {
  const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', message = '11111111-2222-4333-8444-555555555555'

  it('reads msg: and session: with the whole id or its first 8+ characters', () => {
    expect(parseShortRef('session:4DF04861')).toEqual({ kind: 'session', id: '4df04861' })
    expect(parseShortRef('msg:1a2b3c4d-5e')).toEqual({ kind: 'msg', id: '1a2b3c4d-5e' })
    expect(parseShortRef(`session:${message}`)).toEqual({ kind: 'session', id: message })
    for (const text of ['session:4df0486', 'session:zzzzzzzz', 'msg:1a2b3c4d5e', 'aid:4df04861', `gugu-chat://${chat}/1a2b3c4d`]) expect(parseShortRef(text)).toBeNull()
  })

  it('reads a conversation link only with whole ids', () => {
    expect(parseGuguLink(`gugu-chat://${chat}/${message}`)).toEqual({ kind: 'chat', chatId: chat, messageId: message })
    expect(parseGuguLink(`gugu-chat://${chat}/1a2b3c4d`)).toBeNull()
  })
})
