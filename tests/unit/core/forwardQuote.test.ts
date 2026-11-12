import { describe, expect, it } from 'vitest'
import { forwardQuote } from '@gugu/core/shared/ui/forwardQuote'

describe('forwardQuote', () => {
  it('heads each quote with who said it, the note first', () => {
    expect(forwardQuote([
      { sender: 'Li Lei', text: 'Where does the login error come from?' },
      { sender: 'Claude', text: 'From `auth.ts:42`:\n\n```ts\nthrow e\n```' },
    ], 'see this')).toBe([
      'see this',
      '> **Li Lei**\n>\n> Where does the login error come from?',
      '> **Claude**\n>\n> From `auth.ts:42`:\n>\n> ```ts\n> throw e\n> ```',
    ].join('\n\n'))
  })

  it('carries the line a reply answered, cut to one line', () => {
    const text = forwardQuote([{ sender: 'Han', text: 'Agreed.', replyTo: { sender: 'Mei', text: `ship it on Friday\n${'x'.repeat(100)}` } }])
    expect(text.split('\n')[2]).toMatch(/^> > \*\*Mei\*\*：ship it on Friday x+…$/)
    expect(text.split('\n')[2]!.length).toBeLessThan(100)
    expect(text.endsWith('> Agreed.')).toBe(true)
  })

  it('keeps a name from turning into markup', () => {
    expect(forwardQuote([{ sender: '*bold*_[x]', text: 'hi' }])).toContain('> **\\*bold\\*\\_\\[x\\]**')
  })

  it('refuses an empty forward', () => {
    expect(() => forwardQuote([])).toThrow()
  })
})
