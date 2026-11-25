import { connectionProbeMessageKey } from '@renderer/features/settings/subscriptions/connection-probe-messages';
import { platform } from '@/platform';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { Unknown } from '@/components/ui/Unknown';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme';
import { useTheme } from '@/store/theme';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { Pencil, Trash2, Link, RefreshCw, Globe, Plus, Settings2 } from '@/lib/icons';
import { useReplica, valueOf } from '@/lib/replica';
import { Button } from '@renderer/lib/ui/button';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { refreshModelSubscriptions, subscriptionPlan, useSubscriptionPlan, errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { customModelApiUrl, type CustomModelConnection, type CustomModelEntry } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { vendorName } from '@/i18n/vendorName';
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon';
import { useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { Collapse } from '@/components/ui/Collapse';
import { SettingsGroup, SettingsNote, SettingsRow, Toggle } from './SettingsPrimitives';
import { CustomModelDialog } from './CustomModelDialog';
import { CodingPlanGroup } from './CodingPlanGroup';
import { planLabel } from '@renderer/features/settings/subscriptions/subscription-view';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { SubscriptionConnections } from '@renderer/features/settings/subscriptions/SubscriptionConnections';

const MODEL_GROUPS = [
  { id: 'coding-plan', testId: 'settings-coding-plans', addId: 'coding-plan-add', title: 'customModels.coding', add: 'customModels.addPlan' },
  { id: 'custom', testId: 'settings-custom-models', addId: 'custom-model-add', title: 'customModels.title', add: 'customModels.add' },
] as const;
type ModelGroup = (typeof MODEL_GROUPS)[number]['id'];
type NewModel = { group: 'coding-plan' | 'api'; account?: 'claude' | 'codex' };
const groupOf = (connection: CustomModelConnection): ModelGroup => providerPresets.some(preset => preset.id === connection.preset && preset.group === 'coding-plan') ? 'coding-plan' : 'custom';

type AddRequest = { addRequested?: boolean; onAddClose?: () => void; providedModels?: ReactNode };

export function CustomModelsGroup(props: AddRequest) {
  const { translate } = useSessionMessages();
  if (!platform.capabilities.modelSettings) return <>{props.providedModels}<SettingsNote data-testid="settings-models-desktop-only">{translate('customModels.desktopOnly')}</SettingsNote></>;
  return <AvailableCustomModelsGroup {...props} />;
}

const AvailableCustomModelsGroup = observer(function AvailableCustomModelsGroup({ addRequested, onAddClose, providedModels }: AddRequest) {
  const { theme } = useTheme();
  const selected = useSelectedRemoteDevice(settingsDeviceStore);
  const machine = selected?.deviceId ?? null;
  const host = useMemo(() => machineLibraryHost(selected ? { deviceId: selected.deviceId, deviceLabel: selected.device.label, online: selected.device.isOnline, lastSeenAt: selected.device.lastSeenAt, hostKind: selected.device.hostKind } : null), [selected]);
  return <SessionUiTheme theme={theme} skin>
    <LibraryHostProvider value={host} key={host.key}><CustomModels machine={machine} addRequested={addRequested} onAddClose={onAddClose} providedModels={providedModels} /></LibraryHostProvider>
  </SessionUiTheme>;
});

const CustomModels = observer(function CustomModels({ machine, addRequested, onAddClose, providedModels }: { machine: string | null } & AddRequest) {
  const { translate } = useSessionMessages();
  const reading = useReplica(customModels, [machine]);
  const connectionGroups = groupByApiUrl(valueOf(reading) ?? []);
  const conflicts = new Map(connectionGroups.filter(([, connections]) => connections.length > 1));
  const agents = valueOf(useAgents());
  const accountAgents = agents?.filter(agent => agent.id === 'claude' || agent.id === 'codex') ?? [];
  const planAgents = agents?.filter(agent => agent.id !== 'claude' && agent.id !== 'codex' &&
    agent.capabilities.subscription && agent.reading === 'installed') ?? [];
  const [userEdit, setEditing] = useState<CustomModelConnection | NewModel | null>(null);
  const [editingModel, setEditingModel] = useState<string | undefined>(undefined);
  const editModel = (connection: CustomModelConnection, modelId?: string) => { setEditingModel(modelId); setEditing(connection); };
  const editing: CustomModelConnection | NewModel | null = addRequested ? { group: 'api' } : userEdit;
  const [refreshing, setRefreshing] = useState(false);
  const refreshPlans = async () => {
    if (refreshing) return;
    setRefreshing(true); setFeedback(null);
    try {
      await Promise.all([refreshModelSubscriptions(machine, accountAgents.map(agent => agent.id)),
        ...planAgents.map(agent => subscriptionPlan.refresh(machine, agent.id))]);
    }
    catch (error) { setFeedback({ group: 'coding-plan', text: errorText(error) }); }
    finally { setRefreshing(false); }
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ group: ModelGroup; text: string } | null>(null);
  const refresh = () => { void customModels.refresh(machine); };
  const keepKey = async (connection: CustomModelConnection) => {
    setBusy(connection.id); setFeedback(null);
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      const result = await client.saveCustomModel({ id: connection.id, name: connection.name, apiUrl: customModelApiUrl(connection),
        preset: connection.preset, endpoints: connection.endpoints, models: connection.models, resolveUrlConflict: true });
      if (!result.success) throw new Error(errorText(result.error));
      await customModels.refresh(machine);
    } catch (error) { setFeedback({ group: 'custom', text: errorText(error) }); }
    finally { setBusy(null); }
  };
  const setModelEnabled = async (connection: CustomModelConnection, modelId: string, enabled: boolean) => {
    setBusy(connection.id); setFeedback(null);
    try {
      const entries = [...connection.models, ...(connection.disabledModels ?? [])].map(({ effortCatalog: _catalog, ...entry }: CustomModelEntry) => entry);
      const selected = new Set(connection.models.map(model => model.id));
      if (enabled) selected.add(modelId); else selected.delete(modelId);
      const client = await getAgentConfigRuntimeClient(machine);
      const result = await client.saveCustomModel({ id: connection.id, name: connection.name, apiUrl: customModelApiUrl(connection),
        preset: connection.preset, endpoints: connection.endpoints, routes: connection.routes, harnessProtocols: connection.harnessProtocols,
        models: entries.filter(model => selected.has(model.id)), disabledModels: entries.filter(model => !selected.has(model.id)) });
      if (!result.success) throw new Error(errorText(result.error));
      await customModels.refresh(machine);
    } catch (error) { setFeedback({ group: 'custom', text: errorText(error) }); }
    finally { setBusy(null); }
  };
  const testConnection = async (connection: CustomModelConnection) => {
    setBusy(connection.id); setFeedback(null);
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      const result = await client.testCustomModel({ connectionId: connection.id, modelId: connection.models[0]?.id });
      if (!result.success) throw new Error(errorText(result.error));
      const text = result.data.kind === 'listed' ? translate('customModels.connected', { count: result.data.models.length })
        : result.data.kind === 'connected' ? translate('customModels.connectedNoList')
        : translate(connectionProbeMessageKey(result.data.reason, providerPresets.some(preset => preset.id === connection.preset)));
      setFeedback({ group: groupOf(connection), text });
    } catch (error) { setFeedback({ group: groupOf(connection), text: errorText(error) }); }
    finally { setBusy(null); }
  };
  const removeConnection = async (connection: CustomModelConnection) => {
    const connectionId = connection.id;
    const report = (text: string) => setFeedback({ group: groupOf(connection), text });
    setBusy(connectionId); setFeedback(null);
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      const result = await client.removeCustomModel({ connectionId });
      if (!result.success) throw new Error(errorText(result.error));
      await customModels.refresh(machine);
    } catch (error) { report(errorText(error)); }
    finally { setBusy(null); }
  };
  return <>
    {MODEL_GROUPS.map(({ id: group, testId, addId, title, add }) => {
      const renderPlan = (connection: CustomModelConnection) => <SettingsRow
        key={connection.id} data-custom-connection={connection.id} title={connection.name}
        description={!connection.keySaved ? translate('customModels.keyMissing') : undefined}
        control={<div className="flex items-center gap-1">
          <Button className="gg-model-icon-button" size="icon" variant="ghost" aria-label={translate('customModels.edit')} onClick={() => setEditing(connection)}><Pencil className="size-4" /></Button>
          <Button className="gg-model-icon-button" size="icon" variant="ghost" aria-label={translate('customModels.remove')} disabled={busy === connection.id} onClick={() => void removeConnection(connection)}><Trash2 className="size-4" /></Button>
        </div>}
      />;
      return <SettingsGroup key={group} data-testid={testId} title={<span className="gg-model-card-heading">
      {translate(title)}
      <span className="flex items-center gap-2">
        {group === 'coding-plan' && <Button size="icon" variant="ghost" className="gg-model-icon-button" aria-label={translate('subscriptions.refresh')} title={translate('subscriptions.refresh')}
          data-testid="coding-plan-refresh" disabled={refreshing} onClick={() => void refreshPlans()}>{refreshing ? <LoadingIndicator size="inline" /> : <RefreshCw className="size-4" />}</Button>}
        <Button size="icon" variant="ghost" className="gg-model-icon-button" aria-label={translate(add)} title={translate(add)}
          onClick={() => setEditing({ group: group === 'coding-plan' ? group : 'api' })} data-testid={addId}>
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </span>
    </span>} footer={feedback?.group === group ? <SettingsNote role="status">{feedback.text}</SettingsNote> : undefined}>
      {group === 'coding-plan' && accountAgents.sort((a, b) => Number(a.id === 'claude') - Number(b.id === 'claude')).map(agent => (
        <SubscriptionConnections key={agent.id} agent={agent} machine={machine} modelRows />
      ))}
      {group === 'coding-plan' && planAgents.map(agent => <DetectedCodingPlan key={agent.id} agent={agent} machine={machine} />)}
      {group === 'custom' && providedModels}
      {reading.state === 'error' ? (group === 'custom' ? <SettingsRow description={errorText(reading.error)} control={<Button onClick={refresh}>{translate('common.retry')}</Button>} /> : null)
        : reading.state === 'unknown' ? <SettingsRow control={<Unknown className="w-32" />} /> : <>
          {group === 'custom' && <RefreshFailed reading={reading} />}
          {group === 'coding-plan' ? providerPresets.filter(preset => preset.group === group).map(preset => {
            const connections = reading.value.filter(connection => connection.preset === preset.id && !conflicts.has(customModelApiUrl(connection)));
            if (!connections.length) return null;
            const icon = modelProviderIcon({ id: preset.id, name: preset.name, iconKey: preset.icon });
            return <CodingPlanGroup key={preset.id} id={preset.id} name={vendorName(preset.name)} icon={icon}>
              {connections.map(renderPlan)}
            </CodingPlanGroup>;
          }) : connectionGroups.filter(([, connections]) => connections.length > 1 || groupOf(connections[0]!) === group).map(([apiUrl, connections]) => {
            const actions = (connection: CustomModelConnection) => ({
              busy: busy === connection.id,
              onEdit: () => editModel(connection, ""),
              onEditModel: (modelId: string) => editModel(connection, modelId),
              onTest: () => void testConnection(connection),
              onToggleModel: (modelId: string, enabled: boolean) => void setModelEnabled(connection, modelId, enabled),
              onRemove: () => void removeConnection(connection),
            });
            if (connections.length === 1) {
              const connection = connections[0]!;
              return <ModelConnectionGroup key={connection.id} connection={connection} showAddress={reading.value.some(other => other.id !== connection.id && endpointHost(other) === endpointHost(connection))} {...actions(connection)} />;
            }
            return <AddressConflict key={apiUrl} apiUrl={apiUrl} connections={connections} busy={busy !== null} onKeepKey={connection => void keepKey(connection)} />;
          })}
        </>}
    </SettingsGroup>;
    })}
    {editing && <CustomModelDialog
      key={'group' in editing ? editing.account ?? editing.group : editing.id}
      machine={machine}
      group={'group' in editing ? editing.group : (providerPresets.find(preset => preset.id === editing.preset)?.group ?? 'custom')}
      initialAccount={'group' in editing ? editing.account : undefined}
      connection={'group' in editing ? undefined : editing}
      modelId={'group' in editing ? undefined : editingModel}
      onClose={() => { setEditing(null); onAddClose?.(); }}
    />}
  </>;
});

