import { replica, useReplica } from '@/lib/replica';
import { customModelRefFromOption } from '@gugu/session-core/models/custom-model';
import { appSettingsModel, LOCAL_SETTINGS_HOST_KEY } from '@renderer/features/settings/app-settings-client';
import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import { rpcOn } from '@renderer/lib/ipc';
import { buildSessionPermissionOptions, PERMISSION_OPTIONS_UNREADABLE } from '@shared/session-permission-options';

/** What the host offers for a harness, model and leg (its permission options among them); read again on every open. */
const permissionMenu = replica({
  name: 'permissionMenu',
  scope: 'account',
  read: (_owner, machine: string | null, provider: string, leg: 'acp' | 'tui', model: string | null, _preference: unknown) =>
    rpcOn(machine).sessionTimeline.sessionCreateModels({ harness: provider, sessionView: leg === 'acp' ? 'general' : 'code', ...(model ? { model } : {}) }),
});

/** The same model/connection read and option source for every session lifecycle. */
export function usePermissionMenu(input: {
  provider: string | null; model: string | null; modeMap?: ProviderPermissionModeMap;
  machine: string | null; leg: 'acp' | 'tui'; connectionKnown?: boolean;
}) {
  const { provider, model, modeMap, machine, leg, connectionKnown = true } = input;
  // A changed reviewer preference invalidates the read (a connection or a Gugu model session); only the host qualifies it.
  const preference = useReplica(appSettingsModel, customModelRefFromOption(model) || model?.startsWith('platform:')
    ? ['autoReviewModel', machine ?? LOCAL_SETTINGS_HOST_KEY] : null);
  const preferenceRevision = preference.state === 'value' ? preference.value.value : null;
  const reading = useReplica(permissionMenu, connectionKnown && provider ? [machine, provider, leg, model, preferenceRevision] : null);
  const result = reading.state === 'value' ? reading.value : undefined;
  const group = result?.ok ? result.value.permissionOptions : undefined;
  // A failed read says so; "eligibility could not be confirmed" is only what a read still under way shows (#4043).
  const failed = reading.state === 'error' || (result !== undefined && !result.ok);
  return group ?? buildSessionPermissionOptions({ modeMap, leg, structuralFullAccess: provider === 'grok',
    ...(failed ? { review: { allowed: false, reason: PERMISSION_OPTIONS_UNREADABLE } } : {}) });
}
