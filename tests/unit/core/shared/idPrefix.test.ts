// Owner 2026-11-15/16: session ids, Agent IDs and message ids may be written as their first 8+ characters; one matcher.
import { describe, expect, it } from 'vitest'
import { idPrefixMatches, isIdPrefix, matchIdPrefix, uuidPrefixRange } from '../../../../packages/core/src/shared/idPrefix'
import { conversationLink, parseConversationLink } from '../../../../packages/core/src/shared/ui/guguLink'

const A = 'abcdef12-3456-4789-8abc-def012345678'
const B = 'abcdef12-0000-4000-8000-000000000000'
const match = (id: string, rows: string[]) => matchIdPrefix({
  kind: 'msg', id, rows, keyOf: (row) => row, noun: 'messages', describe: () => 'x', notFound: (address) => `No message matches ${address}`, tail: '; nothing was sent',
})

describe('id prefixes', () => {
  it('a full UUID or fewer than 8 characters is not a prefix', () => {
    expect(isIdPrefix(A)).toBe(false)
    expect(isIdPrefix('abcdef1')).toBe(false)
    expect(isIdPrefix('abcdef12')).toBe(true)
    expect(isIdPrefix('abcdef12-34')).toBe(true)
  })

  it('a hex prefix is the inclusive UUID range it names; anything else names nothing', () => {
    expect(uuidPrefixRange('ABCDEF12')).toEqual({ lo: 'abcdef12-0000-0000-0000-000000000000', hi: 'abcdef12-ffff-ffff-ffff-ffffffffffff' })
    expect(uuidPrefixRange('abcdef12-34')).toEqual({ lo: 'abcdef12-3400-0000-0000-000000000000', hi: 'abcdef12-34ff-ffff-ffff-ffffffffffff' })
    // A prefix is of the id as written: past 8 characters the hyphen is part of it.
    expect(uuidPrefixRange('abcdef1234')).toBeNull()
    expect(uuidPrefixRange('abcd-ef12')).toBeNull()
    expect(uuidPrefixRange('xyzxyzxy')).toBeNull()
    // Not a prefix at all: taken as written by the exact paths.
    expect(uuidPrefixRange('abcdef1')).toBeNull()
    expect(uuidPrefixRange(A)).toBeNull()
  })

  it('exact first, else the one row it prefixes; several list the candidates; none says so', () => {
    expect(match('ABCDEF12-3', [A, B])).toBe(A)
    expect(match(A, [A, `${A}0`])).toBe(A)
    expect(() => match('abcdef12', [A, B])).toThrow(`msg:abcdef12 matches 2 messages: msg:${A} (x), msg:${B} (x). Pass a longer prefix or the full id; nothing was sent`)
    expect(() => match('abcdef13', [A, B])).toThrow('No message matches msg:abcdef13')
    expect(idPrefixMatches('abcdef12', [A, A, B], (row) => row)).toHaveLength(2)
  })
})

// A message link may carry the first 8+ characters of the id: a prefix the reader resolves, never a messageId.
describe('a conversation link with a message prefix', () => {
  const CHAT = '11111111-1111-4111-8111-111111111111'
  it('reads the prefix apart from a message id, and builds links only from full ids', () => {
    expect(parseConversationLink(`gugu-chat://${CHAT}/ABCDEF12`)).toEqual({ chatId: CHAT, messagePrefix: 'abcdef12' })
    expect(parseConversationLink(`gugu-chat://${CHAT}/${A}`)).toEqual({ chatId: CHAT, messageId: A })
    expect(parseConversationLink(`gugu-chat://${CHAT}/abcdef1`)).toBeNull()
    expect(() => conversationLink(CHAT, 'abcdef12')).toThrow('message UUID')
  })
})
