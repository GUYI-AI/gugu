import { useState } from 'react';
import { CUSTOM_MODEL_KEY_CHANNEL, customModelApiUrl, normalizeModelBaseUrl, type CustomModelConnection, type CustomModelEntry, type CustomModelMeta } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { vendorName } from '@/i18n/vendorName';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Dialog, DialogContent, DialogContentArea, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import {
  Combobox, ComboboxTrigger, ComboboxContent, ComboboxInput, ComboboxList, ComboboxGroup,
  ComboboxCollection, ComboboxItem, ComboboxEmpty,
} from '@renderer/lib/ui/combobox';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { openExternalLinkInBrowser } from '@renderer/lib/open-external-link';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { ConnectionModelPicker, useConnectionModelList, probeModelList, type ConnectionModelSource } from '@renderer/features/settings/subscriptions/ConnectionModelPicker';
import { connectionProbeMessageKey } from '@renderer/features/settings/subscriptions/connection-probe-messages';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { retryOf, valueOf } from '@/lib/replica';
import { SubscriptionConnections } from '@renderer/features/settings/subscriptions/SubscriptionConnections';
import { Unknown } from '@/components/ui/Unknown';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { ChevronDownIcon, Eye, EyeOff } from '@/lib/icons';
import { IconButton } from '@/components/ui/IconButton';
import { SettingsNote } from './SettingsPrimitives';
import { CustomModelCatalog } from './CustomModelCatalog';

