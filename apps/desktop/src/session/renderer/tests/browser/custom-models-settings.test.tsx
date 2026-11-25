import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { queryClient } from '@/lib/replica';
import { UI_EVENTS } from '@/lib/uiEvents';
import { setLocalePreference } from '@/i18n';
import { CustomModelsGroup } from '@/components/settings/CustomModelsGroup';
import { CustomModelDialog } from '@/components/settings/CustomModelDialog';
import { CustomModelRouteRepairHost } from '@/components/settings/CustomModelRouteRepairHost';
import { Sheet } from '@/components/ui/Sheet';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { ChatComposer } from '@gugu/session-ui/react/components';
import { CUSTOM_MODEL_KEY_CHANNEL, type CustomModelConnection, type CustomModelEffortResult } from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList, CustomModelProtocolProbe, SaveCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { customComposerOptions } from '@renderer/features/sessions/session-config/custom-model-options';
import { composerModelFooter, composerSelectedOptionId } from '@renderer/features/sessions/session-config/use-composer-model-options';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';
const state = vi.hoisted(() => ({ rows: [] as CustomModelConnection[], saved: null as SaveCustomModel | null, reads: [] as unknown[], probe: null as CustomModelProtocolProbe | null, probes: [] as unknown[], testResult: null as ConnectionModelList | null, agents: [] as unknown[] }));
const catalog = vi.hoisted(() => ({ results: new Map<string, CustomModelEffortResult>() }));
vi.mock('@renderer/lib/stores/use-agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/stores/use-agents')>(),
  useAgents: () => ({ state: 'value', value: state.agents, stale: false, error: null }),
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  listCustomModels: async () => ({ success: true, data: state.rows }),
  lookupCustomModelEfforts: async ({ ids }: { ids: string[] }) => ({ success: true, data: ids.map(id => ({
    id, result: catalog.results.get(id) ?? { kind: 'found', catalogId: id, name: id, efforts: [] },
  })) }),
  testCustomModel: async (input: unknown) => { state.reads.push(input); return { success: true, data: state.testResult ?? { kind: 'unlisted', reason: 'no-list' } }; },
  detectCustomModelProtocols: async (input: unknown) => { state.probes.push(input); return { success: true, data: state.probe }; },
  saveCustomModel: async (input: SaveCustomModel) => { state.saved = input; return { success: true, data: { ...input, id: input.id ?? '481825a8-60b9-4c83-8d1b-f104e3db0269', credentialRef: 'ref', keySaved: true } }; },
}) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { queryClient.clear(); catalog.results.clear(); setLocalePreference('en-US'); state.rows = []; state.saved = null; state.reads = []; state.probe = null; state.probes = []; state.testResult = null; state.agents = []; host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host); });
afterEach(() => { root.unmount(); host.remove(); });
const record = (): CustomModelConnection => ({ id: '481825a8-60b9-4c83-8d1b-f104e3db0269', name: 'Existing provider', credentialRef: 'ref', keySaved: false, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }], models: [] });
const render = (content: React.ReactNode) => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>{content}</SessionLocalizationProvider></QueryClientProvider>);
it.each([
  ['not-found', 'models.dev 未收录'], ['unavailable', '暂无法查询 models.dev'],
] as const)('shows the models.dev %s state and only saves an explicitly verified match', async (kind, message) => {
  await page.viewport(1280, 800);
  setLocalePreference('zh-CN');
  const connection = { ...record(), keySaved: true, models: [{ id: 'relay/model' }] };
  state.probe = { endpoints: connection.endpoints, models: ['relay/model'], failures: [] };
  catalog.results.set('relay/model', { kind });
  catalog.results.set('openai/example', { kind: 'found', catalogId: 'openai/example', name: 'Example', efforts: ['high'] });
  render(<CustomModelDialog machine={null} connection={connection} onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-effort-status')).toHaveTextContent(message);
  await until('the model dialog finishes opening', () => {
    const dialog = document.querySelector('[data-testid="custom-model-dialog"]');
    return !!dialog && dialog.getAnimations().every(animation => animation.playState === 'finished');
  });
  await page.screenshot({ path: `../../../../../../../test-results/custom-model-effort-${kind}.png` });
  if (kind === 'not-found') {
    await userEvent.fill(page.getByRole('textbox', { name: 'models.dev 模型 ID' }), 'openai/example');
    await userEvent.click(page.getByRole('button', { name: '查询', exact: true }));
    await userEvent.click(page.getByRole('button', { name: '使用 openai/example', exact: true }));
  }
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved?.models).toMatchObject([{ id: 'relay/model', ...(kind === 'not-found' ? { modelsDevId: 'openai/example' } : {}) }]);
  if (kind === 'unavailable') expect(state.saved?.models[0]?.modelsDevId).toBeUndefined();
});
it('opens model settings from the composer without requesting the add-model dialog', () => {
  const onOpen = vi.fn<(event: Event) => void>();
  window.addEventListener(UI_EVENTS.openSettings, onOpen, { once: true });
  try {
    composerModelFooter([]).onManageModels();
    expect(onOpen).toHaveBeenCalledTimes(1);
    const event = onOpen.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect((event as CustomEvent).detail).toEqual({ section: 'model', action: undefined });
  } finally {
    window.removeEventListener(UI_EVENTS.openSettings, onOpen);
  }
});
it('shows migrated records with no model or key and a repair entrypoint', async () => {
  state.rows = [record()];
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  const row = () => document.querySelector('[data-custom-connection]');
  await until('the device record renders inside Settings', () => !!row());
  expect(row()?.textContent).toContain('This custom provider has no model selected yet');
  expect(row()?.textContent).toContain('No key saved on this device');
  await userEvent.click(page.getByRole('button', { name: 'Enter key on this computer', exact: true }));
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
  await expect.element(page.getByTestId('custom-model-key')).toHaveFocus();
  expect(document.querySelector('[data-testid=custom-model-provider]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('[data-testid=custom-model-key]')?.value).toBe('');
});
it('separates coding plans, official API keys and custom endpoints, including migrated providers', async () => {
  state.rows = [
    { ...record(), id: 'plan', preset: 'kimi-coding', keySaved: true, models: [{ id: 'plan-model' }] },
    { ...record(), id: 'api', preset: 'deepseek', keySaved: true, models: [{ id: 'api-model' }] },
    { ...record(), id: 'custom', preset: 'old-relay', keySaved: true, models: [{ id: 'relay-model' }] },
  ];
  render(<CustomModelsGroup />);
  await until('all three existing connections render', () => document.querySelectorAll('[data-custom-connection]').length === 3);
  expect(document.querySelector('[data-custom-connection="plan"]')?.closest('section')?.getAttribute('data-testid')).toBe('settings-coding-plans');
  expect(document.querySelector('[data-custom-connection="api"]')?.closest('section')?.getAttribute('data-testid')).toBe('settings-api-models');
  const custom = document.querySelector('[data-custom-connection="custom"]')!;
  expect(custom.closest('section')?.getAttribute('data-testid')).toBe('settings-custom-models');
  expect(custom.textContent).toContain('provider.test');
});
it.each([
  ['coding-plan', 'Add plan', 'Claude subscription', 'ChatGPT subscription', 'DeepSeek'],
  ['api', 'Add API key', 'DeepSeek', 'OpenAI', 'Claude subscription'],
] as const)('the %s dialog offers only providers from its own card', async (group, title, first, second, absent) => {
  render(<CustomModelDialog machine={null} group={group} onClose={() => {}} />);
  await expect.element(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
  await userEvent.click(page.getByTestId('custom-model-provider'));
  await expect.element(page.getByRole('option', { name: first, exact: true })).toBeVisible();
  await expect.element(page.getByRole('option', { name: second, exact: true })).toBeVisible();
  expect(page.getByRole('option', { name: absent, exact: true }).query()).toBeNull();
});
it('edits an address with the saved key and saves multiple manual models without returning the key', async () => {
  const existing = { ...record(), keySaved: true, models: [{ id: 'model:a' }] };
  state.probe = { endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }], models: [], failures: [{ step: 'models', reason: 'no-list' }] };
  const closed = vi.fn(); render(<CustomModelDialog machine={null} connection={existing} onClose={closed} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://edited.test/v1/responses');
  await until('manual fallback is available', () => !!document.querySelector('input[name=models]'));
  const probes = state.probes.length;
  await userEvent.click(page.getByTestId('custom-model-read-list'));
  await until('the explicit read refreshes the model list with the saved key', () => state.probes.length > probes && !!document.querySelector('input[name=models]'));
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'model:a, provider/model:b');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ id: existing.id, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }], models: [{ id: 'model:a' }, { id: 'provider/model:b' }] });
  expect(state.saved).not.toHaveProperty('apiKey'); expect(closed).toHaveBeenCalledOnce();
  expect(state.probes).toContainEqual({ connectionId: existing.id, baseUrl: 'https://edited.test/v1' });
});
it('edits the protocol and model in one row and saves the optional address from Advanced', async () => {
  state.probe = { endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://provider.test' }, { protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1' }], models: ['m'], failures: [] };
  render(<CustomModelDialog machine={null} connection={{ ...record(), keySaved: true, models: [{ id: 'm' }] }} onClose={() => {}} />);
  await userEvent.click(page.getByRole('button', { name: 'Add route' }));
  await userEvent.click(page.getByTestId('custom-model-route-incoming-0'));
  await userEvent.click(page.getByRole('option', { name: 'Anthropic API' }));
  await userEvent.click(page.getByTestId('custom-model-route-outgoing-0'));
  await userEvent.click(page.getByRole('option', { name: 'OpenAI Chat' }));
  await userEvent.click(page.getByTestId('custom-model-route-model-0'));
  await userEvent.click(page.getByRole('option', { name: 'm', exact: true }));
  expect(page.getByTestId('custom-model-route-address-0').query()).toBeNull();
  await userEvent.click(page.getByRole('button', { name: /Advanced/ }));
  await expect.element(page.getByTestId('custom-model-protocols')).toHaveTextContent('This address answers: Anthropic API / OpenAI Chat');
  expect(document.querySelector('[data-testid=custom-model-route-address-0]')?.closest('.grid')).toBe(
    document.querySelector('[data-testid=custom-model-route-model-0]')?.closest('.grid'),
  );
  await userEvent.fill(page.getByTestId('custom-model-route-address-0'), 'https://provider.test/compat/v1');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: state.probe.endpoints, routes: [{
    incoming: 'anthropic-messages', outgoing: 'openai-chat-completions', modelId: 'm', baseUrl: 'https://provider.test/compat/v1',
  }] });
});

