import { describe, expect, it } from 'vitest'
import { totpCode } from '../../../apps/desktop/electron/password-vault/totp'

// RFC 6238 appendix B: the ASCII keys "1234567890" repeated, base32-encoded.
const SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA'

describe('one-time codes from a stored TOTP seed', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(totpCode(`otpauth://totp/x?secret=${SHA1}&digits=8`, 59_000)).toBe('94287082')
    expect(totpCode(`otpauth://totp/x?secret=${SHA1}&digits=8`, 1_111_111_109_000)).toBe('07081804')
    expect(totpCode(`otpauth://totp/x?secret=${SHA256}&digits=8&algorithm=SHA256`, 59_000)).toBe('46119246')
  })
  it('takes a bare base32 seed as people paste it: 6 digits every 30 seconds', () => {
    expect(totpCode(SHA1.toLowerCase().replace(/(.{4})/g, '$1 '), 59_000)).toBe('287082')
    expect(totpCode(SHA1, 59_000)).not.toBe(totpCode(SHA1, 60_000))
  })
  it('refuses what is not a TOTP seed', () => {
    for (const seed of ['', 'not base32!', 'otpauth://hotp/x?secret=' + SHA1, `otpauth://totp/x?secret=${SHA1}&digits=4`, `otpauth://totp/x?secret=${SHA1}&algorithm=MD5`])
      expect(() => totpCode(seed)).toThrow()
  })
})
