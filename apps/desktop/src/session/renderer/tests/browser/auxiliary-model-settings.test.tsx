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
let root: Root, host: HTMLDivElement;
const idA = '481825a8-60b9-4c83-8d1b-f104e3db0269';
const idB = '48937c18-1219-460e-9f40-e08d70de94a5';
function record(id: string, label: string): CustomModelConnection {
  return { id, name: label, credentialRef: 'ref', keySaved: true, preset: null,
    endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://provider.test' }], models: [{ id: 'same-model', label }] };
}
const idOfficial = '5b0f6f2e-7c1d-4e8a-9a51-2f6c3f1d9e01';
/** null on the official endpoint is Haiku whatever the chat model (auto-review-source.ts:16-18). */
const official: CustomModelConnection = { id: idOfficial, name: 'Anthropic', credentialRef: 'ref', keySaved: true, preset: null,
  endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }],
  models: [{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }] };
const haikuRow = 'Claude Haiku 5.5 Anthropic';
const sonnetRow = 'Claude Sonnet 5 Anthropic';
beforeEach(() => {
  queryClient.clear(); setLocalePreference('en-US'); state.selection = null; state.writes = []; state.failSave = false; state.holdModels = null;
  state.rows = [record(idA, 'Reviewer A'), record(idB, 'Reviewer B'),
    { ...record('no-key', 'Missing key'), keySaved: false },
    { ...record('codex', 'OpenAI only'), endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }] }];
  host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host);

});
afterEach(() => { root.unmount(); host.remove(); });
function renderCard() {
  root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider><AuxiliaryModelsGroup /></SessionLocalizationProvider></QueryClientProvider>);
}
async function open() {
  const trigger = page.getByTestId('auto-review-model');
  await until('reviewer candidates have loaded', () => trigger.query() !== null && !trigger.query()!.hasAttribute('data-disabled'));
  await userEvent.click(trigger);
}
async function choose(label: string) {
  await open();
  await userEvent.click(page.getByRole('option', { name: label, exact: true }));
}
async function checkedRows() {
  await until('the reviewer list is open', () => document.querySelectorAll('[role="option"]').length > 0);
  return [...document.querySelectorAll('[role="option"][aria-selected="true"]')].map(row => row.textContent);
}
it('saves a global connection/model identity, and the checked row again returns to unset, without touching naming', async () => {
  renderCard();
  await userEvent.click(page.getByTestId('auto-review-model'));
  await expect.element(page.getByRole('option', { name: 'Reviewer A Reviewer A', exact: true })).toBeVisible();
  expect(page.getByRole('option', { name: 'Missing key Missing key', exact: true }).query()).toBeNull();
  expect(page.getByRole('option', { name: 'OpenAI only OpenAI only', exact: true }).query()).toBeNull();
  await userEvent.click(page.getByRole('option', { name: 'Reviewer A Reviewer A', exact: true }));
  await until('first identity persisted', () => state.selection?.connectionId === idA);
  await choose('Reviewer B Reviewer B');
  await until('second identity persisted', () => state.selection?.connectionId === idB);
  expect(state.selection).toEqual({ kind: 'custom', connectionId: idB, modelId: 'same-model' });
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Reviewer B');
  await choose('Reviewer B Reviewer B');
  await until('unset persisted', () => state.selection === null);
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Same as the chat model');
  expect(state.writes.map(write => write.key)).toEqual(['autoReviewModel', 'autoReviewModel', 'autoReviewModel']);
});
it('has no Default row: only the connection models are listed', async () => {
  state.rows = [official, record(idA, 'Reviewer A')];
  renderCard();
  await open();
  await until('the reviewer list is open', () => document.querySelectorAll('[role="option"]').length > 0);
  expect([...document.querySelectorAll('[role="option"]')].map(row => row.textContent))
    .toEqual(['Claude Haiku 5.5Anthropic', 'Claude Sonnet 5Anthropic', 'Reviewer AReviewer A']);
});
it('shows the one model unset resolves to on every connection as the value, with its row checked', async () => {
  state.rows = [official, { ...record('no-key', 'Missing key'), keySaved: false },
    { ...record('codex', 'OpenAI only'), endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }] }];
  renderCard();
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Claude Haiku 5.5');
  await open();
  expect(await checkedRows()).toEqual(['Claude Haiku 5.5Anthropic']);
  expect(state.selection).toBeNull();
});
it('shows "Same as the chat model" and checks nothing when a third-party connection makes unset follow the chat model', async () => {
  state.rows = [official, record(idA, 'Reviewer A')];
  renderCard();
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Same as the chat model');
  await open();
  expect(await checkedRows()).toEqual([]);
});
it('stores null when the checked row is picked again, and keeps null when it was only checked because unset resolves to it', async () => {
  state.rows = [official];
  state.selection = { kind: 'custom', connectionId: idOfficial, modelId: 'claude-sonnet-5' };
  renderCard();
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Claude Sonnet 5');
  await choose(sonnetRow);
  await until('the concrete reviewer is unset', () => state.selection === null);
  expect(state.writes).toEqual([{ key: 'autoReviewModel', value: null }]);
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Claude Haiku 5.5');
  await choose(haikuRow);
  await expect.element(page.getByRole('option', { name: haikuRow, exact: true })).not.toBeInTheDocument();
  expect(state.selection).toBeNull();
  expect(state.writes).toHaveLength(1);
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Claude Haiku 5.5');
});
it('shows a failed write and restores the stored unset value', async () => {
  renderCard();
  state.failSave = true;
  await choose('Reviewer A Reviewer A');
  await expect.element(page.getByRole('alert')).toHaveTextContent('Settings write refused');
  expect(state.selection).toBeNull();
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Same as the chat model');
});
it('falls back visibly when the selected connection disappears, without silently rewriting the preference', async () => {
  renderCard();
  await choose('Reviewer A Reviewer A');
  await until('selection persisted', () => state.selection?.connectionId === idA);
  state.rows = [];
  await customModels.refresh(null);
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Same as the chat model');
  expect(host.textContent).toContain('Applies only to chats on the chosen model’s connection.');
  expect(state.selection?.connectionId).toBe(idA);
});

it('does not show an unset reviewer until the connection candidates are read', async () => {
  let release!: () => void;
  state.holdModels = new Promise<void>(resolve => { release = resolve; });
  renderCard();
  try {
    await until('the auxiliary card has mounted', () => page.getByTestId('settings-auxiliary-models').query() !== null);
    expect(page.getByTestId('auto-review-model').query()).toBeNull();
  } finally { release(); }
  await expect.element(page.getByTestId('auto-review-model')).toHaveTextContent('Same as the chat model');
});
