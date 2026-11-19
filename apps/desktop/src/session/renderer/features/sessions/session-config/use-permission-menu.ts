import { useQuery } from '@tanstack/react-query';
import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import { rpcOn } from '@renderer/lib/ipc';
import { buildSessionPermissionOptions } from '@shared/session-permission-options';

/** The same model/connection read and option source for every session lifecycle. */
export function usePermissionMenu(input: {
  provider: string | null; model: string | null; modeMap?: ProviderPermissionModeMap;
  machine: string | null; leg: 'acp' | 'tui';
}) {
  const { provider, model, modeMap, machine, leg } = input;
  const query = useQuery({
    queryKey: ['agents', 'permissionMenu', machine, provider, leg, model],
    queryFn: () => rpcOn(machine).sessionTimeline.sessionCreateModels({
      harness: provider!, sessionView: leg === 'acp' ? 'general' : 'code', ...(model ? { model } : {}),
    }),
    enabled: !!provider && (!!modeMap || provider === 'grok'),
    staleTime: 15_000, refetchOnMount: 'always', refetchOnWindowFocus: false, retry: false,
  });
  const result = query.data;
  const group = result?.ok ? result.value.permissionOptions : undefined;
  return group ?? buildSessionPermissionOptions({ modeMap, leg, structuralFullAccess: provider === 'grok' });
}