const DetectedCodingPlan = observer(function DetectedCodingPlan({ agent, machine }: { agent: AgentPayload; machine: string | null }) {
  const { translate } = useSessionMessages();
  const plan = valueOf(useSubscriptionPlan(machine, agent.id));
  if (plan?.payer !== 'subscription') return null;
  return <CodingPlanGroup id={agent.id} name={agent.name} icon={<AppIcon id={agent.id} asset={agent.icon} size={20} />}>
    <SettingsRow title={planLabel(plan, translate) ?? translate('subscriptions.payer.subscription')} />
  </CodingPlanGroup>;
});

type ConnectionActions = {
  busy: boolean;
  onEdit: () => void;
  onTest: () => void;
  onEditModel: (modelId: string) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onRemove: () => void;
};

function ModelConnectionGroup({ connection, showAddress, busy, onEdit, onTest, onEditModel, onToggleModel, onRemove }: { connection: CustomModelConnection; showAddress: boolean } & ConnectionActions) {
  const { translate } = useSessionMessages();
  const preset = providerPresets.find(({ id }) => id === connection.preset);
  const icon = preset ? modelProviderIcon({ id: preset.id, name: preset.name, iconKey: preset.icon }) : null;
  const name = preset ? vendorName(preset.name) : connection.name || endpointHost(connection) || customModelApiUrl(connection);
  const [expanded, setExpanded] = useState(false);
  const entries = [...connection.models, ...(connection.disabledModels ?? [])];
  const count = entries.length;
  const manageLabel = translate(!connection.keySaved ? 'customModels.enterKeyHere' : count ? 'customModels.manageConnectionModels' : 'customModels.selectModel');
  const details = [
    showAddress ? customModelApiUrl(connection) : null,
    count === 0 ? translate('customModels.noModel') : null,
    !connection.keySaved ? translate('customModels.keyMissing') : null,
  ].filter(Boolean).join(' · ');
  return <div data-custom-connection={connection.id}>
    <ModelProviderRow icon={icon ?? <Globe aria-hidden="true" />} name={name} description={details || undefined}
      manageLabel={manageLabel} onManage={() => !connection.keySaved ? onEditModel(connection.models[0]?.id ?? "") : count ? setExpanded(value => !value) : onEdit()} endAction={<><Button className="gg-model-icon-button" size="icon" variant="ghost"
        aria-label={translate('customModels.test')} disabled={busy} onClick={onTest}><Link className="size-4" /></Button>
        <Button className="gg-model-icon-button" size="icon" variant="ghost"
        aria-label={translate('customModels.remove')} disabled={busy} onClick={onRemove}><Trash2 className="size-4" /></Button></>} />
    {expanded && <div className="gg-connection-model-list">
      {entries.map(model => <SettingsRow key={model.id} title={model.label || model.id}
        control={<div className="flex items-center gap-2">
          {connection.models.some(entry => entry.id === model.id) && <Button className="gg-model-icon-button" size="icon" variant="ghost" aria-label={translate('customModels.editModel', { model: model.label || model.id })}
            onClick={() => onEditModel(model.id)}><Pencil className="size-4" /></Button>}
          <Toggle checked={connection.models.some(entry => entry.id === model.id)}
            ariaLabel={translate('customModels.enableModel', { model: model.label || model.id })} onChange={enabled => { if (!busy) onToggleModel(model.id, enabled); }} />
        </div>} />)}
      <SettingsRow control={<Button size="sm" variant="outline" onClick={onEdit}>{translate('customModels.add')}</Button>} />
    </div>}
  </div>;
}

