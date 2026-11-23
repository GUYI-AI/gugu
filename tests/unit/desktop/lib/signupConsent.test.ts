import { describe, expect, it, vi } from 'vitest'
import { createMockSignupConsentAdapter, disabledSignupConsentAdapter, signupConsentRequired, validSignupConsent } from '../../../../apps/desktop/src/lib/signupConsent'

const message = '请升级到新版咕咕再注册。（GG-HK-CONSENT）'
const consent = { document_version: 'hk-signup-v1-zh', accepted_at: '2026-11-16T04:00:00.000Z' }

describe('registration consent contract', () => {
  it('recognizes both wire forms using the real HTTP status, and the SDK form', () => {
    expect(signupConsentRequired({ code: 400, error_code: 'unknown', msg: message }, 400)).toBe(true)
    expect(signupConsentRequired({ code: 'unknown', message }, 400)).toBe(true)
    expect(signupConsentRequired({ status: 400, code: 'unknown', message })).toBe(true)
    expect(signupConsentRequired({ status: 400, code: 'unknown', message: 'Upgrade Gugu. GG-HK-CONSENT' })).toBe(true)
  })

  it.each([
    { status: 503, code: 'unknown', message },
    { status: 400, code: 'unknown', message: 'Other error' },
    { status: 400, code: 'validation_failed', message },
    { code: 400, error_code: 'unknown', msg: message },
    { status: '400', code: 'unknown', message },
    { status: 400, code: 'Unknown', message },
    { status: 400, code: 'unknown', message: 'gg-hk-consent' },
    null,
  ])('requires all three independent conditions: %j', error => {
    expect(signupConsentRequired(error)).toBe(false)
  })

  it('takes a response HTTP status over a conflicting body status', () => {
    expect(signupConsentRequired({ status: 400, code: 'unknown', message }, 503)).toBe(false)
  })

  it('accepts only the new-registration namespace and exact UTC millisecond time', () => {
    expect(validSignupConsent(consent)).toBe(true)
    for (const document_version of ['hk-storage-2026-11-15', 'hk-remigration-v1-zh', 'hk-signup-v01-zh', 'hk-signup-v0-zh', 'hk-signup-v1-fr']) {
      expect(validSignupConsent({ ...consent, document_version })).toBe(false)
    }
    for (const accepted_at of ['2026-11-16T04:00:00Z', '2026-11-16T12:00:00.000+08:00', '2026-02-30T04:00:00.000Z']) {
      expect(validSignupConsent({ ...consent, accepted_at })).toBe(false)
    }
  })

  it('keeps the unconfigured production adapter disabled', async () => {
    expect(disabledSignupConsentAdapter.enabled).toBe(false)
    expect(disabledSignupConsentAdapter.documentVersion('zh')).toBeNull()
    await expect(disabledSignupConsentAdapter.accept('zh', consent.accepted_at)).rejects.toThrow()
  })

  it('advances only after a confirmed matching mock write', async () => {
    let finish!: (value: unknown) => void
    const save = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve }))
    const adapter = createMockSignupConsentAdapter(save)
    const attempt = adapter.accept('zh', consent.accepted_at)
    expect(save).toHaveBeenCalledWith(consent)
    finish(consent)
    await expect(attempt).resolves.toEqual(consent)
  })

  it.each([undefined, {}, { ...consent, accepted_at: '2026-11-16T04:00:01.000Z' }, { ...consent, document_version: 'hk-signup-v1-en' }])('blocks an absent or mismatched acknowledgement: %j', async result => {
    const adapter = createMockSignupConsentAdapter(async () => result)
    await expect(adapter.accept('zh', consent.accepted_at)).rejects.toThrow()
  })

  it('keeps a failed write blocked and requires an explicit new attempt', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(consent)
    const adapter = createMockSignupConsentAdapter(save)
    await expect(adapter.accept('zh', consent.accepted_at)).rejects.toThrow('offline')
    expect(save).toHaveBeenCalledTimes(1)
    await expect(adapter.accept('zh', consent.accepted_at)).resolves.toEqual(consent)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
