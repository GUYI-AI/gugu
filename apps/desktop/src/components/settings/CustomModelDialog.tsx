import { useEffect, useRef, useState } from 'react';
import {
  CUSTOM_MODEL_EFFORT_LEVELS, CUSTOM_MODEL_KEY_CHANNEL, FAST_PROTOCOLS, customModelAcceptsImages, customModelCatalogLevels, customModelRouteSchema,
  customModelThinks, modelProtocolSchema, normalizeModelBaseUrl, proposedDefaultEffort,
  type CustomModelConnection, type CustomModelEffortLevel, type CustomModelEntry, type CustomModelMeta, type CustomModelRoute, type ModelProtocol,
} from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { vendorName } from '@/i18n/vendorName';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
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
import { useConnectionModelList, probeModelList, type ConnectionModelSource } from '@renderer/features/settings/subscriptions/ConnectionModelPicker';
import { connectionProbeMessageKey } from '@renderer/features/settings/subscriptions/connection-probe-messages';
import { customModelEffortCatalog, customModels } from '@renderer/features/sessions/session-config/custom-models';
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { retryOf, useReplica, valueOf } from '@/lib/replica';
import { SubscriptionConnections } from '@renderer/features/settings/subscriptions/SubscriptionConnections';
import { Unknown } from '@/components/ui/Unknown';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { Check, ChevronDownIcon, Eye, EyeOff, Sparkles, X } from '@/lib/icons';
import { IconButton } from '@/components/ui/IconButton';
import { SettingsNote } from './SettingsPrimitives';
import './ModelSettings.css';

/** What the dialog's advanced configuration holds; `customProtocol` shows the connection's protocol routes. */
type Advanced = Required<Pick<CustomModelEntry, 'toolCall' | 'image' | 'thinking' | 'thinkingOnly' | 'thinkingOptional' | 'fast'>> & {
  customProtocol: boolean;
  efforts: CustomModelEffortLevel[];
  /** null = Automatic: the request carries no level. */
  defaultEffort: CustomModelEffortLevel | null;
};

/** Choosing another provider puts the advanced configuration back to this. */
const advancedReset = (): Advanced => ({
  toolCall: true, image: false, thinking: false, thinkingOnly: false, thinkingOptional: false, fast: false,
  customProtocol: false, efforts: [], defaultEffort: null,
});
/** Turning thinking on starts it from this. */
const THINKING_ON = { thinkingOnly: false, thinkingOptional: true, defaultEffort: null } satisfies Partial<Advanced>;

function advancedOf(entry: CustomModelEntry | undefined, routes: readonly CustomModelRoute[]): Advanced {
  if (!entry) return { ...advancedReset(), thinking: true, ...THINKING_ON, efforts: [], customProtocol: routes.length > 0 };
  const efforts = entry.efforts ?? customModelCatalogLevels(entry.effortCatalog);
  return {
    toolCall: entry.toolCall ?? true,
    image: customModelAcceptsImages(entry),
    thinking: customModelThinks(entry),
    thinkingOnly: entry.thinkingOnly ?? false,
    thinkingOptional: entry.thinkingOptional ?? true,
    fast: entry.fast ?? false,
    customProtocol: routes.length > 0,
    efforts: [...efforts],
    defaultEffort: entry.efforts ? entry.defaultEffort ?? null : proposedDefaultEffort(efforts) ?? null,
  };
}

const INPUT_LIMITS = [['32K', 32_768], ['64K', 65_536], ['128K', 131_072], ['256K', 262_144]] as const;
const OUTPUT_LIMITS = [['8K', 8_192], ['16K', 16_384], ['32K', 32_768], ['64K', 65_536]] as const;
const CUSTOM_PROVIDER = 'custom';

type ConnectionTest = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'failed'; message: string };

