import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { queryClient } from '@/lib/replica';
import { UI_EVENTS } from '@/lib/uiEvents';
import { setLocalePreference } from '@/i18n';
import { CustomModelsGroup } from '@/components/settings/CustomModelsGroup';
import { CustomModelDialog } from '@/components/settings/CustomModelDialog';
import { Sheet } from '@/components/ui/Sheet';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { ChatComposer } from '@gugu/session-ui/react/components';
import { CUSTOM_MODEL_KEY_CHANNEL, type CustomModelConnection } from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList, CustomModelProtocolProbe, SaveCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { customComposerOptions, managedHarnessOptions } from '@renderer/features/sessions/session-config/custom-model-options';
import { composerModelFooter, composerSelectedOptionId } from '@renderer/features/sessions/session-config/use-composer-model-options';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
const state = vi.hoisted(() => ({ rows: [] as CustomModelConnection[], saved: null as SaveCustomModel | null, reads: [] as unknown[], probe: null as CustomModelProtocolProbe | null, probes: [] as unknown[], testResult: null as ConnectionModelList | null, agents: [] as unknown[] }));
vi.mock('@renderer/lib/stores/use-agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/stores/use-agents')>(),
  useAgents: () => ({ state: 'value', value: state.agents, stale: false, error: null }),
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  listCustomModels: async () => ({ success: true, data: state.rows }),
  testCustomModel: async (input: unknown) => { state.reads.push(input); return { success: true, data: state.testResult ?? { kind: 'unlisted', reason: 'no-list' } }; },
  detectCustomModelProtocols: async (input: unknown) => { state.probes.push(input); return { success: true, data: state.probe }; },
  saveCustomModel: async (input: SaveCustomModel) => { state.saved = input; return { success: true, data: { ...input, id: input.id ?? '481825a8-60b9-4c83-8d1b-f104e3db0269', credentialRef: 'ref', keySaved: true } }; },
}) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { queryClient.clear(); setLocalePreference('en-US'); state.rows = []; state.saved = null; state.reads = []; state.probe = null; state.probes = []; state.testResult = null; state.agents = []; host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host); });
afterEach(() => { root.unmount(); host.remove(); });
const record = (): CustomModelConnection => ({ id: '481825a8-60b9-4c83-8d1b-f104e3db0269', name: 'Existing provider', credentialRef: 'ref', keySaved: false, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }], models: [] });
const render = (content: React.ReactNode) => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>{content}</SessionLocalizationProvider></QueryClientProvider>);
it('opens model settings from the composer without requesting the add-model dialog', () => {
  const onOpen = vi.fn<(event: Event) => void>();
  window.addEventListener(UI_EVENTS.openSettings, onOpen, { once: true });
  try {
    composerModelFooter().onManageModels();
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
  await userEvent.click(page.getByRole('button', { name: 'Select models', exact: true }));
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
  expect(document.querySelector('[data-testid=custom-model-provider]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('[data-testid=custom-model-key]')?.value).toBe('');
});
it('groups official and migrated relay models under their collapsed connections', async () => {
  state.rows = [
    { ...record(), id: 'plan', preset: 'kimi-coding', keySaved: true, endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://plan.test' }], models: [{ id: 'plan-model' }] },
    { ...record(), id: 'api', preset: 'deepseek', keySaved: true, endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://api.test' }], models: [{ id: 'api-model' }] },
    { ...record(), id: 'custom', preset: 'old-relay', keySaved: true, models: [{ id: 'relay-model' }] },
  ];
  render(<CustomModelsGroup />);
  await until('all three existing connections render', () => document.querySelectorAll('[data-custom-connection]').length === 3);
  expect(document.querySelector('[data-custom-connection="plan"]')?.closest('section')?.getAttribute('data-testid')).toBe('settings-coding-plans');
  expect(document.querySelector('[data-custom-connection="api"]')?.closest('section')?.getAttribute('data-testid')).toBe('settings-custom-models');
  const custom = document.querySelector('[data-custom-connection="custom"]')!;
  expect(custom.closest('section')?.getAttribute('data-testid')).toBe('settings-custom-models');
  expect(custom.querySelector('[aria-expanded]')).toBeNull();
  expect(custom.textContent).not.toContain('relay-model');
  await userEvent.click(page.getByRole('button', { name: 'Manage models', exact: true }).last());
  await expect.element(page.getByRole('switch', { name: 'Enable relay-model' })).toHaveAttribute('aria-checked', 'true');
});
it('distinguishes different API paths on the same relay and shows a test action for each model', async () => {
  state.rows = [
    { ...record(), id: 'first', keySaved: true, models: [{ id: 'first-model' }] },
    { ...record(), id: 'second', keySaved: true, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/other' }], models: [{ id: 'second-model' }] },
  ];
  render(<CustomModelsGroup />);
  await expect.element(page.getByText('https://provider.test/other', { exact: false })).toBeVisible();
  await userEvent.click(page.getByRole('button', { name: 'Manage models', exact: true }).nth(1));
  await expect.element(page.getByText('second-model', { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole('button', { name: 'Test connection', exact: true }));
  expect(state.reads).toContainEqual({ connectionId: 'second', modelId: 'second-model' });
});
it('asks which saved key to keep for configurations that share an API URL', async () => {
  state.rows = [
    { ...record(), id: 'first', keySaved: true, keyLast4: '1111', models: [{ id: 'one' }] },
    { ...record(), id: 'second', keySaved: true, keyLast4: '2222', models: [{ id: 'two' }] },
  ];
  render(<CustomModelsGroup />);
  await userEvent.click(page.getByRole('button', { name: 'Choose API key' }));
  await expect.element(page.getByText('••••2222')).toBeVisible();
  await userEvent.click(page.getByRole('button', { name: 'Keep this key' }).nth(1));
  await until('the selected saved key was submitted', () => state.saved !== null);
  expect(state.saved).toMatchObject({ id: 'second', resolveUrlConflict: true, apiUrl: 'https://provider.test/v1' });
  expect(state.saved).not.toHaveProperty('apiKey');
});
it('reuses a saved URL from Add model and retains enabled models', async () => {
  const saved = { ...record(), keySaved: true, models: [{ id: 'model-a' }] };
  state.probe = { endpoints: saved.endpoints, models: ['model-a', 'model-b'], failures: [] };
  render(<CustomModelDialog machine={null} availableConnections={[saved]} onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://provider.test/v1/');
  await expect.element(page.getByText('Uses the API key already saved for this address.')).toBeVisible();
  const picker = page.getByRole('searchbox', { name: /search models/i });
  await expect.element(picker).toBeEnabled();
  await userEvent.click(picker);
  await userEvent.click(page.getByRole('switch', { name: 'Enable model-b', exact: true }));
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ id: saved.id, apiUrl: 'https://provider.test/v1', models: [{ id: 'model-a' }, { id: 'model-b' }] });
  expect(state.saved).not.toHaveProperty('apiKey');
});
it('filters the catalog and keeps per-model settings when switching a model off', async () => {
  const saved = { ...record(), keySaved: true, models: [{ id: 'model-b' }] };
  state.probe = { endpoints: saved.endpoints, models: ['model-a', 'model-b'], failures: [] };
  render(<CustomModelDialog machine={null} connection={saved} onClose={() => {}} />);
  const search = page.getByRole('searchbox', { name: /search models/i });
  const catalog = page.getByRole('region', { name: 'Models', exact: true });
  await expect.element(catalog).toBeVisible();
  expect(page.getByRole('button', { name: 'Models', exact: true }).query()).toBeNull();
  await expect.element(catalog.getByRole('switch').first()).toHaveAccessibleName('Enable model-b');
  await userEvent.fill(search, 'model-a');
  await expect.element(catalog.getByRole('switch', { name: 'Enable model-a' })).toBeVisible();
  expect(catalog.getByRole('switch', { name: 'Enable model-b' }).query()).toBeNull();
  await userEvent.click(catalog.getByRole('button', { name: 'Edit model-a' }));
  const advanced = page.getByRole('dialog', { name: 'Advanced', exact: true });
  await expect.element(advanced).toHaveTextContent('model-a');
  const image = advanced.getByRole('switch', { name: /image/i });
  await expect.element(image).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(image);
  await userEvent.click(advanced.getByRole('button', { name: 'Cancel', exact: true }));
  await userEvent.click(catalog.getByRole('button', { name: 'Edit model-a' }));
  await expect.element(image).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(image);
  await userEvent.click(advanced.getByRole('button', { name: 'Confirm', exact: true }));
  expect(state.saved).toBeNull();
  await expect.element(search).toHaveValue('model-a');
  await userEvent.click(catalog.getByRole('switch', { name: 'Enable model-a' }));
  await userEvent.fill(search, '');
  await userEvent.click(catalog.getByRole('switch', { name: 'Enable model-b' }));
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ models: [{ id: 'model-a', image: false }], disabledModels: [{ id: 'model-b' }] });
});
it.each([
  ['coding-plan', 'Add plan', 'Claude subscription', 'ChatGPT subscription', 'DeepSeek'],
  ['api', 'Add model', 'DeepSeek', 'OpenAI', 'Claude subscription'],
] as const)('the %s dialog offers only providers from its own card', async (group, title, first, second, absent) => {
  render(<CustomModelDialog machine={null} group={group} onClose={() => {}} />);
  await expect.element(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
  await userEvent.click(page.getByTestId('custom-model-provider'));
  await expect.element(page.getByRole('option', { name: first, exact: true })).toBeVisible();
  await expect.element(page.getByRole('option', { name: second, exact: true })).toBeVisible();
  expect(page.getByRole('option', { name: absent, exact: true }).query()).toBeNull();
  if (group === 'api') {
    const relay = page.getByRole('option', { name: 'Third-party relay' });
    await expect.element(relay).toBeVisible();
    expect(relay.element()).toBe(Array.from(document.querySelectorAll('[role=option]')).at(-1));
    await userEvent.click(relay);
    await expect.element(page.getByTestId('custom-model-address-0')).toBeVisible();
  }
});
it('edits an address with the saved key and saves multiple manual models without returning the key', async () => {
  const existing = { ...record(), keySaved: true, models: [{ id: 'model:a' }] };
  state.probe = { endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }], models: [], failures: [{ step: 'models', reason: 'no-list' }] };
  const closed = vi.fn(); render(<CustomModelDialog machine={null} connection={existing} onClose={closed} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://edited.test/v1/responses');
  await until('manual fallback is available', () => !!document.querySelector('input[name=models]'));
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'model:a, provider/model:b');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ id: existing.id, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }], models: [{ id: 'model:a' }, { id: 'provider/model:b' }] });
  expect(state.saved).not.toHaveProperty('apiKey'); expect(closed).toHaveBeenCalledOnce();
  expect(state.probes).toContainEqual({ connectionId: existing.id, baseUrl: 'https://edited.test/v1' });
});
it('advanced shows what a saved address answers and keeps the protocol picked for a harness', async () => {
  state.agents = [
    { id: 'claude', name: 'Claude Code', capabilities: { modelProtocols: ['anthropic-messages'], customModel: { convertFrom: ['openai-chat-completions'] } } },
    { id: 'codex', name: 'Codex', capabilities: { modelProtocols: ['openai-responses'], customModel: { convertFrom: ['openai-chat-completions'] } } },
  ];
  state.probe = { endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://provider.test' }, { protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1' }], models: ['m'], failures: [] };
  render(<CustomModelDialog machine={null} connection={{ ...record(), keySaved: true, models: [{ id: 'm' }] }} onClose={() => {}} />);
  await userEvent.click(page.getByRole('button', { name: /Advanced/ }));
  await expect.element(page.getByTestId('custom-model-protocols')).toHaveTextContent('This address answers: Anthropic API / OpenAI Chat');
  expect(state.probes).toContainEqual({ connectionId: record().id, baseUrl: 'https://provider.test/v1' });
  // Codex could only use the converted chat address: nothing to choose.
  expect(page.getByTestId('custom-model-protocol-codex').query()).toBeNull();
  await expect.element(page.getByTestId('custom-model-protocol-claude')).toHaveTextContent('Automatic (Anthropic API)');
  await userEvent.click(page.getByTestId('custom-model-protocol-claude'));
  await userEvent.click(page.getByRole('option', { name: 'OpenAI Chat, converted locally' }));
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: state.probe.endpoints, harnessProtocols: { claude: 'openai-chat-completions' } });
});

