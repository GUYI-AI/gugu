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
import type { PlatformCatalogModel } from '@/lib/agentModelSelection';
import { requestSettingsFocus } from '@/components/settings/settings-focus';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

const state = vi.hoisted(() => ({ rows: [] as CustomModelConnection[], selection: null as AutoReviewModel, catalog: [] as PlatformCatalogModel[],
  writes: [] as { key: string; value: unknown }[], failSave: false, holdModels: null as Promise<void> | null }));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  listCustomModels: async () => { if (state.holdModels) await state.holdModels; return { success: true, data: state.rows }; },
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
// The account's catalog, read on this device (no signed-in account in this card's fixture).
vi.mock('@/lib/agentModelReplicas', async () => {
  const { replica } = await import('@/lib/replica');
  return { platformModels: replica({ name: 'auxiliary-models-catalog', scope: 'device', read: async () => state.catalog }) };
});
let root: Root, host: HTMLDivElement;
const selectedConnection = () => state.selection?.kind === 'custom' ? state.selection.connectionId : null;
function catalogModel(id: string, displayName: string, extra: Partial<PlatformCatalogModel> = {}): PlatformCatalogModel {
  return { id, displayName, protocols: ['anthropic-messages'], enabled: true, requiresMembership: false, hidden: false,
    creditMultiplier: null, creditMultipliers: {}, contextWindow: null, reasoningEfforts: null, ...extra } as PlatformCatalogModel;
}
const idA = '481825a8-60b9-4c83-8d1b-f104e3db0269';
const idB = '48937c18-1219-460e-9f40-e08d70de94a5';
function record(id: string, label: string): CustomModelConnection {
  return { id, name: label, credentialRef: 'ref', keySaved: true, preset: null,
    endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://provider.test' }], models: [{ id: 'same-model', label }] };
}
beforeEach(() => {
  queryClient.clear(); setLocalePreference('en-US'); state.selection = null; state.writes = []; state.failSave = false; state.holdModels = null; state.catalog = [];
  state.rows = [record(idA, 'Reviewer A'), record(idB, 'Reviewer B'),
    { ...record('no-key', 'Missing key'), keySaved: false },
    { ...record('codex', 'OpenAI only'), endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }] }];
  host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host);

});
afterEach(() => { root.unmount(); host.remove(); });
function renderCard() {
  root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider><AuxiliaryModelsGroup /></SessionLocalizationProvider></QueryClientProvider>);
}
async function choose(label: string) {
  const trigger = page.getByTestId('auto-review-model');
  await until('reviewer candidates have loaded', () => trigger.query() !== null && !trigger.query()!.hasAttribute('data-disabled'));
  await userEvent.click(trigger);
  await userEvent.click(page.getByRole('option', { name: label, exact: true }));
}
it('saves a global connection/model identity and the recommended default, without touching naming', async () => {
  renderCard();
  await userEvent.click(page.getByTestId('auto-review-model'));
  await expect.element(page.getByRole('option', { name: 'Reviewer A Reviewer A', exact: true })).toBeVisible();
  expect(page.getByRole('option', { name: 'Missing key Missing key', exact: true }).query()).toBeNull();
  expect(page.getByRole('option', { name: 'OpenAI only OpenAI only', exact: true }).query()).toBeNull();
  await userEvent.click(page.getByRole('option', { name: 'Reviewer A Reviewer A', exact: true }));
  await until('first identity persisted', () => selectedConnection() === idA);
  await choose('Reviewer B Reviewer B');
  await until('second identity persisted', () => selectedConnection() === idB);
  expect(state.selection).toEqual({ kind: 'custom', connectionId: idB, modelId: 'same-model' });
  await choose('Default (recommended)');
  await until('default persisted', () => state.selection === null);
  expect(state.writes.map(write => write.key)).toEqual(['autoReviewModel', 'autoReviewModel', 'autoReviewModel']);
});
it('shows a failed write and restores the stored default', async () => {
  renderCard();
  state.failSave = true;
  await choose('Reviewer A Reviewer A');
  await expect.element(page.getByRole('alert')).toHaveTextContent('Settings write refused');
  expect(state.selection).toBeNull();
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Default (recommended)');
});
it('keeps a vanished reviewer visible and says Auto mode is off, without silently rewriting the preference', async () => {
  renderCard();
  await choose('Reviewer A Reviewer A');
  await until('selection persisted', () => selectedConnection() === idA);
  state.rows = [];
  await customModels.refresh(null);
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('same-model');
  expect(host.textContent).toContain('The review model you chose is unavailable, so Auto mode is off.');
  expect(host.textContent).not.toContain('the default is used');
  expect(selectedConnection()).toBe(idA);
});

it('offers the reviewable Gugu models first and stores a platform pick', async () => {
  state.catalog = [catalogModel('claude-haiku-5-5', 'Claude Haiku 5.5'), catalogModel('claude-opus-5-5', 'Claude Opus 5.5'),
    catalogModel('glm-5', 'GLM-5'), catalogModel('claude-sonnet-4-6', 'Claude Sonnet 4.6', { requiresMembership: true })];
  renderCard();
  const trigger = page.getByTestId('auto-review-model');
  await until('reviewer candidates have loaded', () => trigger.query() !== null && !trigger.query()!.hasAttribute('data-disabled'));
  await userEvent.click(trigger);
  const source = 'Gugu model, charged in credits';
  await expect.element(page.getByRole('option', { name: `Claude Haiku 5.5 ${source}`, exact: true })).toBeVisible();
  // The CLI refuses to name Opus 5.5 as its reviewer; GLM cannot review; a locked model is not offered.
  for (const name of ['Claude Opus 5.5', 'GLM-5', 'Claude Sonnet 4.6']) {
    expect(page.getByRole('option', { name: `${name} ${source}`, exact: true }).query()).toBeNull();
  }
  await userEvent.click(page.getByRole('option', { name: `Claude Haiku 5.5 ${source}`, exact: true }));
  await until('platform pick persisted', () => state.selection?.kind === 'platform');
  expect(state.selection).toEqual({ kind: 'platform', modelId: 'claude-haiku-5-5' });
});

it('brings the review model row into view when Settings open from a greyed Auto mode', async () => {
  const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  try {
    requestSettingsFocus('review-model');
    renderCard();
    await until('the review row was scrolled to', () => scrolled.mock.contexts.some(element =>
      (element as Element).getAttribute('data-settings-anchor') === 'review-model'));
  } finally { scrolled.mockRestore(); }
});

it('does not show a default reviewer until the connection candidates are read', async () => {
  let release!: () => void;
  state.holdModels = new Promise<void>(resolve => { release = resolve; });
  renderCard();
  try {
    await until('the auxiliary card has mounted', () => page.getByTestId('settings-auxiliary-models').query() !== null);
    expect(page.getByTestId('auto-review-model').query()).toBeNull();
  } finally { release(); }
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Default (recommended)');
});
