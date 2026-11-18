import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ owner: 'owner', role: true, queryError: false, swapDuringQuery: false }));
const send = vi.hoisted(() => vi.fn(async () => ({ id: 'durable-message', deferred: true })));
const notified = vi.hoisted(() => vi.fn());
vi.mock('@main/core/extensions/extension-agents', () => ({ listAgentsForExtension: async () => ({
  agents: [{ agentId: 'user:assistant' }, { agentId: 'user:task' }], unreached: [],
}) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => state.owner || null }));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: () => {
  const filters = new Map<string, unknown>();
  const query = { select: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
    then: (resolve: (result: unknown) => unknown) => {
      if (state.swapDuringQuery) state.owner = 'other';
      return Promise.resolve(resolve({ data: state.role && filters.get('member_key') === 'assistant' && filters.get('owner_user_id') === 'owner'
        ? [{ agent_user_id: 'assistant', agent: { removed_at: null }, device_id: 'home', member_key: 'assistant', phase: 'completed', created_at: '2026-10-21' }] : [],
        error: state.queryError ? new Error('unavailable') : null }));
    } };
  return query;
} }) }));
vi.mock('@main/core/extensions/extension-send', async () => {
  const { AppSendError } = await import('@shared/extensions/app-send-core');
  return { AppSendError, messageAgentFromHostApp: send };
});
vi.mock('@main/core/extensions/extension-programs', () => ({ notifyFromNativeProgram: notified }));
const { callAssistantApp } = await import('./assistant-app');
const { AssistantWorkStore, assistantWorkBinding } = await import('../../../../sessionpage/assistant-work');
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'assistant-app-'));
  vi.stubEnv('GUGU_HOME', home);
  Object.assign(state, { owner: 'owner', role: true, queryError: false, swapDuringQuery: false });
  send.mockClear(); notified.mockClear();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

it('uses the shared App message delivery with a host-owned sender, fixed personal recipient and defer semantics', async () => {
  expect(await callAssistantApp('listAgents', {})).toEqual({ agents: [{ agentId: 'user:assistant' }], unreached: [] });
  expect(await callAssistantApp('dispatch', { text: 'saved operation', to: { agent: 'user:assistant' }, delivery: 'defer', extensionId: 'forged' }, 'owner'))
    .toEqual({ to: { agent: 'user:assistant' }, id: 'durable-message', deferred: true });
  expect(send).toHaveBeenCalledWith({ extensionId: 'gugu.assistant', extensionName: '个人助理面板' }, 'all-machines',
    { agentId: 'user:assistant', text: 'saved operation', delivery: 'defer' });
});
it('refuses task agents, unknown roles, account switches and wake/replacement requests', async () => {
  await expect(callAssistantApp('listAgents', {}, 'previous-account')).rejects.toMatchObject({ code: 'denied' });
  state.role = false;
  await expect(callAssistantApp('dispatch', { text: 'x', to: { agent: 'user:task' }, delivery: 'defer' }, 'owner')).rejects.toMatchObject({ code: 'denied' });
  state.role = true; state.queryError = true;
  await expect(callAssistantApp('dispatch', { text: 'x', to: { agent: 'user:assistant' }, delivery: 'defer' }, 'owner')).rejects.toMatchObject({ code: 'failed' });
  state.queryError = false; state.swapDuringQuery = true;
  await expect(callAssistantApp('dispatch', { text: 'x', to: { agent: 'user:assistant' }, delivery: 'defer' }, 'owner')).rejects.toMatchObject({ code: 'denied' });
  state.owner = 'owner'; state.swapDuringQuery = false;
  for (const options of [{}, { delivery: 'queue' }, { delivery: 'defer', key: 'replace-all' }]) {
    await expect(callAssistantApp('dispatch', { text: 'x', to: { agent: 'user:assistant' }, ...options }, 'owner')).rejects.toMatchObject({ code: 'invalid' });
  }
  expect(send).not.toHaveBeenCalled();
});
it('does not accept arbitrary tools/verbs, the removed note programs included', async () => {
  await expect(callAssistantApp('dispatch', { text: 'x', to: { agent: 'user:assistant' }, delivery: 'defer' })).rejects.toMatchObject({ code: 'denied' });
  for (const name of ['library_list', 'library_read', 'library_write']) await expect(callAssistantApp('callProgram', { name, arguments: { kind: 'capabilities' } }, 'owner')).rejects.toMatchObject({ code: 'invalid' });
  await expect(callAssistantApp('callProgram', { name: 'shell_exec' })).rejects.toMatchObject({ code: 'invalid' });
  await expect(callAssistantApp('spawnAgent', { prompt: 'x' })).rejects.toMatchObject({ code: 'denied' });
  expect(notified).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});
it('lists and clears only this owner’s assistant recovery entries without messaging or stopping executors', async () => {
  const binding = assistantWorkBinding('personal-session', join(home, 'assistant'), 'computer', 'assistant');
  const store = new AssistantWorkStore(binding.memoryDir);
  const id = store.begin({ kind: 'executor' }); store.confirm(id, ['session:active-child'], []);
  const result = await callAssistantApp('callProgram', { name: 'assistant_work_list' }, 'owner') as { structuredContent: { result: { items: unknown[] } } };
  expect(result.structuredContent.result.items).toHaveLength(1);
  await expect(callAssistantApp('callProgram', { name: 'assistant_work_clear' })).rejects.toMatchObject({ code: 'denied' });
  await expect(callAssistantApp('callProgram', { name: 'assistant_work_clear' }, 'other')).rejects.toMatchObject({ code: 'denied' });
  expect(store.list()).toHaveLength(1);
  await callAssistantApp('callProgram', { name: 'assistant_work_clear' }, 'owner');
  expect(store.list()).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});
