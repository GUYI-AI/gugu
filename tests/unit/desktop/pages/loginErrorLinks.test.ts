import { describe, expect, it } from 'vitest'
import { loginErrorParts } from '../../../../apps/desktop/src/pages/login/loginErrorLinks'

describe('links in login errors', () => {
  it('preserves surrounding text and punctuation while linking the official HTTPS destination', () => {
    const text = '请打开（https://gugu.nextmind.space/hk），完成后重试。'
    expect(loginErrorParts(text)).toEqual([
      { text: '请打开（' },
      { text: 'https://gugu.nextmind.space/hk', href: 'https://gugu.nextmind.space/hk' },
      { text: '），完成后重试。' },
    ])
  })

  it.each([
    'https://gugu.nextmind.space.evil.com/hk',
    'https://evil-gugu.nextmind.space/hk',
    'https://www.gugu.nextmind.space/hk',
    'https://evil.com/?next=https://gugu.nextmind.space/hk',
    'http://gugu.nextmind.space/hk',
    'ftp://gugu.nextmind.space/hk',
    'javascript:alert(1)',
    'gugu.nextmind.space/hk',
    'https://name:password@gugu.nextmind.space/hk',
    'https://gugu.nextmind.space:8443/hk',
  ])('keeps an unapproved destination as literal text: %s', text => {
    expect(loginErrorParts(text)).toEqual([{ text }])
  })

  it('checks the parsed hostname and preserves multiple destinations without inserting markup', () => {
    const text = '<b>Failure</b> HTTPS://GUGU.NEXTMIND.SPACE/hk. https://evil.com/hk https://gugu.nextmind.space/zh/privacy.html'
    const parts = loginErrorParts(text)
    expect(parts.map(part => part.text).join('')).toBe(text)
    expect(parts.flatMap(part => part.href ? [part.href] : [])).toEqual([
      'https://gugu.nextmind.space/hk', 'https://gugu.nextmind.space/zh/privacy.html',
    ])
  })
})
