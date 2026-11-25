import { useRef, useState } from 'react';
import { CUSTOM_MODEL_KEY_CHANNEL, customModelAcceptsImages, customModelRouteSchema, modelProtocolSchema, normalizeModelBaseUrl, type CustomModelConnection, type CustomModelEffortResult, type CustomModelEntry, type CustomModelMeta, type CustomModelRoute, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { vendorName } from '@/i18n/vendorName';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { Dialog, DialogContent, DialogContentArea, DialogDescription, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
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
import { customModelEffortCatalog, customModels } from '@renderer/features/sessions/session-config/custom-models';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { retryOf, useReplica, valueOf } from '@/lib/replica';
import { SubscriptionConnections } from '@renderer/features/settings/subscriptions/SubscriptionConnections';
import { Unknown } from '@/components/ui/Unknown';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { ChevronDownIcon, Eye, EyeOff } from '@/lib/icons';
import { IconButton } from '@/components/ui/IconButton';
import { SettingsNote, Toggle } from './SettingsPrimitives';

export function CustomModelDialog({ machine, connection, group = providerPresets.find(preset => preset.id === connection?.preset)?.group ?? 'custom',
  initialAccount, initialRoute, onClose }: {
  machine: string | null; connection?: CustomModelConnection; group?: 'coding-plan' | 'api' | 'custom';
  initialAccount?: 'claude' | 'codex'; initialRoute?: Omit<CustomModelRoute, 'id'>; onClose: () => void;
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
  const keyInput = useRef<HTMLInputElement>(null);
  // A key this computer holds is read into the field only when the eye is pressed, and only in its own window; the key
  // of a connection on another device never leaves it. The field still holding that key is not a new key.
  const [heldKey, setHeldKey] = useState('');
  const [keyShown, setKeyShown] = useState(false);
  const keyReadable = machine === null && !!window.electronAPI;
  const typedKey = apiKey !== heldKey ? apiKey : '';
  // null = the person has not chosen: every model the address lists is selected.
  const [picked, setPicked] = useState<string[] | null>(connection ? connection.models.map(({ id }) => id) : null);
  const [advanced, setAdvanced] = useState(Boolean(initialRoute && (initialRoute.baseUrl ||
    !connection?.endpoints.some(endpoint => endpoint.protocol === initialRoute.outgoing))));
  const [modelListRefresh, setModelListRefresh] = useState(0);
  const [catalogChoices, setCatalogChoices] = useState<Map<string, string | undefined>>(new Map());
  const [features, setFeatures] = useState<Pick<CustomModelEntry, 'image' | 'contextWindow' | 'maxOutput'>>(() => {
    const model = connection?.models[0];
    return { image: model?.image, contextWindow: model?.contextWindow, maxOutput: model?.maxOutput };
  });
  const [featuresChanged, setFeaturesChanged] = useState(false);
  const [routes, setRoutes] = useState<CustomModelRoute[]>(() => {
    const existing = connection?.routes ?? [];
    return initialRoute && existing.length < 100 ? [{ ...initialRoute, id: crypto.randomUUID() }, ...existing] : existing;
  });
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
  const list = useConnectionModelList(machine, source, modelListRefresh);
  const probed = address ? (list.kind === 'listed' || list.kind === 'unlisted' ? list.endpoints ?? [] : []) : normalized ?? [];
  const routeEndpoints = probed.length ? probed : normalized ?? [];
  const routeAddressPlaceholder = (outgoing: ModelProtocol) => {
    const endpoint = routeEndpoints.find(({ protocol }) => protocol === outgoing);
    return endpoint?.baseUrl === normalized?.[0]?.baseUrl ? translate('customModels.sameApiAddress') : endpoint?.baseUrl;
  };
  const protocolLabel = (protocol: ModelProtocol) => translate(`customModels.${protocol}`);
  const updateRoute = (id: string, patch: Partial<CustomModelRoute>) => setRoutes(current =>
    current.map(route => route.id === id ? { ...route, ...patch } : route));
  const models = picked ?? (list.kind === 'listed' ? list.models : []);
  const catalogChoice = (id: string) => catalogChoices.has(id) ? catalogChoices.get(id) : connection?.models.find(model => model.id === id)?.modelsDevId;
  const catalogIds = [...new Set(models.slice(0, 200).flatMap(id => {
    const choice = catalogChoice(id);
    return choice ? [id, choice] : [id];
  }))];
  const catalogRead = useReplica(customModelEffortCatalog, !accountProvider && catalogIds.length ? [machine, catalogIds] : null);
  const catalogFacts = catalogRead.state === 'unknown' ? undefined : new Map(valueOf(catalogRead)?.map(({ id, result }) => [id, result] as const));
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
      const savedRoutes = routes.map((route) => customModelRouteSchema.parse({
        ...route,
        baseUrl: route.baseUrl?.trim() || undefined,
      }));
      if (savedRoutes.some(({ outgoing, baseUrl }) => !baseUrl && !saved.some(endpoint => endpoint.protocol === outgoing))) {
        throw new Error(translate('customModels.routeAddressRequired'));
      }
      const result = await client.saveCustomModel({
        ...(connection ? { id: connection.id } : {}),
        name: connection?.name || preset?.name || new URL(saved[0]!.baseUrl).host,
        preset: preset?.id ?? null, endpoints: saved,
        routes: savedRoutes,
        harnessProtocols: connection?.harnessProtocols,
        ...(typedKey ? { apiKey: typedKey } : {}),
        models: models.map((id) => {
          const existing = connection?.models.find((model) => model.id === id);
          return { ...existing, ...(!existing || featuresChanged ? features : {}), id, modelsDevId: catalogChoice(id) };
        }),
      });
      if (!result.success) throw new Error(errorText(result.error));
      await customModels.refresh(machine);
      onClose();
    } catch (error) { setFailure(errorText(error)); }
    finally { setBusy(null); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !accountCreating) onClose(); }}>
    <DialogContent className="gg-model-dialog sm:max-w-[640px]" data-testid="custom-model-dialog"
      initialFocus={connection && !connection.keySaved ? keyInput : undefined}>
      <DialogHeader>
        <DialogTitle>{translate(connection ? 'customModels.edit' : group === 'coding-plan' ? 'customModels.addPlan' : group === 'api' ? 'customModels.addApi' : 'customModels.add')}</DialogTitle>
        {group === 'custom' && <DialogDescription>{translate('customModels.formDescription')}</DialogDescription>}
      </DialogHeader>
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
                setPresetId(id); setPicked(null); setRoutes([]);
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
          <label>API Key<span className="relative flex items-center"><Input ref={keyInput} data-testid="custom-model-key" type={keyShown ? 'text' : 'password'} className={keyReadable ? 'pr-9' : undefined} required={!connection?.keySaved} autoComplete="off" spellCheck={false} value={apiKey} aria-invalid={keyProblem ? true : undefined} placeholder={connection?.keySaved ? `••••••••${connection.discovered?.keyLast4 ?? ''}` : undefined} onChange={(event) => setApiKey(event.target.value)} />
            {keyReadable && (apiKey || connection?.keySaved) && <IconButton size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" aria-label={translate(keyShown ? 'customModels.hideKey' : 'customModels.showKey')} aria-pressed={keyShown} onClick={() => { void toggleKey(); }}>{keyShown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}</IconButton>}</span></label>
          {keyProblem && <p className="subscription-error" role="alert" data-testid="custom-model-key-problem">{keyProblem}</p>}
          <ConnectionModelPicker list={list} value={models} onChange={(next) => {
            setPicked(next);
            setRoutes(current => current.filter(({ modelId }) => !modelId || next.includes(modelId)));
          }} />
          {!preset && <Button type="button" size="sm" variant="outline" className="self-start" data-testid="custom-model-read-list"
            disabled={!source || list.kind === 'reading' || !!busy} onClick={() => setModelListRefresh(current => current + 1)}>
            {translate('customModels.readModels')}
          </Button>}
          {catalogFacts && models.slice(0, 200).map(id => <CustomModelEffortStatus key={id} id={id} machine={machine}
            direct={catalogFacts.get(id)} choice={catalogChoice(id)} resolved={catalogFacts.get(catalogChoice(id) ?? '')}
            onChoice={choice => setCatalogChoices(current => new Map(current).set(id, choice))} />)}
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2">{translate('customModels.routing')}</legend>
            {routes.map((route, index) => (
              <div key={route.id} className={`grid items-end gap-2 ${advanced
                ? 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)_auto]'
                : 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_auto]'}`}>
                <label>{translate('customModels.incoming')}
                  <Select value={route.incoming} onValueChange={(value) => { if (value) updateRoute(route.id, { incoming: value }); }}>
                    <SelectTrigger data-testid={`custom-model-route-incoming-${index}`}><SelectValue>{route.incoming === 'any' ? translate('customModels.anyProtocol') : protocolLabel(route.incoming)}</SelectValue></SelectTrigger>
                    <SelectContent><SelectItem value="any">{translate('customModels.anyProtocol')}</SelectItem>
                      {modelProtocolSchema.options.map(protocol => <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <span className="self-end pb-2 text-foreground-muted" aria-hidden="true">→</span>
                <label>{translate('customModels.outgoing')}
                  <Select value={route.outgoing} onValueChange={(value) => { if (value) updateRoute(route.id, { outgoing: value }); }}>
                    <SelectTrigger data-testid={`custom-model-route-outgoing-${index}`}><SelectValue>{protocolLabel(route.outgoing)}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {modelProtocolSchema.options.map(protocol => <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label>{translate('customModels.applicableModel')}
                  <Select value={route.modelId ?? ''} onValueChange={(value) => updateRoute(route.id, { modelId: value || undefined })}>
                    <SelectTrigger data-testid={`custom-model-route-model-${index}`}><SelectValue>{route.modelId ?? translate('customModels.allModels')}</SelectValue></SelectTrigger>
                    <SelectContent><SelectItem value="">{translate('customModels.allModels')}</SelectItem>
                      {models.map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                {advanced && <label>{translate('customModels.routeAddressColumn')}
                  <Input type="url" aria-label={translate('customModels.routeAddress', { index: index + 1 })}
                    data-testid={`custom-model-route-address-${index}`} value={route.baseUrl ?? ''}
                    placeholder={routeAddressPlaceholder(route.outgoing)}
                    onChange={(event) => updateRoute(route.id, { baseUrl: event.target.value })} />
                </label>}
                <IconButton size="sm" aria-label={translate('customModels.removeRoute', { index: index + 1 })}
                  onClick={() => setRoutes(current => current.filter(({ id }) => id !== route.id))}>×</IconButton>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" className="self-start" disabled={routes.length >= 100}
              onClick={() => setRoutes(current => [{
                id: crypto.randomUUID(), incoming: 'any', outgoing: routeEndpoints[0]?.protocol ?? 'openai-chat-completions',
              }, ...current])}>{translate('customModels.addRoute')}</Button>
          </fieldset>
          <Button type="button" size="sm" variant="ghost" className="justify-start" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? '⌄' : '›'} {translate('customModels.advanced')}</Button>
          {advanced && <div className="flex flex-col gap-3">
            {probed.length > 0 && <p data-testid="custom-model-protocols">{translate('customModels.protocols', { protocols: probed.map(({ protocol }) => translate(`customModels.${protocol}`)).join(' / ') })}</p>}
            <label className="gg-custom-model-feature"><span>{translate('customModels.image')}</span><Toggle checked={customModelAcceptsImages(features)} onChange={(image) => feature({ image })} ariaLabel={translate('customModels.image')} /></label>
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

function CustomModelEffortStatus({ id, machine, direct, choice, resolved, onChoice }: {
  id: string; machine: string | null; direct?: CustomModelEffortResult; choice?: string;
  resolved?: CustomModelEffortResult; onChoice: (id?: string) => void;
}) {
  const { translate } = useSessionMessages();
  const [entry, setEntry] = useState('');
  const [requested, setRequested] = useState('');
  const wanted = entry.trim();
  const checking = requested !== '' && requested === wanted;
  const reading = useReplica(customModelEffortCatalog, checking ? [machine, [requested]] : null);
  const checkResult = checking && reading.state !== 'unknown' ? valueOf(reading)?.find(item => item.id === wanted)?.result ?? { kind: 'unavailable' as const } : undefined;
  if (direct?.kind === 'found') return null;
  const result = resolved ?? direct;
  if (result?.kind === 'found') return <div className="flex items-center justify-between gap-2 text-sm">
    <span className="min-w-0 break-words">{id} → {result.catalogId}</span>
    <Button type="button" variant="ghost" size="sm" onClick={() => onChoice()}>{translate('customModels.clearCatalogMatch')}</Button>
  </div>;
  const choices = direct?.kind === 'ambiguous' ? direct.candidates : [];
  const status = result?.kind === 'not-found' ? 'customModels.catalogMissing' : result?.kind === 'ambiguous' ? 'customModels.catalogChoose' : 'customModels.catalogUnavailable';
  return <div className="flex min-w-0 flex-col gap-1 text-sm" data-testid="custom-model-effort-status">
    <p className="break-words"><span className="font-medium">{id}</span> <span className="text-foreground-muted">{translate(status)}</span></p>
    {choices.length > 0 && <div className="flex flex-wrap gap-1">
      {choices.map(({ catalogId }) => <Button key={catalogId} type="button" size="sm" variant="outline" onClick={() => onChoice(catalogId)}>{catalogId}</Button>)}
    </div>}
    {direct && direct.kind !== 'unavailable' && <div className="flex items-center gap-2">
      <Input aria-label={translate('customModels.catalogId')} placeholder="provider/model" value={entry} maxLength={200} onChange={event => setEntry(event.target.value)} />
      {checkResult?.kind === 'found'
        ? <Button type="button" size="sm" variant="outline" onClick={() => { onChoice(checkResult.catalogId); setEntry(''); }}>{translate('customModels.useCatalogMatch', { id: checkResult.catalogId })}</Button>
        : <Button type="button" size="sm" variant="outline" disabled={!wanted.includes('/') || checking && reading.state === 'unknown'} onClick={() => {
          if (checking) void customModelEffortCatalog.refresh(machine, [wanted]);
          else setRequested(wanted);
        }}>{translate('customModels.lookupCatalogId')}</Button>}
    </div>}
    {checkResult && checkResult.kind !== 'found' && <p className="text-foreground-muted">{translate(checkResult.kind === 'unavailable' ? 'customModels.catalogUnavailable' : 'customModels.catalogMissing')}</p>}
    {choice && <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => onChoice()}>{translate('customModels.clearCatalogMatch')}</Button>}
  </div>;
}
