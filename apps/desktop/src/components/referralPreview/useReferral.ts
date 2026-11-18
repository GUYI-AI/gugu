import { useReplica, replicaAccount } from '@/lib/replica'
import { personalReferral } from '@/lib/referralReplicas'

export function useReferral(userId: string | undefined) {
  const active = !!userId && replicaAccount().id === userId
  const reading = useReplica(personalReferral, active ? [] : null)
  return {
    data: reading.state === 'value' ? reading.value : undefined,
    failed: reading.state === 'error' || (reading.state === 'value' && !!reading.error),
    reload: () => { if (active) void personalReferral.refresh() },
  }
}