export function CustomModelDialog({ machine, connection, modelId, group = providerPresets.find(preset => preset.id === connection?.preset)?.group ?? 'custom',
  initialAccount, initialRoute, onClose }: {
  machine: string | null; connection?: CustomModelConnection; group?: 'coding-plan' | 'api' | 'custom';
  /** The model of `connection` this dialog edits; its other models are kept as they are. */
  modelId?: string;
  initialAccount?: 'claude' | 'codex'; initialRoute?: Omit<CustomModelRoute, 'id'>; onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const initialPreset = group === 'custom' ? undefined : providerPresets.find(preset => preset.group === group);
  const accountPreset = initialAccount === 'codex' ? 'chatgpt-subscription' : 'claude-subscription';
  const [presetId, setPresetId] = useState(connection ? connection.preset ?? CUSTOM_PROVIDER : group === 'coding-plan' ? accountPreset : initialPreset?.id ?? CUSTOM_PROVIDER);
  const preset = providerPresets.find(({ id }) => id === presetId);
  const accountProvider = presetId === 'claude-subscription' ? 'claude' : presetId === 'chatgpt-subscription' ? 'codex' : null;
  const agentsReading = useAgents();
  const agents = valueOf(agentsReading);
  const agentsError = agentsReading.state === 'error' ? agentsReading.error : null;
  const accountAgent = agents?.find(agent => agent.id === accountProvider);
  const providerIds = group === 'coding-plan'
    ? ['claude-subscription', 'chatgpt-subscription', ...providerPresets.filter(item => item.group === group).map(item => item.id)]
    : [...providerPresets.filter(item => item.group === 'api').map(item => item.id), CUSTOM_PROVIDER];
  const labelOf = (id: string) => id === 'claude-subscription' ? translate('customModels.claudeAccount') : id === 'chatgpt-subscription' ? translate('customModels.codexAccount') : (name => name ? vendorName(name) : translate('customModels.custom'))(providerPresets.find(item => item.id === id)?.name);
  const iconOf = (id: string) => {
    if (id === 'claude-subscription' || id === 'chatgpt-subscription') return <AppIcon id={id === 'claude-subscription' ? 'claude' : 'codex'} size={16} />;
    const item = providerPresets.find(entry => entry.id === id);
    if (!item) return <Sparkles aria-hidden className="size-4 shrink-0" />;
    const icon = modelProviderIcon({ id: item.id, name: item.name, iconKey: item.icon });
    return icon && <span className="gg-model-provider-icon" aria-hidden="true">{icon}</span>;
  };
  const providerLabel = (id: string) => <span className="gg-model-provider-option">{iconOf(id)}<span>{labelOf(id)}</span></span>;
  const editedModel = connection?.models.find(({ id }) => id === modelId) ?? connection?.models[0];
  const [endpoints, setEndpoints] = useState<CustomModelMeta['endpoints']>(connection?.endpoints ?? initialPreset?.endpoints ?? [{ protocol: 'openai-chat-completions', baseUrl: '' }]);
  const [apiKey, setApiKey] = useState('');
  const keyInput = useRef<HTMLInputElement>(null);
  // A key this computer holds is read into the field only when the eye is pressed, and only in its own window; the key
  // of a connection on another device never leaves it. The field still holding that key is not a new key.
  const [heldKey, setHeldKey] = useState('');
  const [keyShown, setKeyShown] = useState(false);
  const keyReadable = machine === null && !!window.electronAPI;
  // A typed key can always be shown; a saved one only where this device can read it back.
  const keyRevealable = !!apiKey || !connection?.keySaved || keyReadable;
  const typedKey = apiKey !== heldKey ? apiKey : '';
  const [modelName, setModelName] = useState(editedModel?.id ?? '');
  const [routes, setRoutes] = useState<CustomModelRoute[]>(() => {
    const existing = connection?.routes ?? [];
    return initialRoute && existing.length < 100 ? [{ ...initialRoute, id: crypto.randomUUID() }, ...existing] : existing;
  });
  const [advanced, setAdvanced] = useState<Advanced>(() => advancedOf(editedModel, routes));
  const [limits, setLimits] = useState({ contextWindow: editedModel?.contextWindow, maxOutput: editedModel?.maxOutput });
  const [test, setTest] = useState<ConnectionTest>({ kind: 'idle' });
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
  // What the background read found wrong with the key or address, until the person's own test replaces it. A preset has no
  // address field, so an address reason is said as what is known rather than "check this address" (B7-F03).
  const keyProblem = list.kind !== 'unlisted' || list.reason === 'no-list' ? ''
    : connection?.keySaved && !typedKey && list.reason === 'unauthorized' ? translate('customModels.heldKeyRefused')
      : translate(connectionProbeMessageKey(list.reason, Boolean(preset)));
  const probed = address ? (list.kind === 'listed' || list.kind === 'unlisted' ? list.endpoints ?? [] : []) : normalized ?? [];
  const routeEndpoints = probed.length ? probed : normalized ?? [];
  // The address column appears for a route that has its own upstream address or needs one: its outgoing protocol is not
  // one the main address answers.
  const routeAddresses = routes.some(({ baseUrl, outgoing }) => baseUrl || (routeEndpoints.length > 0 && !routeEndpoints.some(({ protocol }) => protocol === outgoing)));
  const routeAddressPlaceholder = (outgoing: ModelProtocol) => {
    const endpoint = routeEndpoints.find(({ protocol }) => protocol === outgoing);
    return endpoint?.baseUrl === normalized?.[0]?.baseUrl ? translate('customModels.sameApiAddress') : endpoint?.baseUrl;
  };
  const protocolLabel = (protocol: ModelProtocol) => translate(`customModels.${protocol}`);
  const effortLabel = (level: CustomModelEffortLevel | null) => translate(level ? `customModels.effort.${level}` : 'customModels.effortAuto');
  const updateRoute = (id: string, patch: Partial<CustomModelRoute>) => setRoutes(current =>
    current.map(route => route.id === id ? { ...route, ...patch } : route));
  const addRoute = () => setRoutes(current => [{
    id: crypto.randomUUID(), incoming: 'any', outgoing: routeEndpoints[0]?.protocol ?? 'openai-chat-completions',
  }, ...current]);
  const model = modelName.trim();

  // The levels models.dev knows for the named model are checked for the person, once per name, until they check their own.
  const [lookupId, setLookupId] = useState(model);
  useEffect(() => {
    const timer = setTimeout(() => setLookupId(model), 400);
    return () => clearTimeout(timer);
  }, [model]);
  const catalogRead = useReplica(customModelEffortCatalog, !accountProvider && lookupId ? [machine, [lookupId]] : null);
  const catalogResult = catalogRead.state === 'unknown' ? undefined : valueOf(catalogRead)?.find(({ id }) => id === lookupId)?.result;
  const effortsChosen = useRef(false);
  const prefilledFor = useRef<string | null>(editedModel?.id ?? null);
  useEffect(() => {
    if (!catalogResult || prefilledFor.current === lookupId) return;
    prefilledFor.current = lookupId;
    if (effortsChosen.current) return;
    const efforts = customModelCatalogLevels(catalogResult);
    setAdvanced(current => current.thinking ? { ...current, efforts, defaultEffort: proposedDefaultEffort(efforts) ?? null } : current);
  }, [catalogResult, lookupId]);

  // Fast is a request field of the OpenAI protocols: unavailable once the address is known to speak neither.
  const fastCarried = (known: CustomModelMeta['endpoints']) => known.some(({ protocol }) => FAST_PROTOCOLS.includes(protocol));
  const fastSupported = !routeEndpoints.length || fastCarried(routeEndpoints);
  const check = (key: 'toolCall' | 'image' | 'thinkingOnly' | 'thinkingOptional' | 'fast', checked: boolean) =>
    setAdvanced(current => ({ ...current, [key]: checked }));
  const checkThinking = (thinking: boolean) => setAdvanced(current => thinking ? { ...current, thinking, ...THINKING_ON, efforts: [] } : { ...current, thinking });
  const checkCustomProtocol = (customProtocol: boolean) => {
    if (customProtocol && !routes.length) addRoute();
    setAdvanced(current => ({ ...current, customProtocol }));
  };
  // Checking a level proposes the default again; unchecking the default, or every level, proposes it by the same rule.
  const checkEffort = (level: CustomModelEffortLevel, checked: boolean) => {
    effortsChosen.current = true;
    setAdvanced(current => {
      const efforts = CUSTOM_MODEL_EFFORT_LEVELS.filter(item => item === level ? checked : current.efforts.includes(item));
      const repick = checked || current.defaultEffort === level || !efforts.length;
      return { ...current, efforts, defaultEffort: repick ? proposedDefaultEffort(efforts) ?? null : current.defaultEffort };
    });
  };

  const toggleKey = async () => {
    if (!keyShown && !apiKey && connection?.keySaved && keyReadable) {
      try {
        const key = await window.electronAPI!.invoke(CUSTOM_MODEL_KEY_CHANNEL, connection.id) as string;
        setHeldKey(key); setApiKey(key);
      } catch (error) { setFailure(errorText(error)); return; }
    }
    setKeyShown(!keyShown);
  };
  const setAddress = (baseUrl: string) => {
    setTest({ kind: 'idle' });
    setEndpoints((current) => current.map((endpoint, i) => i === 0 ? { ...endpoint, baseUrl } : endpoint));
  };
  const testConnection = async () => {
    if (!normalized) { setTest({ kind: 'failed', message: addressProblem }); return; }
    if (!keySource) return;
    setTest({ kind: 'testing' });
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      const named = model ? { modelId: model } : {};
      if (address) {
        const probe = await client.detectCustomModelProtocols({ ...keySource, baseUrl: address, ...named });
        if (!probe.success) throw new Error(errorText(probe.error));
        const reading = probeModelList(probe.data);
        setTest(probe.data.models.length || probe.data.endpoints.length ? { kind: 'ok' }
          : { kind: 'failed', message: translate(connectionProbeMessageKey(reading.kind === 'unlisted' ? reading.reason : 'unreachable', Boolean(preset))) });
        return;
      }
      const result = await client.testCustomModel({ ...keySource, endpoints: normalized, ...named });
      if (!result.success) throw new Error(errorText(result.error));
      setTest(result.data.kind !== 'unlisted' ? { kind: 'ok' } : {
        kind: 'failed',
        message: translate(!typedKey && result.data.reason === 'unauthorized' ? 'customModels.heldKeyRefused' : connectionProbeMessageKey(result.data.reason, Boolean(preset))),
      });
    } catch (error) { setTest({ kind: 'failed', message: errorText(error) }); }
  };
  const chooseProvider = (id: string) => {
    setPresetId(id); setRoutes([]); setTest({ kind: 'idle' });
    setAdvanced(advancedReset());
    effortsChosen.current = false;
    const next = providerPresets.find((item) => item.id === id);
    if (id !== 'claude-subscription' && id !== 'chatgpt-subscription') setEndpoints(next?.endpoints ?? [{ protocol: 'openai-chat-completions', baseUrl: '' }]);
  };
  const save = async () => {
    setFailure('');
    if (!normalized) { setFailure(addressProblem); return; }
    if (!model) { setFailure(translate('subscriptions.connections.modelsRequired')); return; }
    setBusy('save');
    try {
      const client = await getAgentConfigRuntimeClient(machine);
      let saved = normalized;
      if (address && keySource) {
        // What the background check found; an address with no model list is checked again with the model named here.
        saved = list.kind === 'listed' || list.kind === 'unlisted' ? list.endpoints ?? [] : [];
        if (!saved.length) {
          const probe = await client.detectCustomModelProtocols({ ...keySource, baseUrl: address, modelId: model });
          if (!probe.success) throw new Error(errorText(probe.error));
          saved = probe.data.endpoints;
          if (!saved.length) {
            const reading = probeModelList(probe.data);
            throw new Error(translate(connectionProbeMessageKey(reading.kind === 'unlisted' ? reading.reason : 'unreachable', Boolean(preset))));
          }
        }
      }
      // Unchecking the custom protocol only hides the routes; saving while it is unchecked removes them (asked above).
      const savedRoutes = (advanced.customProtocol ? routes : []).map((route) => customModelRouteSchema.parse({
        ...route,
        baseUrl: route.baseUrl?.trim() || undefined,
        modelId: route.modelId === editedModel?.id ? model : route.modelId,
      }));
      if (savedRoutes.some(({ outgoing, baseUrl }) => !baseUrl && !saved.some(endpoint => endpoint.protocol === outgoing))) {
        throw new Error(translate('customModels.routeAddressRequired'));
      }
      const { customProtocol: _shown, efforts, defaultEffort, ...declared } = advanced;
      declared.fast = declared.fast && fastCarried(saved);
      const stored = ({ effortCatalog: _catalog, ...rest }: CustomModelEntry) => rest;
      const entry = {
        ...(editedModel && stored(editedModel)), ...declared, id: model,
        efforts: advanced.thinking ? efforts : undefined,
        defaultEffort: advanced.thinking ? defaultEffort ?? undefined : undefined,
        contextWindow: limits.contextWindow, maxOutput: limits.maxOutput,
      };
      // The edited model keeps its place; the connection's other models are saved as they are.
      const models = (connection?.models ?? []).flatMap(item => item.id === editedModel?.id ? [entry] : item.id === model ? [] : [stored(item)]);
      const result = await client.saveCustomModel({
        ...(connection ? { id: connection.id } : {}),
        name: connection?.name || preset?.name || new URL(saved[0]!.baseUrl).host,
        preset: preset?.id ?? null, endpoints: saved,
        routes: savedRoutes,
        harnessProtocols: connection?.harnessProtocols,
        ...(typedKey ? { apiKey: typedKey } : {}),
        models: editedModel ? models : [entry, ...models],
      });
      if (!result.success) throw new Error(errorText(result.error));
      await customModels.refresh(machine);
      onClose();
    } catch (error) { setFailure(errorText(error)); }
    finally { setBusy(null); }
  };
  const limitField = (key: 'contextWindow' | 'maxOutput', presets: typeof INPUT_LIMITS | typeof OUTPUT_LIMITS) => {
    const label = translate(key === 'contextWindow' ? 'customModels.inputLimit' : 'customModels.outputLimit');
    return <label className="gg-model-field">
      <span className="gg-model-field-label">{label}</span>
      <Input type="number" min="1" step="1" inputMode="numeric" data-testid={`custom-model-${key}`} placeholder={translate('customModels.limitDefault')} value={limits[key] ?? ''}
        onChange={(event) => setLimits(current => ({ ...current, [key]: event.target.value ? Number(event.target.value) : undefined }))} />
      <span className="gg-model-limit-presets">
        {presets.map(([text, value]) => <Button key={text} type="button" size="sm" variant="ghost" aria-pressed={limits[key] === value}
          onClick={() => setLimits(current => ({ ...current, [key]: value }))}>{text}</Button>)}
      </span>
    </label>;
  };
  // Unchecking Custom protocol drops the routes this connection already has when it saves: said under the box, not asked in a modal.
  const droppingRoutes = advanced.customProtocol ? 0 : connection?.routes?.length ?? 0;
  const checkbox = (testId: string, label: string, checked: boolean, onChange: (checked: boolean) => void) =>
    <label className="gg-model-check" data-testid={testId}><Checkbox checked={checked} onCheckedChange={onChange} />{label}</label>;
  const fastCheckbox = <label className="gg-model-check" data-testid="custom-model-fast" data-disabled={fastSupported ? undefined : ''}>
    <Checkbox checked={advanced.fast && fastSupported} disabled={!fastSupported} onCheckedChange={checked => check('fast', checked)} />{translate('customModels.fast')}</label>;
  const formId = 'custom-model-form';
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !accountCreating) onClose(); }}>
    <DialogContent className="gg-model-dialog sm:max-w-[640px]" data-testid="custom-model-dialog"
      initialFocus={connection && !connection.keySaved ? keyInput : undefined}>
      <DialogHeader>
        <DialogTitle>{translate(connection ? 'customModels.edit' : group === 'coding-plan' ? 'customModels.addPlan' : group === 'api' ? 'customModels.addApi' : 'customModels.add')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gg-model-dialog-body">
        <div className="gg-model-field">
          <span className="gg-model-field-label flex items-center justify-between">{translate(group === 'coding-plan' ? 'customModels.plan' : 'customModels.provider')}{(preset || accountProvider) && <Button type="button" size="sm" variant="link" className="gg-model-provider-link" onClick={() => openExternalLinkInBrowser(accountProvider === 'claude' ? 'https://claude.ai/upgrade' : accountProvider === 'codex' ? 'https://chatgpt.com/pricing' : preset!.docsUrl)}>{translate(accountProvider ? 'customModels.purchasePlan' : 'customModels.docs')} ↗</Button>}</span>
          <Combobox
            value={presetId}
            disabled={accountCreating || !!busy}
            items={[{ label: null, items: providerIds }]}
            itemToStringLabel={labelOf}
            onValueChange={(id) => { if (id && id !== presetId) chooseProvider(id); }}
          >
            <ComboboxTrigger
              data-testid="custom-model-provider"
              aria-label={translate(group === 'coding-plan' ? 'customModels.plan' : 'customModels.provider')}
              className="gg-model-select-trigger flex w-full items-center justify-between rounded-md border border-border-1 bg-transparent text-left text-sm hover:border-border-2"
            >
              {providerLabel(presetId)}
              <ChevronDownIcon aria-hidden="true" className="pointer-events-none size-4 text-foreground-muted" />
            </ComboboxTrigger>
            <ComboboxContent className="min-w-(--anchor-width)">
              <ComboboxInput showTrigger={false} placeholder={translate('customModels.searchProviders')} />
              <ComboboxList>
                {(items: { label: string | null; items: string[] }) => <ComboboxGroup key={items.label ?? 'providers'} items={items.items} label={items.label}>
                  <ComboboxCollection>
                    {(id: string) => <ComboboxItem key={id} value={id}>{providerLabel(id)}</ComboboxItem>}
                  </ComboboxCollection>
                </ComboboxGroup>}
              </ComboboxList>
              <ComboboxEmpty>{translate('customModels.noProviders')}</ComboboxEmpty>
            </ComboboxContent>
          </Combobox>
        </div>
        {accountProvider ? accountAgent ? <SubscriptionConnections key={accountProvider} agent={accountAgent} machine={machine} modelAccount={{ onClose, onBusyChange: setAccountCreating }} /> : agentsError ? <SettingsNote tone="danger" role="alert">{errorText(agentsError)} <Button size="sm" variant="outline" onClick={retryOf(agentsReading)}>{translate('common.retry')}</Button></SettingsNote> : agents ? <SettingsNote tone="danger">{translate('customModels.accountUnavailable')}</SettingsNote> : <Unknown className="h-9 w-full" /> : <form id={formId} className="gg-model-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {!preset && <label className="gg-model-field"><span className="gg-model-field-label">{translate('customModels.address')}</span><Input data-testid="custom-model-address-0" type="url" required spellCheck={false} placeholder={translate('customModels.addressPlaceholder')} value={endpoints[0]?.baseUrl ?? ''} onChange={(event) => setAddress(event.target.value)} /></label>}
          <div className="gg-model-field">
            <label className="gg-model-field-label" htmlFor="custom-model-key">API Key</label>
            <div className="gg-model-key-row">
              <span className="relative flex min-w-0 flex-1 items-center"><Input id="custom-model-key" ref={keyInput} data-testid="custom-model-key" type={keyShown ? 'text' : 'password'} className={keyRevealable ? 'pr-9' : undefined} required={!connection?.keySaved} autoComplete="off" spellCheck={false} value={apiKey} aria-invalid={test.kind === 'failed' ? true : undefined} placeholder={connection?.keySaved ? `••••••••${connection.discovered?.keyLast4 ?? ''}` : translate('customModels.keyPlaceholder')} onChange={(event) => { setApiKey(event.target.value); setTest({ kind: 'idle' }); }} />
                {keyRevealable && <IconButton size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" aria-label={translate(keyShown ? 'customModels.hideKey' : 'customModels.showKey')} aria-pressed={keyShown} onClick={() => { void toggleKey(); }}>{keyShown ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}</IconButton>}</span>
              <Button type="button" variant="outline" data-testid="custom-model-test" disabled={!source || test.kind === 'testing' || !!busy} onClick={() => { void testConnection(); }}>
                {translate(test.kind === 'testing' ? 'customModels.testing' : 'customModels.test')}
              </Button>
            </div>
            {test.kind === 'ok' && <p className="gg-model-test-ok" role="status" data-testid="custom-model-test-result"><Check aria-hidden className="size-3" />{translate('customModels.testOk')}</p>}
            {test.kind === 'failed' && <p className="subscription-error" role="alert" data-testid="custom-model-test-result">{test.message}</p>}
            {test.kind === 'idle' && keyProblem && <p className="subscription-error" role="alert" data-testid="custom-model-key-problem">{keyProblem}</p>}
          </div>
          <label className="gg-model-field gg-model-field-spaced"><span className="gg-model-field-label">{translate('customModels.modelName')}</span>
            <Input data-testid="custom-model-name" required spellCheck={false} maxLength={200} placeholder={translate('customModels.modelNamePlaceholder')} value={modelName} onChange={(event) => { setModelName(event.target.value); setTest({ kind: 'idle' }); }} />
          </label>
          <div className="gg-model-advanced" data-testid="custom-model-advanced">
            <span className="gg-model-field-label">{translate('customModels.advancedConfig')}</span>
            <div className="gg-model-checks">
              {checkbox('custom-model-tool-call', translate('customModels.toolCall'), advanced.toolCall, checked => check('toolCall', checked))}
              {checkbox('custom-model-image', translate('customModels.image'), advanced.image, checked => check('image', checked))}
              {checkbox('custom-model-thinking', translate('customModels.thinking'), advanced.thinking, checkThinking)}
              {advanced.thinking && checkbox('custom-model-thinking-only', translate('customModels.thinkingOnly'), advanced.thinkingOnly, checked => check('thinkingOnly', checked))}
              {advanced.thinking && checkbox('custom-model-thinking-optional', translate('customModels.thinkingOptional'), advanced.thinkingOptional, checked => check('thinkingOptional', checked))}
              {fastCheckbox}
              <div className="gg-model-check-row">
                {checkbox('custom-model-custom-protocol', translate('customModels.customProtocol'), advanced.customProtocol, checkCustomProtocol)}
                {droppingRoutes > 0 && <p className="gg-model-hint" data-tone="warning" role="status" data-testid="custom-model-drop-routes">
                  {translate('customModels.dropRoutes', { count: droppingRoutes })}</p>}
              </div>
            </div>
            {advanced.customProtocol && <fieldset className="gg-model-routes" data-testid="custom-model-routes">
              <legend className="gg-model-field-label">{translate('customModels.routing')}</legend>
              {routes.map((route, index) => (
                <div key={route.id} className={`grid items-end gap-2 ${routeAddresses
                  ? 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)_auto]'
                  : 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_auto]'}`}>
                  <label className="gg-model-route-cell">{translate('customModels.incoming')}
                    <Select value={route.incoming} onValueChange={(value) => { if (value) updateRoute(route.id, { incoming: value }); }}>
                      <SelectTrigger className="w-full" data-testid={`custom-model-route-incoming-${index}`}><SelectValue>{route.incoming === 'any' ? translate('customModels.anyProtocol') : protocolLabel(route.incoming)}</SelectValue></SelectTrigger>
                      <SelectContent><SelectItem value="any">{translate('customModels.anyProtocol')}</SelectItem>
                        {modelProtocolSchema.options.map(protocol => <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  <span className="self-end pb-2 text-foreground-muted" aria-hidden="true">→</span>
                  <label className="gg-model-route-cell">{translate('customModels.outgoing')}
                    <Select value={route.outgoing} onValueChange={(value) => { if (value) updateRoute(route.id, { outgoing: value }); }}>
                      <SelectTrigger className="w-full" data-testid={`custom-model-route-outgoing-${index}`}><SelectValue>{protocolLabel(route.outgoing)}</SelectValue></SelectTrigger>
                      <SelectContent>
                        {modelProtocolSchema.options.map(protocol => <SelectItem key={protocol} value={protocol}>{protocolLabel(protocol)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="gg-model-route-cell">{translate('customModels.applicableModel')}
                    <Select value={route.modelId ?? ''} onValueChange={(value) => updateRoute(route.id, { modelId: value || undefined })}>
                      <SelectTrigger className="w-full" data-testid={`custom-model-route-model-${index}`}><SelectValue>{route.modelId ?? translate('customModels.allModels')}</SelectValue></SelectTrigger>
                      <SelectContent><SelectItem value="">{translate('customModels.allModels')}</SelectItem>
                        {[...new Set([...(model ? [model] : []), ...(connection?.models ?? []).map(({ id }) => id).filter(id => id !== editedModel?.id)])]
                          .map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  {routeAddresses && <label className="gg-model-route-cell">{translate('customModels.routeAddressColumn')}
                    <Input type="url" aria-label={translate('customModels.routeAddress', { index: index + 1 })}
                      data-testid={`custom-model-route-address-${index}`} value={route.baseUrl ?? ''}
                      placeholder={routeAddressPlaceholder(route.outgoing)}
                      onChange={(event) => updateRoute(route.id, { baseUrl: event.target.value })} />
                  </label>}
                  <IconButton size="sm" aria-label={translate('customModels.removeRoute', { index: index + 1 })}
                    onClick={() => setRoutes(current => current.filter(({ id }) => id !== route.id))}><X aria-hidden className="size-4" /></IconButton>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="self-start" disabled={routes.length >= 100} onClick={addRoute}>{translate('customModels.addRoute')}</Button>
            </fieldset>}
            {advanced.thinking && <div className="gg-model-thinking" data-testid="custom-model-thinking-levels">
              {!advanced.efforts.length && <p className="gg-model-hint" data-testid="custom-model-effort-hint">{translate('customModels.effortHint')}</p>}
              <div className="gg-model-field">
                <span className="gg-model-field-label" id="custom-model-default-effort-label">{translate('customModels.defaultEffort')}</span>
                <Select value={advanced.defaultEffort ?? 'auto'} onValueChange={(value) => setAdvanced(current => ({ ...current, defaultEffort: value === 'auto' || !value ? null : value as CustomModelEffortLevel }))}>
                  <SelectTrigger className="w-full" data-testid="custom-model-default-effort" aria-labelledby="custom-model-default-effort-label"><SelectValue>{effortLabel(advanced.defaultEffort)}</SelectValue></SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} align="start" sideOffset={9}>
                    <SelectItem value="auto">{effortLabel(null)}</SelectItem>
                    {advanced.efforts.map(level => <SelectItem key={level} value={level}>{effortLabel(level)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="gg-model-field">
                <span className="gg-model-field-label">{translate('customModels.supportedEfforts')}</span>
                <div className="gg-model-levels">
                  {CUSTOM_MODEL_EFFORT_LEVELS.map(level => <span key={level}>{checkbox(`custom-model-effort-${level}`, effortLabel(level), advanced.efforts.includes(level), checked => checkEffort(level, checked))}</span>)}
                </div>
              </div>
            </div>}
            <div className="gg-model-limits">
              {limitField('contextWindow', INPUT_LIMITS)}
              {limitField('maxOutput', OUTPUT_LIMITS)}
            </div>
          </div>
          {failure && <p className="subscription-error" role="alert">{failure}</p>}
        </form>}
      </DialogContentArea>
      {!accountProvider && <div className="gg-model-dialog-footer">
        <Button type="button" variant="outline" disabled={!!busy} onClick={onClose}>{translate('common.cancel')}</Button>
        <Button type="submit" form={formId} disabled={!!busy} data-testid="custom-model-save">{translate(busy === 'save' ? 'subscriptions.connections.saving' : 'common.save')}</Button>
      </div>}
    </DialogContent>
  </Dialog>;
}