export function CustomModelDialog({ machine, connection, availableConnections = [], group = 'custom', initialAccount, onClose }: {
  machine: string | null; connection?: CustomModelConnection; group?: 'coding-plan' | 'api' | 'custom';
  availableConnections?: readonly CustomModelConnection[];
  initialAccount?: 'claude' | 'codex'; onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const initialPreset = providerPresets.find(preset => preset.group === group);
  const accountPreset = initialAccount === 'codex' ? 'chatgpt-subscription' : 'claude-subscription';
  const [presetId, setPresetId] = useState(connection?.preset ?? (connection ? 'custom' : group === 'coding-plan' ? accountPreset : initialPreset?.id ?? 'custom'));
  const preset = providerPresets.find(({ id }) => id === presetId);
  const accountProvider = presetId === 'claude-subscription' ? 'claude' : presetId === 'chatgpt-subscription' ? 'codex' : null;
  const agentsReading = useAgents();
  const agents = valueOf(agentsReading);
  const agentsError = agentsReading.state === 'error' ? agentsReading.error : null;
  const accountAgent = agents?.find(agent => agent.id === accountProvider);
  const labelOf = (id: string) => id === 'claude-subscription' ? translate('customModels.claudeAccount') : id === 'chatgpt-subscription' ? translate('customModels.codexAccount') : (name => name ? vendorName(name) : translate('customModels.thirdParty'))(providerPresets.find(item => item.id === id)?.name);
  const providerLabel = (id: string) => <span className="flex items-center gap-2">{id === 'claude-subscription' || id === 'chatgpt-subscription' ? <AppIcon id={id === 'claude-subscription' ? 'claude' : 'codex'} size={16} /> : null}{labelOf(id)}</span>;
  const [endpoints, setEndpoints] = useState<CustomModelMeta['endpoints']>(connection?.endpoints ?? initialPreset?.endpoints ?? [{ protocol: 'openai-chat-completions', baseUrl: '' }]);
  const [address, setAddressInput] = useState(connection ? customModelApiUrl(connection) : '');
  const [apiKey, setApiKey] = useState('');
  // A key this computer holds is read into the field only when the eye is pressed, and only in its own window; the key
  // of a connection on another device never leaves it. The field still holding that key is not a new key.
  const [heldKey, setHeldKey] = useState('');
  const [keyShown, setKeyShown] = useState(false);
  const keyReadable = machine === null && !!window.electronAPI;
  const typedKey = apiKey !== heldKey ? apiKey : '';
  const [picked, setPicked] = useState<string[] | null>(null);
  const [modelEdits, setModelEdits] = useState<Record<string, CustomModelEntry>>({});
  const [busy, setBusy] = useState<'save' | null>(null);
  const [accountCreating, setAccountCreating] = useState(false);
  const [failure, setFailure] = useState('');
  let normalized: CustomModelMeta['endpoints'] | null = null;
  let addressProblem = '';
  let apiUrl: string | undefined;
  try {
    apiUrl = preset ? customModelApiUrl({ endpoints }) : normalizeModelBaseUrl(address);
    normalized = endpoints.map((endpoint, index) => ({ ...endpoint, baseUrl: !preset && index === 0 && (!connection || apiUrl !== customModelApiUrl(connection)) ? apiUrl! : normalizeModelBaseUrl(endpoint.baseUrl) }));
  }
  catch (error) { addressProblem = errorText(error); }
  const matching = !connection && apiUrl ? availableConnections.filter(item => customModelApiUrl(item) === apiUrl) : [];
  const reusable = matching.length === 1 ? matching[0] : undefined;
  const held = connection ?? reusable;
  const keyForProbe = reusable?.keySaved ? '' : typedKey;
  const hasConflict = matching.length > 1;
  // A typed address with a new key: the host recognizes which protocols it speaks while it reads the models.
  const typedAddress = !preset && keyForProbe && apiUrl ? apiUrl : null;
  const source: ConnectionModelSource | null = typedAddress ? { apiKey: keyForProbe, baseUrl: typedAddress }
    : normalized && keyForProbe ? { apiKey: keyForProbe, endpoints: normalized }
      : normalized && held?.keySaved ? { connectionId: held.id, endpoints: reusable?.endpoints ?? normalized } : null;
  const list = useConnectionModelList(machine, source);
  const models = picked ?? held?.models.map(({ id }) => id) ?? (group === 'coding-plan' && list.kind === 'listed' ? list.models : []);
  const entries = new Map([...(held?.disabledModels ?? []), ...(held?.models ?? []), ...Object.values(modelEdits)].map(entry => [entry.id, entry]));
  const enabled = new Set(models);
  const manualModels = list.kind === 'failed' || (list.kind === 'unlisted' && list.reason === 'no-list');
  const canSaveModels = models.length > 0 || Boolean(held?.id && picked && group !== 'coding-plan');
  const keyProblem = list.kind !== 'unlisted' || list.reason === 'no-list' ? ''
    : connection?.keySaved && !typedKey && list.reason === 'unauthorized' ? translate('customModels.heldKeyRefused')
      : translate(connectionProbeMessageKey(list.reason));
  const testSavedModel = async (modelId: string) => {
    if (!connection) return '';
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      const result = await client.testCustomModel({ connectionId: connection.id, modelId });
      if (!result.success) throw new Error(errorText(result.error));
      if (result.data.kind === 'listed') return translate('customModels.connected', { count: result.data.models.length });
      if (result.data.kind === 'connected') return translate('customModels.connectedNoList');
      return translate(connectionProbeMessageKey(result.data.reason));
    } catch (error) { return errorText(error); }
  };
  const toggleKey = async () => {
    if (!keyShown && !apiKey && connection?.keySaved) {
      try {
        const key = await window.electronAPI!.invoke(CUSTOM_MODEL_KEY_CHANNEL, connection.id) as string;
        setHeldKey(key); setApiKey(key);
      } catch (error) { setFailure(errorText(error)); return; }
    }
    setKeyShown(!keyShown);
  };
  const resetNewModelSelection = () => {
    if (!connection && group !== 'coding-plan') {
      setPicked(null);
      setModelEdits({});
    }
  };
  const setAddress = (baseUrl: string) => {
    resetNewModelSelection();
    setAddressInput(baseUrl);
  };
  const save = async () => {
    setFailure('');
    if (!normalized) { setFailure(addressProblem); return; }
    if (!canSaveModels) { setFailure(translate('subscriptions.connections.modelsRequired')); return; }
    setBusy('save');
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      let saved = reusable?.endpoints ?? normalized;
      if (typedAddress) {
        // What the background check found; an address with no model list is checked again with the model named here.
        saved = list.kind === 'listed' || list.kind === 'unlisted' ? list.endpoints ?? [] : [];
        if (!saved.length) {
          const probe = await client.detectCustomModelProtocols({ apiKey: typedKey, baseUrl: typedAddress, modelId: models[0] });
          if (!probe.success) throw new Error(errorText(probe.error));
          saved = probe.data.endpoints;
          if (!saved.length) {
            const reading = probeModelList(probe.data);
            throw new Error(translate(connectionProbeMessageKey(reading.kind === 'unlisted' ? reading.reason : 'unreachable')));
          }
        }
      }
      const result = await client.saveCustomModel({
        ...(held ? { id: held.id } : {}),
        name: held?.name || preset?.name || new URL(saved[0]!.baseUrl).host,
        preset: held ? held.preset : preset?.id ?? null, endpoints: saved, apiUrl,
        ...(keyForProbe ? { apiKey: keyForProbe } : {}),
        models: models.map(id => entries.get(id) ?? { id }),
        disabledModels: [...entries.values()].filter(({ id }) => !enabled.has(id)),
      });
      if (!result.success) throw new Error(errorText(result.error));
      await customModels.refresh(machine);
      onClose();
    } catch (error) { setFailure(errorText(error)); }
    finally { setBusy(null); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !accountCreating) onClose(); }}>
    <DialogContent className="gg-model-dialog sm:max-w-[640px]" data-testid="custom-model-dialog">
      <DialogHeader><DialogTitle>{translate(connection ? 'customModels.edit' : group === 'coding-plan' ? 'customModels.addPlan' : 'customModels.add')}</DialogTitle></DialogHeader>
      <DialogContentArea>
        <div className="subscription-connection-form">
          {!connection && group !== 'custom' && <label className="flex flex-col gap-2">
            <span className="flex items-center justify-between">{translate(group === 'coding-plan' ? 'customModels.plan' : 'customModels.platform')}{(preset || accountProvider) && <Button type="button" size="sm" variant="link" className="gg-model-provider-link" onClick={() => openExternalLinkInBrowser(accountProvider === 'claude' ? 'https://claude.ai/upgrade' : accountProvider === 'codex' ? 'https://chatgpt.com/pricing' : preset!.docsUrl)}>{translate(accountProvider ? 'customModels.purchasePlan' : 'customModels.docs')} ↗</Button>}</span>
            <Combobox
              value={presetId}
              disabled={accountCreating || !!busy}
              items={group === 'coding-plan' ? [{ label: null, items: ['claude-subscription', 'chatgpt-subscription', ...providerPresets.filter(item => item.group === group).map(item => item.id)] }] : [
                { label: null, items: [...providerPresets.filter(item => item.group === 'api').map(item => item.id), 'custom'] },
              ]}
              itemToStringLabel={labelOf}
              onValueChange={(id) => {
                if (!id || id === presetId) return;
                setPresetId(id);
                setPicked(null);
                setModelEdits({});
                setApiKey('');
                setHeldKey('');
                setKeyShown(false);
                setFailure('');
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
                  {(group: { label: string | null; items: string[] }) => <ComboboxGroup key={group.label ?? 'custom'} items={group.items} label={group.label}>
                    <ComboboxCollection>
                      {(id: string) => <ComboboxItem key={id} value={id}>{providerLabel(id)}</ComboboxItem>}
                    </ComboboxCollection>
                  </ComboboxGroup>}
                </ComboboxList>
                <ComboboxEmpty>{translate('customModels.noProviders')}</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
          </label>}
          {accountProvider ? accountAgent ? <SubscriptionConnections key={accountProvider} agent={accountAgent} machine={machine} modelAccount={{ onClose, onBusyChange: setAccountCreating }} /> : agentsError ? <SettingsNote tone="danger" role="alert">{errorText(agentsError)} <Button size="sm" variant="outline" onClick={retryOf(agentsReading)}>{translate('common.retry')}</Button></SettingsNote> : agents ? <SettingsNote tone="danger">{translate('customModels.accountUnavailable')}</SettingsNote> : <Unknown className="h-9 w-full" /> : <form className="subscription-connection-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {!preset && <label>{translate('customModels.address')}<Input data-testid="custom-model-address-0" type="url" required value={address} onChange={(event) => setAddress(event.target.value)} /></label>}
          {hasConflict ? <SettingsNote tone="danger" role="alert">{translate('customModels.urlConflict')}</SettingsNote> : reusable?.keySaved ? <SettingsNote>{translate('customModels.reuseKey')}</SettingsNote> : <label>API Key<span className="relative flex items-center"><Input data-testid="custom-model-key" type={keyShown ? 'text' : 'password'} className={keyReadable ? 'pr-9' : undefined} required={!connection?.keySaved} autoComplete="off" spellCheck={false} value={apiKey} aria-invalid={keyProblem ? true : undefined} placeholder={connection?.keySaved ? `••••••••${connection.discovered?.keyLast4 ?? ''}` : undefined} onChange={(event) => { resetNewModelSelection(); setApiKey(event.target.value); }} />
            {keyReadable && (apiKey || connection?.keySaved) && <IconButton size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" aria-label={translate(keyShown ? 'customModels.hideKey' : 'customModels.showKey')} aria-pressed={keyShown} onClick={() => { void toggleKey(); }}>{keyShown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}</IconButton>}</span></label>}
          {keyProblem && <p className="subscription-error" role="alert" data-testid="custom-model-key-problem">{keyProblem}</p>}
          {manualModels && <ConnectionModelPicker list={list} value={models} onChange={setPicked} />}
          {(!manualModels || entries.size > 0 || models.length > 0) &&
            <CustomModelCatalog key={apiUrl} list={list} enabled={models} entries={entries} onChange={setPicked}
              onTest={connection?.keySaved && !typedKey && apiUrl === customModelApiUrl(connection) ? testSavedModel : undefined}
              onEdit={(id, patch) => setModelEdits(current => ({ ...current, [id]: { ...entries.get(id), ...current[id], ...patch, id } }))} />}
          {failure && <p className="subscription-error" role="alert">{failure}</p>}
          <div className="flex items-center justify-between gap-4"><p className="subscription-connection-description">{translate('subscriptions.connections.private')}</p><div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={onClose}>{translate('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={!!busy || hasConflict || !canSaveModels || !!keyProblem || list.kind === 'reading'} data-testid="custom-model-save">{translate(busy === 'save' ? 'subscriptions.connections.saving' : 'common.save')}</Button>
          </div></div>
        </form>}
        </div>
      </DialogContentArea>
    </DialogContent>
  </Dialog>;
}
