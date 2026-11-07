import { describe, expect, it } from 'vitest'
import { maskedAccount } from '../../../apps/desktop/electron/password-vault/schema'

describe('recognizable account summaries', () => {
  it.each([
    ['demo.user@example.com', 'd***@example.com'],
    ['demo+tag@example.com', 'd***@example.com'],
    ['ab@example.com', 'a***@example.com'],
    ['a@example.com', '***@example.com'],
    ['用户@example.com', '用***@example.com'],
    ['用户@例子.公司', '用***@例子.公司'],
    ['developer', 'd***'], ['ab', 'a***'], ['a', '***'],
    ['a***', '***'], ['a***@example.com', '***@example.com'],
    ['用户', '用***'], ['用', '***'], ['🙂x', '🙂***'], ['🙂', '***'],
    ['e\u0301x', 'e\u0301***'], ['e\u0301', '***'], ['👩‍💻', '***'], ['👩‍💻dev', '👩‍💻***'],
    ['a@@example.com', 'a***'], ['ab@example.com/private', 'a***'],
    ['ab@example.com?private', 'a***'], ['ab@example.com#private', 'a***'],
    ['ab@example.com\\private', 'a***'], ['ab@example.com:443', 'a***'],
    ['ab@', 'a***'], ['ab\n@example.com', '***'],
    ['', ''], ['   ', ''],
  ])('masks synthetic account %j', (input, expected) => {
    expect(maskedAccount(input)).toBe(expected)
    if (input.trim()) expect(maskedAccount(input) === input).toBe(false)
  })
  it.each([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])(
    'hides bidi control code point %i at the prefix and inside a synthetic account', point => {
      const control = String.fromCodePoint(point)
      expect(maskedAccount(control + 'demo@example.com')).toBe('***')
      expect(maskedAccount('demo' + control + '@example.com')).toBe('***')
    })
})
