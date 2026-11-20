export const SIGNUP_CONSENT_REQUIRED_MARKER = 'GG-HK-CONSENT'
export type SignupConsentLanguage = 'zh' | 'en'
export type SignupConsent = { document_version: string; accepted_at: string }
export type SignupConsentAdapter = {
  enabled: boolean
  documentVersion(language: SignupConsentLanguage): string | null
  accept(language: SignupConsentLanguage, acceptedAt: string): Promise<SignupConsent>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** HTTP status comes from the response or SDK, never from a numeric wire error code. */
export function signupConsentRequired(error: unknown, httpStatus?: number): boolean {
  const body = record(error)
  if (!body) return false
  const status = httpStatus ?? body.status
  const code = typeof body.error_code === 'string' ? body.error_code
    : typeof body.code === 'string' ? body.code : undefined
  const message = typeof body.message === 'string' ? body.message
    : typeof body.msg === 'string' ? body.msg : undefined
  return status === 400 && code === 'unknown' && message?.includes(SIGNUP_CONSENT_REQUIRED_MARKER) === true
}

export function validSignupConsent(value: unknown): value is SignupConsent {
  const body = record(value)
  if (!body || typeof body.document_version !== 'string' || typeof body.accepted_at !== 'string') return false
  if (!/^hk-signup-v[1-9]\d*-(zh|en)$/.test(body.document_version)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.accepted_at)) return false
  const time = new Date(body.accepted_at)
  return Number.isFinite(time.getTime()) && time.toISOString() === body.accepted_at
}

/** No notice has been registered yet. A prototype version never enables real registration. */
export const disabledSignupConsentAdapter: SignupConsentAdapter = {
  enabled: false,
  documentVersion: () => null,
  accept: async () => { throw new Error('No published registration notice') },
}

/** Only an explicitly selected preview/test adapter can acknowledge these mock versions. */
export function createMockSignupConsentAdapter(
  save: (consent: SignupConsent) => Promise<unknown> = async consent => consent,
): SignupConsentAdapter {
  const documentVersion = (language: SignupConsentLanguage) => `hk-signup-v1-${language}`
  return {
    enabled: true,
    documentVersion,
    async accept(language, acceptedAt) {
      const consent = { document_version: documentVersion(language), accepted_at: acceptedAt }
      if (!validSignupConsent(consent)) throw new Error('Invalid registration consent')
      const confirmed = await save(consent)
      if (!validSignupConsent(confirmed) || confirmed.document_version !== consent.document_version
        || confirmed.accepted_at !== consent.accepted_at) throw new Error('Registration consent was not confirmed')
      return { document_version: confirmed.document_version, accepted_at: confirmed.accepted_at }
    },
  }
}
