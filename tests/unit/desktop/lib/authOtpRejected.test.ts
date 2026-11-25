import { describe, expect, it } from 'vitest'
import { isOtpRejectedError } from '../../../../apps/desktop/src/lib/authErrors'

// The login page says "check the 6 digits" instead of "request a new code" while the resend button is still counting
// down; it may only do that when the server refused the code itself, never for a network or rate-limit failure.
describe('isOtpRejectedError', () => {
  it('recognises GoTrue refusing the code', () => {
    expect(isOtpRejectedError({ code: 'otp_expired', message: 'Token has expired or is invalid' })).toBe(true)
    expect(isOtpRejectedError({ message: 'Token has expired or is invalid' })).toBe(true)
  })

  it('does not call a network or rate-limit failure a refused code', () => {
    expect(isOtpRejectedError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isOtpRejectedError({ status: 429, message: 'Too many requests' })).toBe(false)
    expect(isOtpRejectedError(undefined)).toBe(false)
  })
})