it('repairs a missing model route from its disabled row and returns to the picker after save', async () => {
  await page.viewport(1400, 800);
  const fallback = { id: 'd5bd45f0-f968-4df8-bf00-e7d303cab020', incoming: 'openai-responses', outgoing: 'openai-chat-completions' } as const;
  const connection: CustomModelConnection = {
    ...record(), keySaved: true, models: [{ id: 'repair-target' }, { id: 'other-model' }],
    endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1' }], routes: [fallback],
  };
  const agent = { id: 'claude', name: 'Claude', capabilities: {
    modelProtocols: ['anthropic-messages' as const], customModel: { convertFrom: ['openai-chat-completions' as const] },
  } };
  state.probe = { endpoints: connection.endpoints, models: connection.models.map(({ id }) => id), failures: [] };
  const options = customComposerOptions([connection], agent, translateSessionMessage, null);
  const onModelChange = vi.fn();
  render(<><div style={{ position: 'fixed', inset: 0, zIndex: 5 }}>
    <div style={{ position: 'absolute', right: 24, bottom: 24, width: 640 }}>
      <ChatComposer modelOptions={{ 'platform:available-model': { name: 'Available model' }, ...options }}
        selectedModel="platform:available-model" onModelChange={onModelChange} onSubmit={() => {}} onStop={() => {}} />
    </div>
  </div><CustomModelRouteRepairHost /></>);

  const panel = () => document.querySelector<HTMLElement>('[data-slot="combobox-content"]');
  await until('the model trigger mounts', () => !!document.querySelector('[data-testid="composer-model-trigger"]'));
  document.querySelector<HTMLButtonElement>('[data-testid="composer-model-trigger"]')!.click();
  await until('the model menu finishes opening', () => !!panel() && panel()!.getAnimations().every(({ playState }) => playState === 'finished'));
  const row = page.getByRole('option', { name: /repair-target/ });
  await expect.element(row).toHaveAttribute('aria-disabled', 'true');
  await row.hover();
  await page.getByRole('button', { name: 'Add route for this model', exact: true }).click();
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
  await expect.element(page.getByTestId('custom-model-route-incoming-0')).toHaveTextContent('Anthropic API');
  await expect.element(page.getByTestId('custom-model-route-outgoing-0')).toHaveTextContent('OpenAI Chat');
  await expect.element(page.getByTestId('custom-model-route-model-0')).toHaveTextContent('repair-target');
  expect(state.saved).toBeNull();
  await until('the route repair dialog finishes opening with Save above the composer', () => {
    const dialog = document.querySelector('[data-testid="custom-model-dialog"]');
    const save = dialog?.querySelector<HTMLButtonElement>('[data-testid="custom-model-save"]');
    if (!dialog || !save || dialog.getAnimations().some(animation => animation.playState !== 'finished')) return false;
    const { x, y, width, height } = save.getBoundingClientRect();
    return save.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  });
  await page.screenshot({ path: '../../../../../../../test-results/custom-route-repair-save.png' });
  await userEvent.click(page.getByTestId('custom-model-save'));
  await expect.element(page.getByTestId('composer-model-search')).toBeVisible();
  await expect.element(row).toHaveAttribute('data-route-repair-target', 'true');
  const routes = state.saved?.routes;
  expect(routes).toMatchObject([{ incoming: 'anthropic-messages', outgoing: 'openai-chat-completions', modelId: 'repair-target' }, fallback]);
  const updated = Object.values(customComposerOptions([{ ...connection, routes }], agent, translateSessionMessage));
  expect(updated.map(({ name, disabled }) => [name, disabled])).toEqual([['repair-target', undefined], ['other-model', true]]);
  expect(onModelChange).not.toHaveBeenCalled();
});

