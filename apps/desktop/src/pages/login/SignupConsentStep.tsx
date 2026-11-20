import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { Button } from '@/components/ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { validSignupConsent, type SignupConsent, type SignupConsentAdapter, type SignupConsentLanguage } from '@/lib/signupConsent'
import copy from './signup-consent-copy.json'
import './signup-consent.css'

export function SignupConsentStep({ language, adapter, onAccepted, onBack }: {
  language: SignupConsentLanguage
  adapter: SignupConsentAdapter
  onAccepted(consent: SignupConsent): void
  onBack(): void
}) {
  const { t } = useTranslation('main')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [declined, setDeclined] = useState(false)
  const attempt = useRef(0)
  const flight = useRef(false)
  useEffect(() => () => { attempt.current++ }, [])
  const words = copy[language]
  const policyToken = language === 'en' ? 'Privacy Policy' : '《隐私政策》'
  const privacyUrl = `https://gugu.nextmind.space/${language}/privacy.html`

  async function agree() {
    if (flight.current) return
    flight.current = true
    const id = ++attempt.current
    const acceptedAt = new Date().toISOString()
    setPending(true)
    setFailed(false)
    setDeclined(false)
    try {
      const confirmed = await adapter.accept(language, acceptedAt)
      if (id !== attempt.current) return
      if (!validSignupConsent(confirmed) || confirmed.document_version !== adapter.documentVersion(language)
        || confirmed.accepted_at !== acceptedAt) throw new Error('Registration consent was not confirmed')
      onAccepted(confirmed)
    } catch {
      if (id === attempt.current) setFailed(true)
    } finally {
      if (id === attempt.current) { flight.current = false; setPending(false) }
    }
  }

  return <section className="gugu-signup-consent" data-signup-consent="" lang={language} aria-labelledby="gugu-signup-consent-title">
    <header className="gugu-signup-consent-header">
      <img src={publicAssetPath('/assets/app/gugu-icon-512.png')} alt={t('brand.name')} />
      <Button variant="ghost" size="sm" onClick={() => { attempt.current++; onBack() }}>{t('auth.signup.back')}</Button>
    </header>
    <div className="gugu-signup-consent-reading" tabIndex={0}>
      <h1 id="gugu-signup-consent-title">{words[0]}</h1>
      <div className="gugu-signup-consent-body">{words.slice(1).map((paragraph, index) => {
        const parts = paragraph.split(policyToken)
        return <p key={index} data-consent-copy-index={index + 1}>{parts.length === 1 ? paragraph : <>
          {parts[0]}<a href={privacyUrl} target="_blank" rel="noopener noreferrer">{policyToken}</a>{parts[1]}
        </>}</p>
      })}</div>
    </div>
    <div className="gugu-signup-consent-actions">
      {declined && <p role="status">{t('auth.signup.declined')}</p>}
      {failed && <p role="alert" className="gugu-auth-error">{t('auth.signup.saveFailed')}</p>}
      <div className="gugu-signup-consent-buttons">
        <Button type="button" size="xl" variant="primary" disabled={pending} onClick={() => { void agree() }}>
          {pending ? <LoadingIndicator size="inline" ariaLabel={t('auth.signup.agree')} /> : t('auth.signup.agree')}
        </Button>
        <Button type="button" size="xl" variant="secondary" disabled={pending} onClick={() => { setFailed(false); setDeclined(true) }}>{t('auth.signup.disagree')}</Button>
      </div>
    </div>
  </section>
}
