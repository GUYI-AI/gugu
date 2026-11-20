import { useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '@/store/auth'
import { useTeamSession } from './context'
import { createTeamDisableIntentStore, subscribeTeamDisableIntents } from './disableIntentStore'

function subscribe(listener: () => void) {
  const stop = subscribeTeamDisableIntents(listener)
  window.addEventListener('storage', listener)
  return () => { stop(); window.removeEventListener('storage', listener) }
}

export function useTeamDisableIntent(memberId: string) {
  const { user } = useAuth(), session = useTeamSession()
  const store = useMemo(() => createTeamDisableIntentStore(window.localStorage, session.context?.team_id ?? '', user?.id ?? '', memberId), [session.context?.team_id, user?.id, memberId])
  const raw = useSyncExternalStore(subscribe, store.raw)
  try { return { store, intent: store.decode(raw), pending: raw !== null, unreadable: false } }
  catch { return { store, intent: null, pending: true, unreadable: true } }
}