it('names only the bound model when reopening a migrated Pi task', async () => {
  const existing = { ...record(), keySaved: true, models: [{ id: 'glm-5.3-flash' }] };
  const duplicate = { ...existing, id: '48937c18-1219-460e-9f40-e08d70de94a5', name: 'Other provider' };
  const models = customComposerOptions([duplicate, existing], {
    id: 'pi', name: 'Pi', capabilities: { modelProtocols: ['openai-responses'], customModel: undefined },
  }, translateSessionMessage);
  const selectedModel = composerSelectedOptionId({
    model: 'gugu-' + existing.id + '/glm-5.3-flash',
    customModel: { kind: 'custom', connectionId: existing.id, modelId: 'glm-5.3-flash' },
  });
  render(<ChatComposer modelOptions={models} selectedModel={selectedModel} onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}} />);
  await until('the trigger names the bound model', () => document.querySelector('[data-slot=composer-model-trigger-label]')?.textContent === 'glm-5.3-flash');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent).not.toContain('provider');
});
it('a custom address shows no protocol: the models it lists are all selected and the recognized addresses are saved', async () => {
  state.probe = {
    endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }, { protocol: 'openai-responses', baseUrl: 'https://relay.test' }],
    models: ['model-a', 'model-b'], failures: [{ step: 'anthropic-messages', reason: 'refused' }],
  };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await until('both listed models are selected', () => document.querySelectorAll('[data-testid=connection-models] [data-slot=combobox-chip]').length === 2);
  expect(document.querySelector('[data-testid^=custom-model-protocol]')).toBeNull();
  expect(page.getByRole('button', { name: 'Test connection', exact: true }).query()).toBeNull();
  expect(state.probes).toContainEqual({ apiKey: 'sk-test', baseUrl: 'https://relay.test' });
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: state.probe.endpoints, models: [{ id: 'model-a' }, { id: 'model-b' }], apiKey: 'sk-test' });
});
const failures = [
  ['unauthorized', 'This address refused the key.', '该地址拒绝了此 Key。'],
  ['unreachable', 'Cannot reach this address.', '无法连接到该地址。'],
  ['dns', 'Cannot resolve this address. Check the hostname and DNS settings.', '无法解析该地址。请检查域名和 DNS 设置。'],
  ['timeout', 'The connection timed out. Check the network or proxy and try again.', '连接超时。请检查网络或代理后重试。'],
  ['certificate', 'Cannot verify this address’s security certificate. Check the certificate or proxy settings.', '无法验证该地址的安全证书。请检查证书或代理设置。'],
  ['connection-refused', 'The address or proxy refused the connection. Check its port and whether it is running.', '该地址或代理拒绝了连接。请检查端口及服务是否已启动。'],
  ['redirect', 'This address redirects requests. Enter the final API address instead.', '该地址会重定向请求。请直接填写最终的 API 地址。'],
  ['proxy', 'Cannot use the configured proxy. Check its address and use an HTTP or HTTPS proxy.', '无法使用配置的代理。请检查地址，并使用 HTTP 或 HTTPS 代理。'],
] as const;
for (const locale of ['en-US', 'zh-CN'] as const) {
  it.each(failures)(`${locale} shows the specific %s diagnosis without collapsing it into unreachable`, async (reason, en, zh) => {
    setLocalePreference(locale);
    state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason }, { step: 'openai-chat-completions', reason: 'no-model' }] };
    render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
    await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
    await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
    await expect.element(page.getByTestId('custom-model-key-problem')).toHaveTextContent(locale === 'en-US' ? en : zh);
    expect(document.querySelector('[data-testid=custom-model-key]')?.getAttribute('aria-invalid')).toBe('true');
    expect(page.getByTestId('custom-model-key-problem').element().textContent).not.toContain('sk-test');
  });
}
it.each(failures)('the saved connection’s Test connection action preserves %s', async (reason, text) => {
  state.rows = [{ ...record(), keySaved: true, models: [{ id: 'model' }] }];
  state.testResult = { kind: 'unlisted', reason };
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  await userEvent.click(page.getByRole('button', { name: 'Test connection', exact: true }));
  await expect.element(page.getByRole('status')).toHaveTextContent(text);
});
const found = (): CustomModelConnection => ({ ...record(), id: 'found', name: 'OpenAI', preset: 'openai', keySaved: true, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }], discovered: { source: 'shell-env', keyLast4: 'abcd' } });
const keyField = () => document.querySelector<HTMLInputElement>('[data-testid=custom-model-key]')!;
it('shows the key this computer holds when the eye is pressed, and reads with it until a new one is typed', async () => {
  const invoke = vi.fn(async (channel: string, id: unknown) => { if (channel !== CUSTOM_MODEL_KEY_CHANNEL || id !== 'found') throw new Error(channel); return 'sk-found-0000abcd'; });
  vi.stubGlobal('electronAPI', { invoke });
  try {
    state.testResult = { kind: 'unlisted', reason: 'unauthorized' };
    render(<CustomModelDialog machine={null} group="api" connection={found()} onClose={() => {}} />);
    await expect.element(page.getByTestId('custom-model-key')).toHaveAttribute('placeholder', '••••••••abcd');
    await expect.element(page.getByTestId('custom-model-key-problem')).toHaveTextContent('This address refused the key above. Enter a new key.');
    await userEvent.click(page.getByRole('button', { name: 'Show key' }));
    await expect.element(page.getByTestId('custom-model-key')).toHaveValue('sk-found-0000abcd');
    expect(keyField().type).toBe('text');
    await userEvent.click(page.getByRole('button', { name: 'Hide key' }));
    expect(keyField().type).toBe('password');
    expect(state.reads).toEqual([{ connectionId: 'found', endpoints: found().endpoints }]);
    await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-typed');
    await expect.element(page.getByTestId('custom-model-key-problem')).toHaveTextContent('This address refused the key.');
  } finally { vi.unstubAllGlobals(); }
});
it('a connection on another device shows only the end of its key, with no eye', async () => {
  vi.stubGlobal('electronAPI', { invoke: vi.fn() });
  try {
    render(<CustomModelDialog machine="device-1" group="api" connection={found()} onClose={() => {}} />);
    await expect.element(page.getByTestId('custom-model-key')).toHaveAttribute('placeholder', '••••••••abcd');
    expect(page.getByRole('button', { name: 'Show key' }).query()).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
it('preserves a connection failure that first occurs during the save-time named-model probe', async () => {
  state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason: 'no-list' }] };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'my-model');
  state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason: 'dns' }, { step: 'openai-chat-completions', reason: 'dns' }] };
  await userEvent.click(page.getByTestId('custom-model-save'));
  await expect.element(page.getByRole('alert')).toHaveTextContent('Cannot resolve this address. Check the hostname and DNS settings.');
  expect(state.saved).toBeNull();
});
it('a converted third-party model is selectable and tagged with its vendor; an IP address gets no tag', async () => {
  const chat = (id: string, baseUrl: string, model: string): CustomModelConnection => ({ ...record(), id, name: id, keySaved: true, endpoints: [{ protocol: 'openai-chat-completions', baseUrl }], models: [{ id: model }] });
  const models = customComposerOptions([
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0001', 'https://api.deepseek.com/v1', 'deepseek-v4-flash'),
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0002', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3'),
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0003', 'http://10.0.0.8:8000/v1', 'local-model'),
    { ...chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0004', 'https://no-key.example/v1', 'hidden-model'), keySaved: false },
  ], { id: 'claude', name: 'Claude', capabilities: { modelProtocols: ['anthropic-messages'], customModel: { convertFrom: ['openai-chat-completions'] } } }, translateSessionMessage);
  expect(Object.values(models).map(({ tag, disabled }) => [tag, disabled])).toEqual([['deepseek', undefined], ['bigmodel', undefined], [undefined, undefined]]);
  render(<ChatComposer modelOptions={models} selectedModel={Object.keys(models)[0]} onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}} />);
  await userEvent.click(page.getByTestId('composer-model-trigger'));
  await until('the tags render', () => document.querySelectorAll('[data-slot=composer-model-tag]').length === 2);
  expect([...document.querySelectorAll('[data-slot=composer-model-tag]')].map((tag) => tag.textContent)).toEqual(['deepseek', 'bigmodel']);
  // The trigger names only the model: nothing of the vendor besides the model's own label.
  expect(document.querySelector('[data-slot=composer-model-trigger-label]')?.textContent).toBe('deepseek-v4-flash');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent?.replace('deepseek-v4-flash', '')).not.toContain('deepseek');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent).not.toContain('·');
});
