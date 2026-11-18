import { Unknown } from '@/components/ui/Unknown';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme';
import { useTheme } from '@/store/theme';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Pencil, Plus, Trash2, Link } from '@/lib/icons';
import { useReplica } from '@/lib/replica';
import { Button } from '@renderer/lib/ui/button';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { matchCustomModel, type CustomModelConnection } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon';
import { useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsPrimitives';
import { CustomModelDialog } from './CustomModelDialog';

type AddRequest = { addRequested?: boolean; onAddClose?: () => void };

export const CustomModelsGroup = observer(function CustomModelsGroup({ addRequested, onAddClose }: AddRequest) {
  const { theme } = useTheme();
  const selected = useSelectedRemoteDevice(settingsDeviceStore);
  const machine = selected?.deviceId ?? null;
  const host = useMemo(() => machineLibraryHost(selected ? { deviceId: selected.deviceId, deviceLabel: selected.device.label, online: selected.device.isOnline, lastSeenAt: selected.device.lastSeenAt, hostKind: selected.device.hostKind } : null), [selected]);
  return <SessionUiTheme theme={theme} skin>
    <LibraryHostProvider value={host} key={host.key}><CustomModels machine={machine} addRequested={addRequested} onAddClose={onAddClose} /></LibraryHostProvider>
  </SessionUiTheme>;
});

const CustomModels = observer(function CustomModels({ machine, addRequested, onAddClose }: { machine: string | null } & AddRequest) {
  const { translate } = useSessionMessages();
  const reading = useReplica(customModels, [machine]);
  const { data: agents } = useAgents();
  const [userEdit, setEditing] = useState<CustomModelConnection | 'new' | null>(null);
  const editing = addRequested ? 'new' : userEdit;
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const refresh = () => { void customModels.refresh(machine); };
  const action = async (connectionId: string, remove: boolean, modelId?: string) => {
    setBusy(connectionId); setFeedback('');
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      if (remove) {
        const result = await client.removeCustomModel({ connectionId });
        if (!result.success) throw new Error(errorText(result.error));
        await customModels.refresh(machine);
      } else {
        const result = await client.testCustomModel({ connectionId, modelId });
        if (!result.success) throw new Error(errorText(result.error));
        setFeedback(result.data.kind === 'listed' ? translate('customModels.connected', { count: result.data.models.length })
          : result.data.kind === 'connected' ? translate('customModels.connectedNoList')
          : translate(result.data.reason === 'no-list' ? 'customModels.noList' : result.data.reason === 'unauthorized' ? 'customModels.refused' : 'customModels.unreachable'));
      }
    } catch (error) { setFeedback(errorText(error)); }
    finally { setBusy(null); }
  };
  return <>
    <SettingsGroup data-testid="settings-custom-models" title={<span className="flex items-center justify-between gap-3">
      {translate('customModels.title')}
      <Button size="sm" variant="outline" onClick={() => setEditing('new')} data-testid="custom-model-add"><Plus className="size-3.5" />{translate('customModels.add')}</Button>
    </span>} footer={feedback ? <SettingsNote role="status">{feedback}</SettingsNote> : undefined}>
      {reading.state === 'error' ? <SettingsRow description={errorText(reading.error)} control={<Button onClick={refresh}>{translate('common.retry')}</Button>} />
        : reading.state === 'unknown' ? <SettingsRow control={<Unknown className="w-32" />} /> : <>
          <RefreshFailed error={reading.error} onRetry={refresh} />
          {reading.value.length === 0 ? <SettingsRow description={translate('customModels.empty')} />
          : reading.value.flatMap((connection) => {
            const preset = providerPresets.find(({ id }) => id === connection.preset);
            const icon = modelProviderIcon(preset ? { id: preset.id, name: preset.name, iconKey: preset.icon } : null);
            const available = agents?.filter((agent) => !matchCustomModel({
              nativeProtocol: agent.capabilities.modelProtocols?.[0], protocols: agent.capabilities.modelProtocols,
              connection, hasModel: connection.models.length > 0, allowDefaultModel: agent.capabilities.customModel?.modelOptional,
            }).reason).length;
            return (connection.models.length ? connection.models : [{ id: '', label: translate('customModels.noModel') }]).map((model) => <SettingsRow
              key={`${connection.id}/${model.id}`} data-custom-connection={connection.id}
              leading={icon}
              title={<span className="flex items-center gap-2">{model.label || model.id}<span className="rounded border px-1 text-xs text-muted-foreground">{translate('customModels.badge')}</span></span>}
              description={!connection.keySaved ? translate('customModels.keyMissing')
                : available === undefined ? connection.name : `${connection.name} · ${translate('customModels.available', { count: available })}`}
              control={<div className="flex items-center gap-1">
                {!model.id ? <Button size="sm" variant="outline" onClick={() => setEditing(connection)}>{translate('customModels.selectModel')}</Button> : null}
                <Button size="icon" variant="ghost" aria-label={translate('customModels.edit')} onClick={() => setEditing(connection)}><Pencil className="size-4" /></Button>
                <Button size="icon" variant="ghost" aria-label={translate('customModels.test')} disabled={busy === connection.id} onClick={() => { void action(connection.id, false, model.id || undefined); }}><Link className="size-4" /></Button>
                <Button size="icon" variant="ghost" aria-label={translate('customModels.remove')} disabled={busy === connection.id} onClick={() => { void action(connection.id, true); }}><Trash2 className="size-4" /></Button>
              </div>}
            />);
          })}
        </>}
    </SettingsGroup>
    {editing && <CustomModelDialog key={typeof editing === 'string' ? editing : editing.id} machine={machine} connection={editing === 'new' ? undefined : editing} onClose={() => { setEditing(null); onAddClose?.(); }} />}
  </>;
});