it('names only the bound model when reopening a migrated Pi task', async () => {
  const existing = { ...record(), keySaved: true, models: [{ id: 'glm-5.3-flash' }] };
  const duplicate = { ...existing, id: '48937c18-1219-460e-9f40-e08d70de94a5', name: 'Other provider' };
  const models = customComposerOptions([duplicate, existing], {
    id: 'pi', name: 'Pi', capabilities: { modelProtocols: ['openai-responses'], customModel: undefined },
  }, 'This device', translateSessionMessage);
  const selectedModel = composerSelectedOptionId({
    model: 'gugu-' + existing.id + '/glm-5.3-flash',
    customModel: { kind: 'custom', connectionId: existing.id, modelId: 'glm-5.3-flash' },
  });
  render(<ChatComposer modelOptions={models} selectedModel={selectedModel} onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}} />);
  await until('the trigger names the bound model', () => document.querySelector('[data-slot=composer-model-trigger-label]')?.textContent === 'glm-5.3-flash');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent).not.toContain('provider');
});
it('a custom address shows no protocol: only explicitly selected models and the recognized addresses are saved', async () => {
  state.probe = {
    endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }, { protocol: 'openai-responses', baseUrl: 'https://relay.test' }],
    models: ['model-a', 'model-b'], failures: [{ step: 'anthropic-messages', reason: 'refused' }],
  };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  const picker = page.getByRole('searchbox', { name: /search models/i });
  await expect.element(picker).toBeEnabled();
  await expect.element(page.getByTestId('custom-model-save')).toBeDisabled();
  await userEvent.click(picker);
  await userEvent.click(page.getByRole('switch', { name: 'Enable model-b', exact: true }));
  expect(document.querySelector('[data-testid^=custom-model-protocol]')).toBeNull();
  expect(page.getByRole('button', { name: 'Test connection', exact: true }).query()).toBeNull();
  expect(state.probes).toContainEqual({ apiKey: 'sk-test', baseUrl: 'https://relay.test' });
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: state.probe.endpoints, models: [{ id: 'model-b' }], apiKey: 'sk-test' });
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
  await userEvent.click(page.getByRole('button', { name: 'Manage models', exact: true }));
  await userEvent.click(page.getByRole('button', { name: 'Test connection', exact: true }));
  await expect.element(page.getByTestId('custom-model-dialog').getByRole('status').filter({ hasText: text })).toBeVisible();
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
it('same-name models search and select by their access source', async () => {
  const chat = (id: string, name: string, baseUrl: string): CustomModelConnection => ({
    ...record(), id, name, keySaved: true, endpoints: [{ protocol: 'openai-chat-completions', baseUrl }], models: [{ id: 'shared-model' }],
  });
  const models = customComposerOptions([
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0001', 'First relay', 'https://api.deepseek.com/v1'),
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0002', 'Second relay', 'https://open.bigmodel.cn/api/paas/v4'),
  ], { id: 'claude', name: 'Claude', capabilities: { modelProtocols: ['anthropic-messages'], customModel: { convertFrom: ['openai-chat-completions'] } } }, 'This device', translateSessionMessage);
  const onModelChange = vi.fn();
  render(<ChatComposer modelOptions={models} selectedModel={Object.keys(models)[0]} onModelChange={onModelChange} onSubmit={() => {}} onStop={() => {}} />);
  await userEvent.click(page.getByTestId('composer-model-trigger'));
  const groupLabels = () => [...document.querySelectorAll('[data-slot="combobox-label"]')].map(el => el.textContent);
  await until('both access sources render', () => groupLabels().length === 2);
  expect(groupLabels()).toEqual(['First relay', 'Second relay']);
  await page.getByTestId('composer-model-search').fill('Second relay');
  await until('the matching group is retained', () => groupLabels().length === 1);
  expect(groupLabels()).toEqual(['Second relay']);
  await page.getByRole('option', { name: 'shared-model' }).click();
  expect(onModelChange).toHaveBeenCalledWith(Object.keys(models)[1]);
});


it('uses the settings selection for a managed Codex connection, including when every model is disabled', () => {
  const native = { disabled: { name: 'disabled' }, enabled: { name: 'enabled' } };
  const connection: CustomModelConnection = { ...record(), keySaved: true, managedNativeHarnesses: ['codex'],
    models: [{ id: 'enabled' }], disabledModels: [{ id: 'disabled' }] };
  const agent = { id: 'codex', name: 'Codex', capabilities: { modelProtocols: ['openai-responses' as const], customModel: undefined } };
  expect(managedHarnessOptions(native, 'codex', [connection])).toBeNull();
  expect(managedHarnessOptions(native, 'codex', undefined)).toBeNull();
  expect(managedHarnessOptions(native, 'codex', [])).toBeNull();
  expect(managedHarnessOptions(native, 'claude', [connection])).toBe(native);
  expect(Object.values(customComposerOptions([connection], agent, 'This device', translateSessionMessage)).map(option => option.name)).toEqual(['enabled']);
  expect(customComposerOptions([{ ...connection, models: [] }], agent, 'This device', translateSessionMessage)).toEqual({});
  expect(customComposerOptions([{ ...connection, keyConflict: true }], agent, 'This device', translateSessionMessage)).toEqual({});
});
