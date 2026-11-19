import { createMockSignupConsentAdapter, disabledSignupConsentAdapter } from '@/lib/signupConsent'

// Explicit task preview only. Normal builds, including Beta, keep the fake adapter disabled.
export const signupConsentAdapter = import.meta.env.VITE_GUGU_HK_SIGNUP_MOCK === 'true'
  ? createMockSignupConsentAdapter()
  : disabledSignupConsentAdapter
