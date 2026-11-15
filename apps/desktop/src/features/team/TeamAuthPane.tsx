import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { sessionCoordinator } from '@/lib/sessionCoordinator'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { GoogleMark } from '@/pages/login/GoogleMark'
import { useTeamApi } from './context'
import { TeamApiError } from './errors'
import { teamErrorCopy, teamRoleLabel } from './copy'
import { createTeamGoogleProof } from './googleProof'
import { useTeamCommandKey } from './operations'
import type { TeamChallenge, TeamChoice, TeamInvitationInfo, TeamSignInResult } from './types'
import type { TeamInvitationLink } from '../../../shared/team-invitation-link'
import { readRegionalInvitation } from './invitation-region'
import '@/pages/login/login.css'

export function TeamAuthPane({ onPersonal, googleEnabled, invitationLink }: { onPersonal: () => void; googleEnabled: boolean; invitationLink?: TeamInvitationLink | null }) {
  const { t } = useTranslation('team'), api = useTeamApi(), key = useTeamCommandKey()
  const invitationToken = invitationLink?.token
  const verifiedLink = useRef<TeamInvitationLink | null>(null)
  const [mode, setMode] = useState<'sign_in' | 'create'>('sign_in'), [step, setStep] = useState<'email' | 'otp' | 'choice'>('email')
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [code, setCode] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [choices, setChoices] = useState<TeamChoice[]>([])
  const [googlePending, setGooglePending] = useState(false)
  const [invitation, setInvitation] = useState<TeamInvitationInfo | null>(null), [invitationLoading, setInvitationLoading] = useState(Boolean(invitationToken))
  const [resendAt, setResendAt] = useState(0), [now, setNow] = useState(Date.now)
  const [retryAt, setRetryAt] = useState(0)
  const challenge = useRef<TeamChallenge | null>(null), receipt = useRef<string | null>(null), googleChoice = useRef(false), alive = useRef(true)
  const attempt = useRef(0), google = useRef<ReturnType<typeof createTeamGoogleProof> | null>(null)
  const seconds = Math.max(0, Math.ceil((resendAt - now) / 1000))
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000)), clockActive = seconds > 0 || retrySeconds > 0
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; receipt.current = null; void google.current?.cancel() }
  }, [])
  useEffect(() => {
    if (!clockActive) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [clockActive])
  useEffect(() => {
    verifiedLink.current = null; setInvitation(null)
    if (!invitationLink) { setInvitationLoading(false); return }
    setInvitationLoading(true)
    let current = true
    void readRegionalInvitation(api, invitationLink).then(info => { if (current) { verifiedLink.current = invitationLink; setInvitation(info) } })
      .catch(cause => { if (current) setError(teamErrorCopy(cause, t)) })
      .finally(() => { if (current) setInvitationLoading(false) })
    return () => { current = false }
  }, [api, invitationLink, t])
  async function accept(result: TeamSignInResult) {
    if (!alive.current) return
    receipt.current = null
    await sessionCoordinator.acceptInteractiveSession(attempt.current, result.session)
  }
  function failure(cause: unknown) {
    if (!alive.current) return
    if (cause instanceof TeamApiError && cause.code === 'context_required' && cause.teams?.length) {
      setChoices(cause.teams); setStep('choice')
    } else setError(teamErrorCopy(cause, t))
    if (cause instanceof TeamApiError && cause.retry_after_seconds) { setRetryAt(Date.now() + cause.retry_after_seconds * 1000); setNow(Date.now()) }
    if (cause instanceof TeamApiError && ['verification_expired', 'verification_required', 'invalid_code'].includes(cause.code)) {
      receipt.current = null
      if (step === 'choice') { setChoices([]); setStep(googleChoice.current ? 'email' : 'otp'); googleChoice.current = false }
    }
  }
  async function send() {
    if (invitationLink && (verifiedLink.current !== invitationLink || !invitation)) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('emailRequired')); return }
    if (!invitationToken && mode === 'create' && !name.trim()) { setError(t('nameRequired')); return }
    if (seconds || retrySeconds || busy) return
    setBusy(true); setError('')
    try {
      const result = await api.challenge({ email: email.trim(), purpose: invitationToken ? 'accept_invitation' : mode,
        ...(invitationToken ? { invitation_token: invitationToken } : {}) })
      if (!alive.current) return
      challenge.current = result; receipt.current = null; setResendAt(Date.now() + result.resend_after_seconds * 1000); setNow(Date.now()); setStep('otp')
    } catch (cause) { failure(cause) }
    finally { if (alive.current) setBusy(false) }
  }
  async function verify() {
    if (invitationLink && (verifiedLink.current !== invitationLink || !invitation)) return
    if (busy || retrySeconds) return
    if (!/^\d{6}$/.test(code) || !challenge.current) { setError(t('codeRequired')); return }
    setBusy(true); setError(''); attempt.current = sessionCoordinator.beginInteractiveLogin(); googleChoice.current = false
    try {
      if (!receipt.current) {
        const verified = await api.verify(challenge.current.challenge_id, code)
        if (!alive.current) return
        receipt.current = verified.verification_receipt
      }
      const result = invitationToken ? await api.acceptInvitation(invitationToken, receipt.current, key({ invitationToken, receipt: receipt.current }))
        : mode === 'create' ? await api.create(name.trim(), receipt.current, key({ name: name.trim(), receipt: receipt.current })) : await api.signIn(receipt.current)
      await accept(result)
    } catch (cause) { failure(cause) }
    finally { if (alive.current) setBusy(false) }
  }
  async function choose(teamId: string) {
    if (busy || retrySeconds) return
    setBusy(true); setError('')
    try {
      if (!googleChoice.current && !receipt.current) throw new TeamApiError('verification_expired')
      const result = googleChoice.current ? await google.current!.choose(teamId) : await api.signIn(receipt.current!, teamId)
      await accept(result)
    } catch (cause) { failure(cause) }
    finally { if (alive.current) setBusy(false) }
  }
  async function signInGoogle() {
    if (busy || retrySeconds) return
    setBusy(true); setGooglePending(true); setError(''); googleChoice.current = true; attempt.current = sessionCoordinator.beginInteractiveLogin()
    try { google.current ??= createTeamGoogleProof(api); await accept(await google.current.start()) }
    catch (cause) { failure(cause) }
    finally { if (alive.current) { setBusy(false); setGooglePending(false) } }
  }
  function reset() { challenge.current = null; receipt.current = null; setCode(''); setChoices([]); setStep('email'); setError('') }
  const submitLabel = invitationToken ? t('acceptInvitation') : mode === 'create' ? t('verifyAndCreate') : t('verifySignIn')
  return <div className="gugu-auth-login gg-team-auth"><header className="gugu-auth-heading">
    <img className="gugu-auth-logo" src={publicAssetPath('/assets/app/gugu-icon-512.png')} alt="" draggable={false} />
    <h1 id="gugu-auth-title">{t('loginTitle')}</h1>
    <p>{invitation ? t('invitationHint', { team: invitation.team_name }) : t(mode === 'create' ? 'createHint' : 'emailHint')}</p></header>
    {!invitationToken && step === 'email' && <SegmentedTabs ariaLabel={t('loginTitle')} value={mode} onChange={value => { setMode(value); reset() }}
      items={[{ value: 'sign_in', label: t('signIn') }, { value: 'create', label: t('create') }]} />}
    {invitationLoading ? <LoadingIndicator size="inline" ariaLabel={t('loading')} /> : <form className="gugu-auth-form" onSubmit={event => { event.preventDefault(); if (!busy) void (step === 'email' ? send() : verify()) }}>
      {step === 'email' && <>
        {!invitationToken && mode === 'sign_in' && googleEnabled && <Button type="button" size="xl" className="gugu-auth-google" disabled={busy || retrySeconds > 0} onClick={() => { void signInGoogle() }}><GoogleMark />{t('google')}</Button>}
        {!invitationToken && mode === 'create' && <Field.Root><Field.Label>{t('teamName')}</Field.Label><Field.Input value={name} disabled={busy} maxLength={80} onChange={event => setName(event.target.value)} /></Field.Root>}
        {invitation && <p className="gg-team-muted">{invitation.email_hint}</p>}
        <Field.Root><Field.Label>{t(mode === 'create' && !invitationToken ? 'adminEmail' : 'email')}</Field.Label><Field.Input type="email" autoComplete="email" value={email} disabled={busy}
          onChange={event => setEmail(event.target.value)} /></Field.Root>
        <Button type="submit" variant="primary" size="xl" disabled={busy || (Boolean(invitationToken) && !invitation) || seconds > 0 || retrySeconds > 0}>{retrySeconds ? t('retryAfter', { seconds: retrySeconds }) : seconds ? t('resendAfter', { seconds }) : t(mode === 'create' && !invitationToken ? 'verifyCreate' : 'continue')}</Button>
      </>}
      {step === 'otp' && <><p role="status">{t('sentTo', { email })}</p><Field.Root><Field.Label>{t('code')}</Field.Label><Field.Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy}
        onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></Field.Root>
        <Button type="submit" variant="primary" size="xl" disabled={busy || code.length !== 6 || retrySeconds > 0}>{retrySeconds ? t('retryAfter', { seconds: retrySeconds }) : submitLabel}</Button>
        <div className="gugu-auth-actions"><Button type="button" variant="ghost" disabled={busy} onClick={reset}>{t('changeEmail')}</Button>
          <Button type="button" variant="ghost" disabled={busy || seconds > 0 || retrySeconds > 0} onClick={() => { void send() }}>{seconds ? t('resendAfter', { seconds }) : t('resend')}</Button></div></>}
      {step === 'choice' && <><p>{t('chooseTeamHint')}</p>{retrySeconds > 0 && <p role="status">{t('retryAfter', { seconds: retrySeconds })}</p>}{choices.map(team => <Button key={team.team_id} type="button" disabled={busy || retrySeconds > 0 || team.member_state !== 'active'}
        onClick={() => { void choose(team.team_id) }} className="gg-team-choice"><span>{team.team_name}</span><span>{teamRoleLabel(team.role, t)}</span></Button>)}</>}
      {error && <p role="alert" className="gugu-auth-error">{error}</p>}
      {busy && <LoadingIndicator size="inline" ariaLabel={t('loading')} />}
      {googlePending && <Button type="button" variant="ghost" onClick={() => {
        attempt.current = sessionCoordinator.beginInteractiveLogin(); void google.current?.cancel()
      }}>{t('cancel')}</Button>}
    </form>}
    <Button variant="ghost" disabled={busy} onClick={onPersonal}>{t('personalLogin')}</Button>
  </div>
}
