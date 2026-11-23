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
    'javascript:alert(1)',
    'https://name:password@gugu.nextmind.space/hk',
    'https://gugu.nextmind.space:8443/hk',
  ])('keeps an unapproved destination as literal text: %s', text => {
    expect(loginErrorParts(text)).toEqual([{ text }])
  })

  it.each([
    ['gugu.nextmind.space/hk', '', 'gugu.nextmind.space/hk', ''],
    ['打开 gugu.nextmind.space/hk 点同意。', '打开 ', 'gugu.nextmind.space/hk', ' 点同意。'],
    ['请打开（gugu.nextmind.space/hk），完成后重试。', '请打开（', 'gugu.nextmind.space/hk', '），完成后重试。'],
    ['Open gugu.nextmind.space/hk.', 'Open ', 'gugu.nextmind.space/hk', '.'],
    ['Open "gugu.nextmind.space/hk".', 'Open "', 'gugu.nextmind.space/hk', '".'],
    ['Open (gugu.nextmind.space/hk).', 'Open (', 'gugu.nextmind.space/hk', ').'],
    ['GUGU.NEXTMIND.SPACE/hk', '', 'GUGU.NEXTMIND.SPACE/hk', ''],
  ])('normalizes only the standalone recovery address without changing visible text: %s', (message, before, address, after) => {
    const parts = loginErrorParts(message)
    expect(parts).toEqual([
      ...(before ? [{ text: before }] : []),
      { text: address, href: 'https://gugu.nextmind.space/hk' },
      ...(after ? [{ text: after }] : []),
    ])
    expect(parts.map(part => part.text).join('')).toBe(message)
  })

  it.each([
    'evil-gugu.nextmind.space/hk',
    'www.gugu.nextmind.space/hk',
    'gugu.nextmind.space.evil.com/hk',
    'gugu.nextmind.space/hk.evil.com',
    'gugu.nextmind.space/hk-extra',
    'gugu.nextmind.space/hkevil',
    'gugu.nextmind.space/hk/extra',
    'gugu.nextmind.space/hk?next=evil',
    'gugu.nextmind.space/hk#extra',
    'gugu.nextmind.space/hk%2fextra',
    'gugu.nextmind.space/HK',
    'gugu.nextmind.space/zh/privacy.html',
    'example.com/hk',
    'name@gugu.nextmind.space/hk',
    '//gugu.nextmind.space/hk',
    'http:gugu.nextmind.space/hk',
    'data:text/plain,gugu.nextmind.space/hk',
    'https://evil.com/?next=gugu.nextmind.space/hk',
  ])('does not extract the bare recovery address from a different URL or token: %s', message => {
    expect(loginErrorParts(message)).toEqual([{ text: message }])
  })

  it.each([
    'ftp://example.invalid/(gugu.nextmind.space/hk)',
    'ftps://example.invalid/（gugu.nextmind.space/hk）',
    'ftp://example.invalid/?next=，（gugu.nextmind.space/hk）',
    'mailto:person@example.invalid?subject=(gugu.nextmind.space/hk)',
    'https://example.invalid/?next="(gugu.nextmind.space/hk)"',
    'gugu.nextmind.space/hk?next=(gugu.nextmind.space/hk)',
    'gugu.nextmind.space/hk/extra/(gugu.nextmind.space/hk)',
    'example.invalid/path=(gugu.nextmind.space/hk)',
    'path/(gugu.nextmind.space/hk)',
    '?next=(gugu.nextmind.space/hk)',
  ])('keeps a complete rejected URL or token literal, including nested bare addresses: %s', message => {
    expect(loginErrorParts(message)).toEqual([{ text: message }])
  })

  it('does not mask independent targets after a rejected token', () => {
    const message = 'ftp://example.invalid/(gugu.nextmind.space/hk) (gugu.nextmind.space/hk) https://gugu.nextmind.space/hk'
    const parts = loginErrorParts(message)
    expect(parts.map(part => part.text).join('')).toBe(message)
    expect(parts.flatMap(part => part.href ? [part.href] : [])).toEqual([
      'https://gugu.nextmind.space/hk', 'https://gugu.nextmind.space/hk',
    ])
  })

  it('keeps HTTPS handling and text intact when bare and explicit addresses appear together', () => {
    const message = 'gugu.nextmind.space/hk https://gugu.nextmind.space/hk https://gugu.nextmind.space.evil.com/hk'
    const parts = loginErrorParts(message)
    expect(parts.map(part => part.text).join('')).toBe(message)
    expect(parts.flatMap(part => part.href ? [part.href] : [])).toEqual([
      'https://gugu.nextmind.space/hk', 'https://gugu.nextmind.space/hk',
    ])
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
