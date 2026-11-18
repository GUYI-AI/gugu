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
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import type { SaveCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
const state = vi.hoisted(() => ({ rows: [] as CustomModelConnection[], saved: null as SaveCustomModel | null, reads: [] as unknown[] }));
vi.mock('@renderer/lib/stores/use-agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/stores/use-agents')>(),
  useAgents: () => ({ data: [{ id: 'codex', name: 'Codex', capabilities: { modelProtocols: ['openai-responses'] } }] }),
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  listCustomModels: async () => ({ success: true, data: state.rows }),
  testCustomModel: async (input: unknown) => { state.reads.push(input); return { success: true, data: { kind: 'unlisted', reason: 'no-list' } }; },
  saveCustomModel: async (input: SaveCustomModel) => { state.saved = input; return { success: true, data: { ...input, id: input.id ?? '481825a8-60b9-4c83-8d1b-f104e3db0269', credentialRef: 'ref', keySaved: true } }; },
}) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { queryClient.clear(); setLocalePreference('en-US'); state.rows = []; state.saved = null; state.reads = []; host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host); });
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
  await userEvent.click(page.getByTestId('custom-model-provider'));
  await expect.element(page.getByRole('option', { name: 'Custom', exact: true })).toBeVisible();
  expect(document.querySelector<HTMLInputElement>('[data-testid=custom-model-key]')?.value).toBe('');
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
