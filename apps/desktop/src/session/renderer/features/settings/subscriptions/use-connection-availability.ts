import { useIsFetching } from '@tanstack/react-query'
import { queryClient, useReadModel } from '@/lib/readModel'
import { connectionAvailability } from './subscription-queries'

/** Same auth reading used by the harness model-credential predicate; payer is not a credential. */
export function useConnectionAvailability(providerId: string, machine: string | null, missingProgram = false) {
  const reading = useReadModel(connectionAvailability, [machine, providerId])
  const auth = reading.state === 'value' ? reading.value : undefined
  const error = reading.state === 'error' ? reading.error : reading.state === 'value' ? reading.error : null
  const credentialState =
    auth?.kind === 'authenticated'
      ? 'usable'
      : auth?.kind === 'unauthenticated' || missingProgram
        ? 'unusable'
        : 'failed'
  // A check in flight says so (the person asked for it, or the card opened): what was read before is not this answer.
  const checking = useIsFetching({ queryKey: connectionAvailability.key(machine, providerId)!, exact: true }, queryClient) > 0
  const state = reading.state === 'unknown' || checking ? 'checking' : error ? 'failed' : credentialState
  const refresh = () => connectionAvailability.refresh(machine, providerId)
  return { auth, state, refresh, error } as const
}
