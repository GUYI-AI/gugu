import { useState } from 'react';
import { normalizeModelBaseUrl, modelProtocolSchema, type CustomModelConnection, type CustomModelEntry, type CustomModelMeta } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Dialog, DialogContent, DialogContentArea, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@renderer/lib/ui/select';
import {
  Combobox, ComboboxTrigger, ComboboxContent, ComboboxInput, ComboboxList, ComboboxGroup, ComboboxLabel,
  ComboboxCollection, ComboboxItem, ComboboxEmpty,
} from '@renderer/lib/ui/combobox';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { openExternalLinkInBrowser } from '@renderer/lib/open-external-link';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { ConnectionModelPicker } from '@renderer/features/settings/subscriptions/ConnectionModelPicker';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { SubscriptionConnections } from '@renderer/features/settings/subscriptions/SubscriptionConnections';
import { Unknown } from '@/components/ui/Unknown';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { ChevronDownIcon } from '@/lib/icons';
import { SettingsNote, Toggle } from './SettingsPrimitives';

export function CustomModelDialog({ machine, connection, group = 'custom', onClose }: { machine: string | null; connection?: CustomModelConnection; group?: 'coding-plan' | 'api' | 'custom'; onClose: () => void }) {
  const { translate } = useSessionMessages();
  const initialPreset = providerPresets.find(preset => preset.group === group);
  const [presetId, setPresetId] = useState(connection?.preset ?? (connection ? 'custom' : group === 'coding-plan' ? 'claude-subscription' : initialPreset?.id ?? 'custom'));
  const preset = providerPresets.find(({ id }) => id === presetId);
  const accountProvider = presetId === 'claude-subscription' ? 'claude' : presetId === 'chatgpt-subscription' ? 'codex' : null;
  const { data: agents, error: agentsError, refetch: refetchAgents } = useAgents();
  const accountAgent = agents?.find(agent => agent.id === accountProvider);
  const labelOf = (id: string) => id === 'claude-subscription' ? translate('customModels.claudeAccount') : id === 'chatgpt-subscription' ? translate('customModels.codexAccount') : providerPresets.find(item => item.id === id)?.name ?? translate('customModels.custom');
  const providerLabel = (id: string) => <span className="flex items-center gap-2">{id === 'claude-subscription' || id === 'chatgpt-subscription' ? <AppIcon id={id === 'claude-subscription' ? 'claude' : 'codex'} size={16} /> : null}{labelOf(id)}</span>;
  const [endpoints, setEndpoints] = useState<CustomModelMeta['endpoints']>(connection?.endpoints ?? initialPreset?.endpoints ?? [{ protocol: 'openai-chat-completions', baseUrl: '' }]);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(connection?.models.map(({ id }) => id) ?? []);
  const [advanced, setAdvanced] = useState(false);
  const [features, setFeatures] = useState<Omit<CustomModelEntry, 'id' | 'label'>>((() => { const model = connection?.models[0]; return { image: model?.image, thinking: model?.thinking, contextWindow: model?.contextWindow, maxOutput: model?.maxOutput }; }));
  const [featuresChanged, setFeaturesChanged] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [accountCreating, setAccountCreating] = useState(false);
  const [failure, setFailure] = useState('');
  const [testResult, setTestResult] = useState('');
  let normalized: CustomModelMeta['endpoints'] | null = null;
  let addressProblem = '';
  try { normalized = endpoints.map((endpoint) => ({ ...endpoint, baseUrl: normalizeModelBaseUrl(endpoint.baseUrl) })); }
  catch (error) { addressProblem = errorText(error); }
  const source = normalized && (apiKey ? { apiKey, endpoints: normalized }
    : connection?.keySaved ? { connectionId: connection.id, endpoints: normalized } : null);
  const updateEndpoint = (index: number, patch: Partial<CustomModelMeta['endpoints'][number]>) => {
    setEndpoints((current) => current.map((endpoint, i) => i === index ? { ...endpoint, ...patch } : endpoint));
    setTestResult('');
  };
  const feature = (patch: Partial<typeof features>) => { setFeatures((current) => ({ ...current, ...patch })); setFeaturesChanged(true); };
  const test = async () => {
    if (!source) return;
    setBusy('test'); setFailure(''); setTestResult('');
    try {
      const result = await (await getAgentConfigRuntimeClient(machine)).testCustomModel({ ...source, modelId: models[0] });
      if (!result.success) throw new Error(errorText(result.error));
      if (result.data.kind === 'listed') setTestResult(translate('customModels.connected', { count: result.data.models.length }));
      else if (result.data.kind === 'connected') setTestResult(translate('customModels.connectedNoList'));
      else if (result.data.reason === 'no-list') setTestResult(translate('customModels.noList'));
      else setFailure(translate(result.data.reason === 'unauthorized' ? 'customModels.refused' : 'customModels.unreachable'));
    } catch (error) { setFailure(errorText(error)); }
    finally { setBusy(null); }
  };
  const save = async () => {
    setFailure('');
    if (!normalized) { setFailure(addressProblem); return; }
    if (!models.length) { setFailure(translate('subscriptions.connections.modelsRequired')); return; }
    setBusy('save');
    try {
      const result = await (await getAgentConfigRuntimeClient(machine)).saveCustomModel({
        ...(connection ? { id: connection.id } : {}),
        name: connection?.name || preset?.name || new URL(normalized[0]!.baseUrl).host,
        preset: preset?.id ?? null, endpoints: normalized,
        ...(apiKey ? { apiKey } : {}),
        models: models.map((id) => {
          const existing = connection?.models.find((model) => model.id === id);
          return featuresChanged ? { ...existing, ...features, id } : existing ?? { ...features, id };
        }),
      });
      if (!result.success) throw new Error(errorText(result.error));
      await customModels.refresh(machine);
      onClose();
    } catch (error) { setFailure(errorText(error)); }
    finally { setBusy(null); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !accountCreating) onClose(); }}>
    <DialogContent className="gg-model-dialog sm:max-w-[640px]" data-testid="custom-model-dialog">
      <DialogHeader><DialogTitle>{translate(connection ? 'customModels.edit' : group === 'coding-plan' ? 'customModels.addPlan' : group === 'api' ? 'customModels.addApi' : 'customModels.add')}</DialogTitle></DialogHeader>
      <DialogContentArea>
        <div className="subscription-connection-form">
          {group !== 'custom' && <label className="flex flex-col gap-2">
            <span className="flex items-center justify-between">{translate(group === 'coding-plan' ? 'customModels.plan' : 'customModels.platform')}{(preset || accountProvider) && <Button type="button" size="sm" variant="link" className="gg-model-provider-link" onClick={() => openExternalLinkInBrowser(accountProvider === 'claude' ? 'https://claude.ai/upgrade' : accountProvider === 'codex' ? 'https://chatgpt.com/pricing' : preset!.docsUrl)}>{translate(accountProvider ? 'customModels.purchasePlan' : 'customModels.docs')} ↗</Button>}</span>
            <Combobox
              value={presetId}
              disabled={accountCreating || !!busy}
              items={group === 'coding-plan' ? [{ label: null, items: ['claude-subscription', 'chatgpt-subscription', ...providerPresets.filter(item => item.group === group).map(item => item.id)] }] : [
                { label: null, items: providerPresets.filter(item => item.group === 'api').map(item => item.id) },
              ]}
              itemToStringLabel={labelOf}
              onValueChange={(id) => {
                if (!id) return;
                setPresetId(id); setTestResult('');
                const next = providerPresets.find((item) => item.id === id);
                if (id !== 'claude-subscription' && id !== 'chatgpt-subscription') setEndpoints(next?.endpoints ?? [{ protocol: 'openai-chat-completions', baseUrl: '' }]);
              }}
            >
              <ComboboxTrigger
                data-testid="custom-model-provider"
                aria-label={translate(group === 'coding-plan' ? 'customModels.plan' : 'customModels.platform')}
                className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left"
              >
                {providerLabel(presetId)}
                <ChevronDownIcon aria-hidden="true" className="pointer-events-none size-4 text-foreground-muted" />
              </ComboboxTrigger>
              <ComboboxContent className="min-w-(--anchor-width)">
                <ComboboxInput showTrigger={false} placeholder={translate('customModels.searchProviders')} />
                <ComboboxList>
                  {(group: { label: string | null; items: string[] }) => <ComboboxGroup key={group.label ?? 'custom'} items={group.items}>
                    {group.label && <ComboboxLabel>{group.label}</ComboboxLabel>}
                    <ComboboxCollection>
                      {(id: string) => <ComboboxItem key={id} value={id}>{providerLabel(id)}</ComboboxItem>}
                    </ComboboxCollection>
                  </ComboboxGroup>}
                </ComboboxList>
                <ComboboxEmpty>{translate('customModels.noProviders')}</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
          </label>}
          {accountProvider ? accountAgent ? <SubscriptionConnections key={accountProvider} agent={accountAgent} machine={machine} modelAccount={{ onClose, onBusyChange: setAccountCreating }} /> : agentsError ? <SettingsNote tone="danger" role="alert">{errorText(agentsError)} <Button size="sm" variant="outline" onClick={() => { void refetchAgents(); }}>{translate('common.retry')}</Button></SettingsNote> : agents ? <SettingsNote tone="danger">{translate('customModels.accountUnavailable')}</SettingsNote> : <Unknown className="h-9 w-full" /> : <form className="subscription-connection-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {preset ? <p className="subscription-connection-description">{preset.endpoints.map(({ protocol }) => translate(`customModels.${protocol}`)).join(' / ')}</p>
            : endpoints.map((endpoint, index) => <div key={index} className="flex flex-col gap-2">
              <label>{translate('customModels.address')}<Input data-testid={`custom-model-address-${index}`} type="url" required value={endpoint.baseUrl} onChange={(event) => updateEndpoint(index, { baseUrl: event.target.value })} /></label>
              <label>{translate('customModels.protocol')}<Select value={endpoint.protocol} onValueChange={(value) => { if (value) updateEndpoint(index, { protocol: value }); }}>
                <SelectTrigger data-testid={`custom-model-protocol-${index}`}><SelectValue>{translate(`customModels.${endpoint.protocol}`)}</SelectValue></SelectTrigger>
                <SelectContent>{modelProtocolSchema.options.map((protocol) => <SelectItem key={protocol} value={protocol}>{translate(`customModels.${protocol}`)}</SelectItem>)}</SelectContent>
              </Select></label>
              {normalized?.[index] ? <p className="subscription-connection-description">{translate('customModels.savedAs', { address: normalized[index]!.baseUrl })}</p> : null}
            </div>)}
          <label>API Key<span className="flex items-center gap-2"><Input data-testid="custom-model-key" type="password" required={!connection?.keySaved} autoComplete="off" spellCheck={false} value={apiKey} placeholder={connection?.keySaved ? translate('customModels.keySaved') : undefined} onChange={(event) => { setApiKey(event.target.value); setTestResult(''); }} /><Button type="button" size="sm" variant="outline" disabled={!source || !!busy} onClick={() => { void test(); }}>{translate(busy === 'test' ? 'customModels.testing' : 'customModels.test')}</Button></span></label>
          {testResult && <p className="subscription-connection-description" role="status">{testResult}</p>}
          <ConnectionModelPicker machine={machine} source={source} value={models} onChange={setModels} />
          <Button type="button" size="sm" variant="ghost" className="justify-start" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? '⌄' : '›'} {translate('customModels.advanced')}</Button>
          {advanced && <div className="flex flex-col gap-3">
            <label className="flex items-center justify-between">{translate('customModels.image')}<Toggle checked={features.image === true} onChange={(image) => feature({ image })} ariaLabel={translate('customModels.image')} /></label>
            <label className="flex items-center justify-between">{translate('customModels.thinking')}<Toggle checked={features.thinking === true} onChange={(thinking) => feature({ thinking })} ariaLabel={translate('customModels.thinking')} /></label>
            {(['contextWindow', 'maxOutput'] as const).map((key) => <label key={key}>{translate(key === 'contextWindow' ? 'customModels.context' : 'customModels.output')}<Input type="number" min="1" step="1" placeholder={translate('customModels.default')} value={features[key] ?? ''} onChange={(event) => feature({ [key]: event.target.value ? Number(event.target.value) : undefined })} /></label>)}
            {!preset && endpoints.length < 4 && <Button type="button" size="sm" variant="outline" onClick={() => {
              const protocol = modelProtocolSchema.options.find((item) => !endpoints.some((endpoint) => endpoint.protocol === item));
              if (protocol) setEndpoints([...endpoints, { protocol, baseUrl: '' }]);
            }}>{translate('customModels.anotherProtocol')}</Button>}
          </div>}
          {failure && <p className="subscription-error" role="alert">{failure}</p>}
          <div className="flex items-center justify-between gap-4"><p className="subscription-connection-description">{translate('subscriptions.connections.private')}</p><div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={onClose}>{translate('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={!!busy} data-testid="custom-model-save">{translate(busy === 'save' ? 'subscriptions.connections.saving' : 'common.save')}</Button>
          </div></div>
        </form>}
        </div>
      </DialogContentArea>
    </DialogContent>
  </Dialog>;
}
