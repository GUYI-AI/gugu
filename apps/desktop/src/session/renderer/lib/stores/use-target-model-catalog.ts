import { useQuery } from '@tanstack/react-query';
import { rpcOn } from '@renderer/lib/ipc';
import { useLibraryHost } from '@renderer/features/library/library-host';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import type { HarnessCatalogState } from './use-harness-model-catalog';

/** Model-specific native facts live in their own query, independent of the default catalog. */
export function useTargetModelCatalog(providerId: string | null, leg: SessionpageLeg, model: string | null) {
  const host = useLibraryHost().remote;
  const machine = host?.deviceId ?? null;
  return useQuery<HarnessCatalogState>({
    queryKey: ['agents', 'targetModelCatalog', machine, providerId, leg, model],
    queryFn: () => rpcOn(machine).agents.targetModelCatalog(providerId!, leg, model!),
    enabled: !!providerId && !!model && host?.online !== false,
    staleTime: 30_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false,
  }).data;
}
