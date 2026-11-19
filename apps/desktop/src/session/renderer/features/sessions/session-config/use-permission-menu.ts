import { useQuery } from '@tanstack/react-query';
import { queryClient, useReplica } from '@/lib/replica';
import { customModelRefFromOption } from '@gugu/session-core/models/custom-model';
import { appSettingsModel, LOCAL_SETTINGS_HOST_KEY } from '@renderer/features/settings/app-settings-client';
import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import { rpcOn } from '@renderer/lib/ipc';
import { buildSessionPermissionOptions } from '@shared/session-permission-options';

/** The same model/connection read and option source for every session lifecycle. */
export function usePermissionMenu(input: {
  provider: string | null; model: string | null; modeMap?: ProviderPermissionModeMap;
  machine: string | null; leg: 'acp' | 'tui'; connectionKnown?: boolean;
}) {
  const { provider, model, modeMap, machine, leg, connectionKnown = true } = input;
  // A changed reviewer preference invalidates the read; only the host qualifies it.
  const preference = useReplica(appSettingsModel, customModelRefFromOption(model)
    ? ['autoReviewModel', machine ?? LOCAL_SETTINGS_HOST_KEY] : null);
  const preferenceRevision = preference.state === 'value' ? preference.value.value : null;
  const query = useQuery({
    queryKey: ['agents', 'permissionMenu', machine, provider, leg, model, connectionKnown, preferenceRevision],
    queryFn: () => rpcOn(machine).sessionTimeline.sessionCreateModels({
      harness: provider!, sessionView: leg === 'acp' ? 'general' : 'code', ...(model ? { model } : {}),
    }),
    enabled: connectionKnown && !!provider,
    staleTime: 15_000, refetchOnMount: 'always', refetchOnWindowFocus: false, retry: false,
  }, queryClient);
  const result = query.data;
  const group = connectionKnown && result?.ok ? result.value.permissionOptions : undefined;
  return group ?? buildSessionPermissionOptions({ modeMap, leg, structuralFullAccess: provider === 'grok' });
}
