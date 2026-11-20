/* eslint-disable react-refresh/only-export-components -- Providers and their hooks share the same feature context instances. */
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuthUser } from '@/store/auth'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { teamApi } from './runtime'
import { hasTeamAccountMarker } from './accountKind'
import { teamErrorCopy } from './copy'
import type { CurrentTeamContext, TeamApi, TeamProfile } from './types'
import { refreshFailure, useReplica } from '@/lib/replica'
import { teamApiKey, teamSession } from './replicas'
import './catalog'
import './team.css'

const ApiContext = createContext<TeamApi>(teamApi)
export function TeamApiProvider({ api, children }: { api: TeamApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}
export const useTeamApi = () => useContext(ApiContext)

export interface TeamSessionState {
  status: 'personal' | 'loading' | 'ready' | 'error'
  context?: CurrentTeamContext
  profile?: TeamProfile
  error?: unknown
  retry: () => void
}
const SessionContext = createContext<TeamSessionState>({ status: 'personal', retry() {} })
export const useTeamSession = () => useContext(SessionContext)
function TeamSession({ user, children }: { user: AuthUser; children: ReactNode }) {
  const api = useTeamApi()
  const { updateUser } = useAuth()
  const teamMarked = hasTeamAccountMarker(user)
  // Read while this account is marked a team member (an identity switch takes the reading with the account).
  const reading = useReplica(teamSession, teamMarked ? [teamApiKey(api)] : null)
  const data = reading.state === 'value' ? reading.value : undefined
  const failure = refreshFailure(reading)
  // Canonical team profile owns its display email; the internal Auth principal email is never shown. Projected once per
  // profile as read (by content: every re-read answers a new object), so a later self edit is not overwritten by a poll.
  const projectedProfile = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (!data || failure) return
    const read = JSON.stringify(data.profile)
    if (projectedProfile.current === read) return
    projectedProfile.current = read
    const profile = data.profile.profile
    if (user.nickname !== profile.name || user.email !== profile.email || user.bio !== profile.bio
      || (user.avatarUrl ?? null) !== profile.avatar) updateUser({ ...user, nickname: profile.name,
      email: profile.email, bio: profile.bio, avatarUrl: profile.avatar ?? undefined })
  }, [data, failure, updateUser, user])
  const state: TeamSessionState = !teamMarked ? { status: 'personal', retry() {} }
    : { status: failure ? 'error' : data ? 'ready' : 'loading', ...data,
      error: failure ?? undefined, retry: () => { if (reading.state !== 'unknown') void reading.retry?.() } }
  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

/** Team reads are account replicas: no team data survives an identity switch (the replica leaves with the account). */
export function TeamProvider({ user, api = teamApi, children }: { user: AuthUser; api?: TeamApi; children: ReactNode }) {
  return <TeamApiProvider api={api}>
    <TeamSession user={user}>{children}</TeamSession>
  </TeamApiProvider>
}

export function TeamAccessGate({ children }: { children: ReactNode }) {
  const session = useTeamSession()
  const { logout } = useAuth()
  const { t } = useTranslation('team')
  const entered = useRef(false)
  if (session.status === 'ready') entered.current = true
  const allowed = session.status === 'personal' || session.status === 'ready'
  const blocked = <div className="gg-team-access-blocker" role={session.status === 'error' ? 'alert' : 'status'}>
    {session.status === 'loading' ? <LoadingIndicator size="inline" ariaLabel={t('loading')} /> : <>
      <p>{teamErrorCopy(session.error, t)}</p>
      <div><Button onClick={session.retry}>{t('retry')}</Button><Button variant="ghost" onClick={() => { void logout() }}>{t('returnLogin')}</Button></div>
    </>}
  </div>
  // A read/revocation failure blocks new interaction without aborting an accepted upstream turn.
  return <><div className="gg-team-preserved-product" inert={!allowed} aria-hidden={!allowed || undefined}>
    {(allowed || entered.current) && children}
  </div>{!allowed && blocked}</>
}
