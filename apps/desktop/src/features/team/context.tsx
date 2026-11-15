/* eslint-disable react-refresh/only-export-components -- Providers and their hooks share the same feature context instances. */
import { createContext, useContext, useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { AuthUser } from '@/store/auth'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { teamApi } from './runtime'
import { TeamApiError } from './errors'
import { hasTeamAccountMarker } from './accountKind'
import { teamErrorCopy } from './copy'
import type { CurrentTeamContext, TeamApi, TeamProfile } from './types'
import './catalog'
import './team.css'
import { TEAM_REALTIME_CONTEXT_CHANGED } from '../../../shared/team-realtime'

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
export const teamKeys = {
  account: (userId: string) => ['team', userId] as const,
  session: (userId: string) => ['team', userId, 'context'] as const,
}

function TeamSession({ user, children }: { user: AuthUser; children: ReactNode }) {
  const api = useTeamApi()
  const { updateUser } = useAuth()
  const teamMarked = hasTeamAccountMarker(user)
  const query = useQuery({
    queryKey: teamKeys.session(user.id), enabled: teamMarked, retry: false, staleTime: 0,
    refetchOnWindowFocus: true, refetchInterval: teamMarked ? 30_000 : false,
    queryFn: async ({ signal }) => {
      const context = await api.context(signal)
      if (context.kind !== 'team') throw new TeamApiError('team_identity_required')
      if (context.member_state !== 'active') throw new TeamApiError('membership_disabled')
      const profile = await api.profile(signal)
      if (context.member_identity_id !== user.id || profile.team.id !== context.team_id || profile.membership.id !== context.member_id
        || profile.membership.identity_id !== context.member_identity_id
        || profile.membership.state !== 'active' || profile.membership.role !== context.role
        || profile.membership.revision !== context.membership_revision) throw new TeamApiError('version_conflict')
      return { context, profile }
    },
  })
  const refetch = query.refetch
  useEffect(() => {
    if (!teamMarked) return
    const refresh = () => { void refetch() }
    window.addEventListener(TEAM_REALTIME_CONTEXT_CHANGED, refresh)
    return () => window.removeEventListener(TEAM_REALTIME_CONTEXT_CHANGED, refresh)
  }, [refetch, teamMarked])
  // Canonical team profile owns its display email; the internal Auth principal email is never shown.
  const projectedProfile = useRef<TeamProfile | undefined>(undefined)
  useLayoutEffect(() => {
    if (!query.data || query.isError) return
    if (projectedProfile.current === query.data.profile) return
    projectedProfile.current = query.data.profile
    const profile = query.data.profile.profile
    if (user.nickname !== profile.name || user.email !== profile.email || user.bio !== profile.bio
      || (user.avatarUrl ?? null) !== profile.avatar) updateUser({ ...user, nickname: profile.name,
      email: profile.email, bio: profile.bio, avatarUrl: profile.avatar ?? undefined })
  }, [query.data, query.isError, updateUser, user])
  const state: TeamSessionState = !teamMarked ? { status: 'personal', retry() {} }
    : { status: query.isError ? 'error' : query.data ? 'ready' : 'loading', ...query.data,
      error: query.error, retry: () => { void query.refetch() } }
  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

/** A fresh account gets a fresh feature cache. No team data survives an identity switch. */
export function TeamProvider({ user, api = teamApi, children }: { user: AuthUser; api?: TeamApi; children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }))
  useEffect(() => () => { void client.cancelQueries(); client.clear() }, [client])
  return <QueryClientProvider client={client}><TeamApiProvider api={api}>
    <TeamSession user={user}>{children}</TeamSession>
  </TeamApiProvider></QueryClientProvider>
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
