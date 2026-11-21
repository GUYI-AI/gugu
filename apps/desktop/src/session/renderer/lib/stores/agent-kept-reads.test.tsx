// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * Hooks that fold an agent reading into their own shape: a re-read that failed over what was read is handed on, ❌ the old
 * value passed off as current (the sign-in state, the "sign-in expired" marks, an agent's extra arguments).
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const readings = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/replica', async (original) => {
  const real = await original<typeof import('@/lib/replica')>();
  return { ...real, useReplica: (model: { name: string }, ...rest: unknown[]) => readings.has(model.name) ? readings.get(model.name) : (real.useReplica as (...args: unknown[]) => unknown)(model, ...rest) };
});
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: vi.fn() }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null, agents: {} }) }));

const { useAgentAuthStatus, useExpiredAgentIds } = await import('./use-agent-auth-status');
const { useAgentSettings } = await import('./use-agent-settings');

const failed = (value: unknown) => ({ state: 'value', value, stale: false, error: new Error('runtime gone'), retry: async () => {} });
const signedIn = { claude: { auth: { status: { kind: 'authenticated' }, login: null } } };
const expired = { claude: { auth: { status: { kind: 'unauthenticated', reason: 'expired' }, login: null } } };

async function run<T>(hook: () => T): Promise<T> {
  let out!: T;
  function Probe() { out = hook(); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>));
  act(() => root.unmount());
  return out;
}

describe('agent readings folded by their hooks', () => {
  it('sign-in state: read before, its re-read failed → cannot tell, with the reason (❌ signed in as read before)', async () => {
    readings.set('agentConfigList', failed(signedIn));
    expect((await run(() => useAgentAuthStatus('claude', undefined, { probe: false }))).auth).toEqual({ status: { kind: 'unknown', message: 'runtime gone' }, login: null });
    readings.set('agentConfigList', { ...failed(signedIn), error: null });
    expect((await run(() => useAgentAuthStatus('claude', undefined, { probe: false }))).auth?.status.kind).toBe('authenticated');
  });

  it('expired marks: read before, its re-read failed → none drawn, as when unreadable', async () => {
    readings.set('agentConfigList', failed(expired));
    expect(await run(() => useExpiredAgentIds())).toBeNull();
    readings.set('agentConfigList', { ...failed(expired), error: null });
    expect(await run(() => useExpiredAgentIds())).not.toBeNull();
  });

  it('an agent\'s settings: read before, its re-read failed → the settings stay and the failure is handed on', async () => {
    readings.set('agentSettings', failed({ value: { extraArgs: '--fast' }, defaults: {}, overrides: { extraArgs: '--fast' } }));
    const settings = await run(() => useAgentSettings('claude'));
    expect(settings.value).toEqual({ extraArgs: '--fast' });
    expect(settings.error?.message).toBe('runtime gone');
    expect(typeof settings.retry).toBe('function');
  });
});