export function ModelProviderRow({ icon, name, description, manageLabel, onManage, endAction, manageTestId }: {
  icon: ReactNode; name: ReactNode; description?: string; manageLabel: string; onManage: () => void; endAction?: ReactNode; manageTestId?: string;
}) {
  return <SettingsRow className="gg-model-connection-header" leading={icon} stack title={name} description={description}
    control={<div className="flex items-center gap-1">
      <Button className="gg-model-icon-button" size="icon" variant="ghost" aria-label={manageLabel} title={manageLabel}
        data-testid={manageTestId} onClick={onManage}>
        <Settings2 aria-hidden="true" className="size-4" />
      </Button>
      {endAction ?? <span className="gg-model-icon-button" aria-hidden="true" />}
    </div>} />;
}

function groupByApiUrl(connections: readonly CustomModelConnection[]) {
  const groups = new Map<string, CustomModelConnection[]>();
  for (const connection of connections) {
    const url = customModelApiUrl(connection);
    const group = groups.get(url) ?? [];
    group.push(connection);
    groups.set(url, group);
  }
  return Array.from(groups);
}

function AddressConflict({ apiUrl, connections, busy, onKeepKey }: {
  apiUrl: string;
  connections: readonly CustomModelConnection[];
  busy: boolean;
  onKeepKey: (connection: CustomModelConnection) => void;
}) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return <>
    <SettingsRow title={apiUrl} description={translate('customModels.urlConflict')}
      control={<Button size="sm" variant="outline" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(!open)}>{translate('customModels.chooseKey')}</Button>} />
    <Collapse id={panelId} open={open} onOpenChange={setOpen} className="pl-6">
      {connections.map((connection, index) => <SettingsRow key={connection.id} data-custom-connection={connection.id}
        title={(connection.keyLast4 ?? connection.discovered?.keyLast4) ? `••••${connection.keyLast4 ?? connection.discovered?.keyLast4}` : translate('customModels.numberedConnection', { count: index + 1 })}
        description={connection.models.map(model => model.label || model.id).join(', ') || translate('customModels.noModel')}
        control={<Button size="sm" variant="outline" disabled={busy || !connection.keySaved}
          onClick={() => onKeepKey(connection)}>{translate('customModels.keepKey')}</Button>} />)}
    </Collapse>
  </>;
}

function endpointHost(connection: CustomModelConnection): string | undefined {
  try { return new URL(customModelApiUrl(connection)).host; }
  catch { return undefined; }
}
