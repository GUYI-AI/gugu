import { useState } from 'react';
import { CUSTOM_MODEL_KEY_CHANNEL, customModelAcceptsImages, customModelThinks, matchCustomModel, normalizeModelBaseUrl, type CustomModelConnection, type CustomModelEntry, type CustomModelMeta, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { vendorName } from '@/i18n/vendorName';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
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
import { SettingsNote, Toggle } from './SettingsPrimitives';

export function CustomModelDialog({ machine, connection, group = 'custom', initialAccount, onClose }: {
  machine: string | null; connection?: CustomModelConnection; group?: 'coding-plan' | 'api' | 'custom';
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
  const labelOf = (id: string) => id === 'claude-subscription' ? translate('customModels.claudeAccount') : id === 'chatgpt-subscription' ? translate('customModels.codexAccount') : (name => name ? vendorName(name) : translate('customModels.custom'))(providerPresets.find(item => item.id === id)?.name);
  const providerLabel = (id: string) => <span className="flex items-center gap-2">{id === 'claude-subscription' || id === 'chatgpt-subscription' ? <AppIcon id={id === 'claude-subscription' ? 'claude' : 'codex'} size={16} /> : null}{labelOf(id)}</span>;
  const [endpoints, setEndpoints] = useState<CustomModelMeta['endpoints']>(connection?.endpoints ?? initialPreset?.endpoints ?? [{ protocol: 'openai-chat-completions', baseUrl: '' }]);
  const [apiKey, setApiKey] = useState('');
  // A key this computer holds is read into the field only when the eye is pressed, and only in its own window; the key
  // of a connection on another device never leaves it. The field still holding that key is not a new key.
  const [heldKey, setHeldKey] = useState('');
  const [keyShown, setKeyShown] = useState(false);
  const keyReadable = machine === null && !!window.electronAPI;
  const typedKey = apiKey !== heldKey ? apiKey : '';
  // null = the person has not chosen: every model the address lists is selected.
  const [picked, setPicked] = useState<string[] | null>(connection ? connection.models.map(({ id }) => id) : null);
  const [advanced, setAdvanced] = useState(false);
  const [features, setFeatures] = useState<Omit<CustomModelEntry, 'id' | 'label'>>((() => { const model = connection?.models[0]; return { image: model?.image, thinking: model?.thinking, contextWindow: model?.contextWindow, maxOutput: model?.maxOutput }; }));
  const [featuresChanged, setFeaturesChanged] = useState(false);
  const [harnessProtocols, setHarnessProtocols] = useState<Record<string, ModelProtocol>>(connection?.harnessProtocols ?? {});
  const [busy, setBusy] = useState<'save' | null>(null);
  const [accountCreating, setAccountCreating] = useState(false);
  const [failure, setFailure] = useState('');
  let normalized: CustomModelMeta['endpoints'] | null = null;
  let addressProblem = '';
  try { normalized = endpoints.map((endpoint) => ({ ...endpoint, baseUrl: normalizeModelBaseUrl(endpoint.baseUrl) })); }
  catch (error) { addressProblem = errorText(error); }
  // A custom address, whether its key is typed here or held by the connection: the host recognizes which protocols it
  // speaks while it reads the models, and saving keeps what it found.
  const address = !preset && normalized?.[0] ? normalized[0].baseUrl : null;
  const keySource = typedKey ? { apiKey: typedKey } : connection?.keySaved ? { connectionId: connection.id } : null;
  const source: ConnectionModelSource | null = !keySource || !normalized ? null : address ? { ...keySource, baseUrl: address } : { ...keySource, endpoints: normalized };
  const list = useConnectionModelList(machine, source);
  const probed = address ? (list.kind === 'listed' || list.kind === 'unlisted' ? list.endpoints ?? [] : []) : normalized ?? [];
  // Only a harness that could use more than one of these protocols has a choice to make.
  const protocolChoices = (agents ?? []).flatMap((agent) => {
    const direct = agent.capabilities.modelProtocols ?? [];
    const convertFrom = agent.capabilities.customModel?.convertFrom ?? [];
    const usable = probed.map(({ protocol }) => protocol).filter((protocol) => direct.includes(protocol) || convertFrom.includes(protocol));
    if (usable.length < 2) return [];
    const auto = matchCustomModel({ nativeProtocol: direct[0], protocols: direct, convertFrom, connection: { endpoints: probed, keySaved: true } }).endpoint?.protocol;
    const label = (protocol: ModelProtocol | undefined) => !protocol ? '' : direct.includes(protocol) ? translate(`customModels.${protocol}`) : translate('customModels.converted', { protocol: translate(`customModels.${protocol}`) });
    return [{ agent, usable, label, autoLabel: translate('customModels.protocolAuto', { protocol: label(auto) }) }];
  });
  const models = picked ?? (list.kind === 'listed' ? list.models : []);
  const keyProblem = list.kind !== 'unlisted' || list.reason === 'no-list' ? ''
    : connection?.keySaved && !typedKey && list.reason === 'unauthorized' ? translate('customModels.heldKeyRefused')
      : translate(connectionProbeMessageKey(list.reason));
  const toggleKey = async () => {
    if (!keyShown && !apiKey && connection?.keySaved) {
      try {
        const key = await window.electronAPI!.invoke(CUSTOM_MODEL_KEY_CHANNEL, connection.id) as string;
        setHeldKey(key); setApiKey(key);
      } catch (error) { setFailure(errorText(error)); return; }
    }
    setKeyShown(!keyShown);
  };
  const setAddress = (baseUrl: string) => {
    setEndpoints((current) => current.map((endpoint, i) => i === 0 ? { ...endpoint, baseUrl } : endpoint));
  };
  const feature = (patch: Partial<typeof features>) => { setFeatures((current) => ({ ...current, ...patch })); setFeaturesChanged(true); };
  const save = async () => {
    setFailure('');
    if (!normalized) { setFailure(addressProblem); return; }
    if (!models.length) { setFailure(translate('subscriptions.connections.modelsRequired')); return; }
    setBusy('save');
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      let saved = normalized;
      if (address && keySource) {
        // What the background check found; an address with no model list is checked again with the model named here.
        saved = list.kind === 'listed' || list.kind === 'unlisted' ? list.endpoints ?? [] : [];
        if (!saved.length) {
          const probe = await client.detectCustomModelProtocols({ ...keySource, baseUrl: address, modelId: models[0] });
          if (!probe.success) throw new Error(errorText(probe.error));
          saved = probe.data.endpoints;
          if (!saved.length) {
            const reading = probeModelList(probe.data);
            throw new Error(translate(connectionProbeMessageKey(reading.kind === 'unlisted' ? reading.reason : 'unreachable')));
          }
        }
      }
      const result = await client.saveCustomModel({
        ...(connection ? { id: connection.id } : {}),
        name: connection?.name || preset?.name || new URL(saved[0]!.baseUrl).host,
        preset: preset?.id ?? null, endpoints: saved,
        harnessProtocols: Object.fromEntries(Object.entries(harnessProtocols).filter(([, protocol]) => saved.some((endpoint) => endpoint.protocol === protocol))),
        ...(typedKey ? { apiKey: typedKey } : {}),
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
                setPresetId(id); setPicked(null);
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
          {!preset && <label>{translate('customModels.address')}<Input data-testid="custom-model-address-0" type="url" required value={endpoints[0]?.baseUrl ?? ''} onChange={(event) => setAddress(event.target.value)} /></label>}
          <label>API Key<span className="relative flex items-center"><Input data-testid="custom-model-key" type={keyShown ? 'text' : 'password'} className={keyReadable ? 'pr-9' : undefined} required={!connection?.keySaved} autoComplete="off" spellCheck={false} value={apiKey} aria-invalid={keyProblem ? true : undefined} placeholder={connection?.keySaved ? `••••••••${connection.discovered?.keyLast4 ?? ''}` : undefined} onChange={(event) => setApiKey(event.target.value)} />
            {keyReadable && (apiKey || connection?.keySaved) && <IconButton size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" aria-label={translate(keyShown ? 'customModels.hideKey' : 'customModels.showKey')} aria-pressed={keyShown} onClick={() => { void toggleKey(); }}>{keyShown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}</IconButton>}</span></label>
          {keyProblem && <p className="subscription-error" role="alert" data-testid="custom-model-key-problem">{keyProblem}</p>}
          <ConnectionModelPicker list={list} value={models} onChange={setPicked} />
          <Button type="button" size="sm" variant="ghost" className="justify-start" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? '⌄' : '›'} {translate('customModels.advanced')}</Button>
          {advanced && <div className="flex flex-col gap-3">
            {probed.length > 0 && <p data-testid="custom-model-protocols">{translate('customModels.protocols', { protocols: probed.map(({ protocol }) => translate(`customModels.${protocol}`)).join(' / ') })}</p>}
            {protocolChoices.map(({ agent, usable, label, autoLabel }) => <label key={agent.id} className="flex items-center justify-between">{agent.name}
              <Select value={(harnessProtocols[agent.id] as string | undefined) ?? 'auto'} onValueChange={(value) => setHarnessProtocols((current) => Object.fromEntries([...Object.entries(current).filter(([harness]) => harness !== agent.id), ...(value && value !== 'auto' ? [[agent.id, value as ModelProtocol] as const] : [])]))}>
                <SelectTrigger data-testid={`custom-model-protocol-${agent.id}`}><SelectValue>{harnessProtocols[agent.id] ? label(harnessProtocols[agent.id]) : autoLabel}</SelectValue></SelectTrigger>
                <SelectContent align="end"><SelectItem value="auto">{autoLabel}</SelectItem>
                  {usable.map((protocol) => <SelectItem key={protocol} value={protocol}>{label(protocol)}</SelectItem>)}
                </SelectContent>
              </Select></label>)}
            <label className="flex items-center justify-between">{translate('customModels.image')}<Toggle checked={customModelAcceptsImages(features)} onChange={(image) => feature({ image })} ariaLabel={translate('customModels.image')} /></label>
            <label className="flex items-center justify-between">{translate('customModels.thinking')}<Toggle checked={customModelThinks(features)} onChange={(thinking) => feature({ thinking })} ariaLabel={translate('customModels.thinking')} /></label>
            {(['contextWindow', 'maxOutput'] as const).map((key) => <label key={key}>{translate(key === 'contextWindow' ? 'customModels.context' : 'customModels.output')}<Input type="number" min="1" step="1" placeholder={translate('customModels.default')} value={features[key] ?? ''} onChange={(event) => feature({ [key]: event.target.value ? Number(event.target.value) : undefined })} /></label>)}
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
