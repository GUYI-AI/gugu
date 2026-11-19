import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { queryClient } from '@/lib/replica';
import { setLocalePreference } from '@/i18n';
import { CustomModelsGroup } from '@/components/settings/CustomModelsGroup';
import { CustomModelDialog } from '@/components/settings/CustomModelDialog';
import { Sheet } from '@/components/ui/Sheet';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { ChatComposer } from '@gugu/session-ui/react/components';
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import type { CustomModelProtocolProbe, SaveCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { customComposerOptions } from '@renderer/features/sessions/session-config/custom-model-options';
import { composerSelectedOptionId } from '@renderer/features/sessions/session-config/use-composer-model-options';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
const state = vi.hoisted(() => ({ rows: [] as CustomModelConnection[], saved: null as SaveCustomModel | null, reads: [] as unknown[], probe: null as CustomModelProtocolProbe | null, probes: [] as unknown[] }));
vi.mock('@renderer/lib/stores/use-agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/stores/use-agents')>(),
  useAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  listCustomModels: async () => ({ success: true, data: state.rows }),
  testCustomModel: async (input: unknown) => { state.reads.push(input); return { success: true, data: { kind: 'unlisted', reason: 'no-list' } }; },
  detectCustomModelProtocols: async (input: unknown) => { state.probes.push(input); return { success: true, data: state.probe }; },
  saveCustomModel: async (input: SaveCustomModel) => { state.saved = input; return { success: true, data: { ...input, id: input.id ?? '481825a8-60b9-4c83-8d1b-f104e3db0269', credentialRef: 'ref', keySaved: true } }; },
}) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { queryClient.clear(); setLocalePreference('en-US'); state.rows = []; state.saved = null; state.reads = []; state.probe = null; state.probes = []; host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host); });
afterEach(() => { root.unmount(); host.remove(); });
const record = (): CustomModelConnection => ({ id: '481825a8-60b9-4c83-8d1b-f104e3db0269', name: 'Existing provider', credentialRef: 'ref', keySaved: false, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }], models: [] });
const render = (content: React.ReactNode) => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>{content}</SessionLocalizationProvider></QueryClientProvider>);
it('shows migrated records with no model or key and a repair entrypoint', async () => {
  state.rows = [record()];
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  const row = () => document.querySelector('[data-custom-connection]');
  await until('the device record renders inside Settings', () => !!row());
  expect(row()?.textContent).toContain('This custom provider has no model selected yet');
  expect(row()?.textContent).toContain('This device does not have the key yet');
  await userEvent.click(page.getByRole('button', { name: 'Select models', exact: true }));
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
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
  const closed = vi.fn(); render(<CustomModelDialog machine={null} connection={existing} onClose={closed} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://edited.test/v1/responses');
  await until('manual fallback is available', () => !!document.querySelector('input[name=models]'));
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'model:a, provider/model:b');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ id: existing.id, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }], models: [{ id: 'model:a' }, { id: 'provider/model:b' }] });
  expect(state.saved).not.toHaveProperty('apiKey'); expect(closed).toHaveBeenCalledOnce();
  expect(state.reads).toContainEqual(expect.objectContaining({ connectionId: existing.id, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }] }));
});

it('shows the bound provider and model when reopening a migrated Pi task', async () => {
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
  expect(document.querySelector('[data-slot=composer-model-trigger-tag]')?.textContent).toBe('provider');
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
it.each([
  ['unauthorized', 'This address refused the key.'],
  ['unreachable', 'Cannot reach this address.'],
] as const)('a custom address that answers %s marks the key and says so under it', async (reason, text) => {
  state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason }, { step: 'openai-chat-completions', reason: 'no-model' }] };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await expect.element(page.getByTestId('custom-model-key-problem')).toHaveTextContent(text);
  expect(document.querySelector('[data-testid=custom-model-key]')?.getAttribute('aria-invalid')).toBe('true');
});
it('a converted third-party model is selectable and tagged with its vendor; an IP address gets no tag', async () => {
  const chat = (id: string, baseUrl: string, model: string): CustomModelConnection => ({ ...record(), id, name: id, keySaved: true, endpoints: [{ protocol: 'openai-chat-completions', baseUrl }], models: [{ id: model }] });
  const models = customComposerOptions([
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0001', 'https://api.deepseek.com/v1', 'deepseek-v4-flash'),
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0002', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3'),
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0003', 'http://10.0.0.8:8000/v1', 'local-model'),
  ], { id: 'claude', name: 'Claude', capabilities: { modelProtocols: ['anthropic-messages'], customModel: { convertFrom: ['openai-chat-completions'] } } }, 'This device', translateSessionMessage);
  expect(Object.values(models).map(({ tag, disabled }) => [tag, disabled])).toEqual([['deepseek', undefined], ['bigmodel', undefined], [undefined, undefined]]);
  render(<ChatComposer modelOptions={models} selectedModel={Object.keys(models)[0]} onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}} />);
  await userEvent.click(page.getByTestId('composer-model-trigger'));
  await until('the tags render', () => document.querySelectorAll('[data-slot=composer-model-tag]').length === 2);
  expect([...document.querySelectorAll('[data-slot=composer-model-tag]')].map((tag) => tag.textContent)).toEqual(['deepseek', 'bigmodel']);
  expect(document.querySelector('[data-slot=composer-model-trigger-tag]')?.textContent).toBe('deepseek');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent).not.toContain('·');
});
