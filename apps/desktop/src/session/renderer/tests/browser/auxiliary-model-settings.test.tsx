import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { queryClient } from '@/lib/replica';
import { setLocalePreference } from '@/i18n';
import { AuxiliaryModelsGroup } from '@/components/settings/AuxiliaryModelsGroup';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import type { AutoReviewModel } from '@gugu/session-core/models/auto-review-model';
import { SESSION_TITLE_DEFAULT_MODEL } from '@shared/core/sessions/session-title-namer';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

const state = vi.hoisted(() => ({ rows: [] as CustomModelConnection[], selection: null as AutoReviewModel,
  writes: [] as { key: string; value: unknown }[], failSave: false }));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  listCustomModels: async () => ({ success: true, data: state.rows }),
}) }));
vi.mock('@renderer/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('@renderer/lib/ipc')>(),
  invokeOnMachine: async () => [],
  rpc: { appSettings: {
    getWithMeta: async (key: string) => key === 'autoReviewModel'
      ? { value: state.selection, defaults: null, overrides: state.selection ?? {} }
      : { value: { titleModel: SESSION_TITLE_DEFAULT_MODEL }, defaults: { titleModel: SESSION_TITLE_DEFAULT_MODEL }, overrides: {} },
    update: async (key: string, value: AutoReviewModel) => {
      if (state.failSave) throw new Error('Settings write refused');
      state.writes.push({ key, value }); state.selection = value;
    },
  } },
}));
let root: Root, host: HTMLDivElement;
const idA = '481825a8-60b9-4c83-8d1b-f104e3db0269';
const idB = '48937c18-1219-460e-9f40-e08d70de94a5';
function record(id: string, label: string): CustomModelConnection {
  return { id, name: label, credentialRef: 'ref', keySaved: true, preset: null,
    endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://provider.test' }], models: [{ id: 'same-model', label }] };
}
beforeEach(() => {
  queryClient.clear(); setLocalePreference('en-US'); state.selection = null; state.writes = []; state.failSave = false;
  state.rows = [record(idA, 'Reviewer A'), record(idB, 'Reviewer B'),
    { ...record('no-key', 'Missing key'), keySaved: false },
    { ...record('codex', 'OpenAI only'), endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }] }];
  host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host);
  root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider><AuxiliaryModelsGroup /></SessionLocalizationProvider></QueryClientProvider>);
});
afterEach(() => { root.unmount(); host.remove(); });
async function choose(label: string) {
  const trigger = page.getByTestId('auto-review-model');
  await until('reviewer candidates have loaded', () => trigger.query() !== null && !trigger.query()!.hasAttribute('data-disabled'));
  await userEvent.click(trigger);
  await userEvent.click(page.getByRole('option', { name: label, exact: true }));
}
it('saves a global connection/model identity and the recommended default, without touching naming', async () => {
  await userEvent.click(page.getByTestId('auto-review-model'));
  await expect.element(page.getByRole('option', { name: 'Reviewer A Reviewer A', exact: true })).toBeVisible();
  expect(page.getByRole('option', { name: 'Missing key Missing key', exact: true }).query()).toBeNull();
  expect(page.getByRole('option', { name: 'OpenAI only OpenAI only', exact: true }).query()).toBeNull();
  await userEvent.click(page.getByRole('option', { name: 'Reviewer A Reviewer A', exact: true }));
  await until('first identity persisted', () => state.selection?.connectionId === idA);
  await choose('Reviewer B Reviewer B');
  await until('second identity persisted', () => state.selection?.connectionId === idB);
  expect(state.selection).toEqual({ kind: 'custom', connectionId: idB, modelId: 'same-model' });
  await choose('Default (recommended)');
  await until('default persisted', () => state.selection === null);
  expect(state.writes.map(write => write.key)).toEqual(['autoReviewModel', 'autoReviewModel', 'autoReviewModel']);
});
it('shows a failed write and restores the stored default', async () => {
  state.failSave = true;
  await choose('Reviewer A Reviewer A');
  await expect.element(page.getByRole('alert')).toHaveTextContent('Settings write refused');
  expect(state.selection).toBeNull();
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Default (recommended)');
});
it('falls back visibly when the selected connection disappears, without silently rewriting the preference', async () => {
  await choose('Reviewer A Reviewer A');
  await until('selection persisted', () => state.selection?.connectionId === idA);
  state.rows = [];
  await customModels.refresh(null);
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Default (recommended)');
  expect(host.textContent).toContain('If the selected model is unavailable, the default is used.');
  expect(state.selection?.connectionId).toBe(idA);
});
