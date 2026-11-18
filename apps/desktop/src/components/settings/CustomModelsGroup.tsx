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
import { type CustomModelConnection } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon';
import { useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsPrimitives';
import { CustomModelDialog } from './CustomModelDialog';
import { SubscriptionConnections } from '@renderer/features/settings/subscriptions/SubscriptionConnections';

const MODEL_GROUPS = [
  { id: 'coding-plan', testId: 'settings-coding-plans', addId: 'coding-plan-add', title: 'customModels.coding', add: 'customModels.addPlan', note: 'customModels.planDescription' },
  { id: 'api', testId: 'settings-api-models', addId: 'api-model-add', title: 'customModels.apiTitle', add: 'customModels.addApi', note: 'customModels.apiDescription' },
  { id: 'custom', testId: 'settings-custom-models', addId: 'custom-model-add', title: 'customModels.title', add: 'customModels.add', note: 'customModels.description' },
] as const;
type ModelGroup = (typeof MODEL_GROUPS)[number]['id'];
const groupOf = (connection: CustomModelConnection): ModelGroup => providerPresets.find(preset => preset.id === connection.preset)?.group ?? 'custom';

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
  const [userEdit, setEditing] = useState<CustomModelConnection | ModelGroup | null>(null);
  const editing = addRequested ? 'custom' : userEdit;
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ group: ModelGroup; text: string } | null>(null);
  const refresh = () => { void customModels.refresh(machine); };
  const action = async (connection: CustomModelConnection, remove: boolean, modelId?: string) => {
    const connectionId = connection.id;
    const report = (text: string) => setFeedback({ group: groupOf(connection), text });
    setBusy(connectionId); setFeedback(null);
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      if (remove) {
        const result = await client.removeCustomModel({ connectionId });
        if (!result.success) throw new Error(errorText(result.error));
        await customModels.refresh(machine);
      } else {
        const result = await client.testCustomModel({ connectionId, modelId });
        if (!result.success) throw new Error(errorText(result.error));
        report(result.data.kind === 'listed' ? translate('customModels.connected', { count: result.data.models.length })
          : result.data.kind === 'connected' ? translate('customModels.connectedNoList')
          : translate(result.data.reason === 'no-list' ? 'customModels.noList' : result.data.reason === 'unauthorized' ? 'customModels.refused' : 'customModels.unreachable'));
      }
    } catch (error) { report(errorText(error)); }
    finally { setBusy(null); }
  };
  return <>
    {MODEL_GROUPS.map(({ id: group, testId, addId, title, add, note }) => <SettingsGroup key={group} data-testid={testId} title={<span className="flex items-center justify-between gap-3">
      {translate(title)}
      <Button size="sm" variant="outline" onClick={() => setEditing(group)} data-testid={addId}><Plus className="size-3.5" />{translate(add)}</Button>
    </span>} note={translate(note)} footer={feedback?.group === group ? <SettingsNote role="status">{feedback.text}</SettingsNote> : undefined}>
      {group === 'coding-plan' && agents?.filter(agent => agent.id === 'claude' || agent.id === 'codex').map(agent => <SubscriptionConnections key={agent.id} agent={agent} machine={machine} modelRows />)}
      {reading.state === 'error' ? <SettingsRow description={errorText(reading.error)} control={<Button onClick={refresh}>{translate('common.retry')}</Button>} />
        : reading.state === 'unknown' ? <SettingsRow control={<Unknown className="w-32" />} /> : <>
          <RefreshFailed error={reading.error} onRetry={refresh} />
          {reading.value.length === 0 ? null
          : reading.value.filter(connection => groupOf(connection) === group).flatMap((connection) => {
            const preset = providerPresets.find(({ id }) => id === connection.preset);
            const icon = modelProviderIcon(preset ? { id: preset.id, name: preset.name, iconKey: preset.icon } : null);
            return (connection.models.length ? connection.models : [{ id: '', label: translate('customModels.noModel') }]).map((model) => <SettingsRow
              key={`${connection.id}/${model.id}`} data-custom-connection={connection.id}
              leading={icon}
              title={model.label || model.id}
              description={!connection.keySaved ? translate('customModels.keyMissing') : preset?.name ?? endpointHost(connection)}
              control={<div className="flex items-center gap-1">
                {!model.id ? <Button size="sm" variant="outline" onClick={() => setEditing(connection)}>{translate('customModels.selectModel')}</Button> : null}
                <Button className="gg-model-icon-button" size="icon" variant="ghost" aria-label={translate('customModels.edit')} onClick={() => setEditing(connection)}><Pencil className="size-4" /></Button>
                <Button className="gg-model-icon-button" size="icon" variant="ghost" aria-label={translate('customModels.test')} disabled={busy === connection.id} onClick={() => { void action(connection, false, model.id || undefined); }}><Link className="size-4" /></Button>
                <Button className="gg-model-icon-button" size="icon" variant="ghost" aria-label={translate('customModels.remove')} disabled={busy === connection.id} onClick={() => { void action(connection, true); }}><Trash2 className="size-4" /></Button>
              </div>}
            />);
          })}
        </>}
    </SettingsGroup>)}
    {editing && <CustomModelDialog key={typeof editing === 'string' ? editing : editing.id} machine={machine} group={typeof editing === 'string' ? editing : groupOf(editing)} connection={typeof editing === 'string' ? undefined : editing} onClose={() => { setEditing(null); onAddClose?.(); }} />}
  </>;
});

function endpointHost(connection: CustomModelConnection): string {
  try { return new URL(connection.endpoints[0]!.baseUrl).host; }
  catch { return connection.name; }
}
