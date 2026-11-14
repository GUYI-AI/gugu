import { useEffect,useState,type ReactNode } from 'react'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { useConnectionAuthority } from '@/lib/connectionBridge'
import { SettingsPage } from '@/components/settings/SettingsPrimitives'
import { AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero'
import { ConnectionMutationContext } from './connection-mutation-context'

/** A route read answers in tens of milliseconds; the skeleton is for a read that is really late, not a flash on every entry. */
const SLOW_ROUTE_MS = 400

/** An unavailable authority never selects a credential or account source. */
export function ConnectionRouteBoundary({ owner,legacy }: { owner(route: ConnectionRoute): ReactNode; legacy: ReactNode }) {
  const { route } = useConnectionAuthority()
  if (!route) return <SlowRoutePlaceholder />
  return <ConnectionMutationContext value={route.phase === 'stable' && route.acceptingNewOperations} key={`${route.mode}:${route.epoch}`}>
    {route.mode === 'owner' ? owner(route) : legacy}
  </ConnectionMutationContext>
}

function SlowRoutePlaceholder() {
  const [late,setLate] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setLate(true),SLOW_ROUTE_MS); return () => clearTimeout(timer) },[])
  return late ? <SettingsPage data-testid="connection-authority-unavailable"><AppConnectionListPlaceholder /></SettingsPage> : null
}
