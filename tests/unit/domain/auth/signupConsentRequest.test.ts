import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ signInWithOtp: vi.fn(), referrer: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ supabase: { auth: { signInWithOtp: m.signInWithOtp } }, identityDb: {} }))
vi.mock('../../../../apps/desktop/src/lib/referral', () => ({ consumePendingReferrer: m.referrer }))
import { authService } from '../../../../apps/desktop/src/lib/auth'

const consent = { document_version: 'hk-signup-v1-en', accepted_at: '2026-11-16T04:00:00.000Z' }
beforeEach(() => { vi.clearAllMocks(); m.signInWithOtp.mockResolvedValue({ error: null }); m.referrer.mockReturnValue(null) })

it('passes only the two consent fields through the existing OTP SDK options.data', async () => {
  await expect(authService.requestLoginOtp('new@example.test', { kind: 'signup', consent })).resolves.toEqual({ success: true })
  expect(m.signInWithOtp).toHaveBeenCalledExactlyOnceWith({ email: 'new@example.test', options: {
    shouldCreateUser: true, data: { nickname: 'new', display_name: 'new', cross_border_consent: consent },
  } })
})

it('does not add consent or create a user for an explicit existing-account sign-in', async () => {
  await authService.requestLoginOtp('existing@example.test', { kind: 'login' })
  expect(m.signInWithOtp.mock.calls[0]![0].options).toEqual({ shouldCreateUser: false, data: { nickname: 'existing', display_name: 'existing' } })
  expect(m.referrer).not.toHaveBeenCalled()
})

it('preserves the legacy SDK request when the new adapter is not selected', async () => {
  await authService.requestLoginOtp('legacy@example.test')
  expect(m.signInWithOtp.mock.calls[0]![0].options).toEqual({ shouldCreateUser: true, data: { nickname: 'legacy', display_name: 'legacy' } })
})

it('does not send an invalid consent or remove it and retry', async () => {
  await expect(authService.requestLoginOtp('new@example.test', { kind: 'signup', consent: { ...consent, document_version: 'prototype-v1.1' } })).resolves.toMatchObject({ success: false, reason: 'signup_consent_required' })
  expect(m.signInWithOtp).not.toHaveBeenCalled()
})

it('returns the consent domain reason only for all three backend conditions', async () => {
  m.signInWithOtp.mockResolvedValueOnce({ error: { status: 400, code: 'unknown', message: 'Update. GG-HK-CONSENT' } })
  await expect(authService.requestLoginOtp('new@example.test', { kind: 'signup', consent })).resolves.toMatchObject({ success: false, reason: 'signup_consent_required', status: 400, code: 'unknown' })
  m.signInWithOtp.mockResolvedValueOnce({ error: { status: 503, code: 'unknown', message: 'GG-HK-CONSENT' } })
  const result = await authService.requestLoginOtp('new@example.test', { kind: 'signup', consent })
  expect(result.success).toBe(false)
  expect(result.reason).toBeUndefined()
  expect(m.signInWithOtp).toHaveBeenCalledTimes(2)
})
