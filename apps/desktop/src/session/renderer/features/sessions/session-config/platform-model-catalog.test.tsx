// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composer's Gugu group derives from the account's catalog (`platformModels`, kept across restarts), offered or not as
 * the engine's machine answers with its harness catalog (`gugu`, the host's own gate: ❌ a renderer copy of the rule); only
 * a session's preselection is asked of the host (`sessionPlatformSelection`).
 * ❌ a second catalog per surface and machine that every New task starts empty.
 */
const io = vi.hoisted(() => ({
  catalog: vi.fn(),
  invoke: vi.fn(),
  harness: vi.fn(),
}));
vi.mock('@/lib/agentModelSelection', () => ({
  fetchPlatformModelCatalog: () => io.catalog(),
  fetchAgentHarnessModels: vi.fn(),
  readAgentModelSelection: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  invokeOnMachine: (...args: unknown[]) => io.invoke(...args),
  rpcOn: () => ({ agents: { modelCatalog: (provider: string, leg: string) => io.harness(provider, leg) } }),
  rpc: {},
  events: { on: () => () => {} },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: (id: string) => (id.startsWith('remote-') ? 'box' : null) } }));
const reconnect = vi.hoisted(() => new Map<string, () => void>());
vi.mock('@renderer/lib/machine-clients', () => ({
  onMachineReconnected: (machine: string, cb: () => void) => { reconnect.set(machine, cb); return () => { reconnect.delete(machine); }; },
}));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));
// The account's plan changing is the credits' business (lib/billing/useSpendingPower.ts): here only that it was heard.
const plan = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('@/lib/billing/useSpendingPower', () => ({ onPlanChange: (listener: () => void) => { plan.listeners.add(listener); return () => { plan.listeners.delete(listener); }; } }));

import { notifyManager } from '@tanstack/react-query';
import { followRendererSession, queryClient } from '@/lib/replica';
import { PLATFORM_MODELS_CHANGED_EVENT } from '@shared/core/agents/platform-model';
import { accountCatalogRows, harnessAnswer } from '@renderer/tests/platform-catalog-fixture';
import { usePlatformModelCatalog, type PlatformModelCatalogState } from './platform-model-catalog';

notifyManager.setScheduler((callback) => callback());

const ROWS = accountCatalogRows([
  { id: 'glm-5.3-flash', protocol: 'anthropic-messages', creditMultiplier: 0.5 },
  { id: 'gpt-6-astra', protocol: 'openai-responses' },
  { id: 'opus-5.5', protocol: 'anthropic-messages', requiresMembership: true },
]);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let current: PlatformModelCatalogState | null = null;
const frames: PlatformModelCatalogState[] = [];

function Probe({ provider, surface = 'acp', session }: { provider: string | null; surface?: 'acp' | 'tui'; session?: string }) {
  current = usePlatformModelCatalog(provider, surface, session);
  frames.push(current);
  return null;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

beforeEach(() => {
  queryClient.clear();
  frames.length = 0;
  followRendererSession('SIGNED_IN', 'account-1');
  io.catalog.mockReset().mockResolvedValue(ROWS);
  io.harness.mockReset().mockImplementation(async (provider: string) =>
    harnessAnswer(provider === 'legless' ? { offered: false, reason: 'gugu-models:not-routable' } : { offered: true }));
  io.invoke.mockReset().mockResolvedValue({ models: [], agentDefault: { modelId: 'glm-5.3-flash' }, sessionSelection: { modelId: 'glm-5.3-flash' } });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('usePlatformModelCatalog — derived from the account catalog', () => {
  it('is unknown (not an empty group) until the catalog and the machine\'s answer are read, then lists the engine protocol', async () => {
    let answer!: (rows: unknown) => void;
    io.catalog.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    mount(<Probe provider="claude" />);
    expect(current).toMatchObject({ known: false, models: [] });
    await act(async () => { answer(ROWS); });
    await settle();
    expect(current!.known).toBe(true);
    expect(current!.models.map((model) => model.id)).toEqual(['glm-5.3-flash', 'opus-5.5']);
    expect(current!.models[0]).toMatchObject({ protocol: 'anthropic-messages', creditMultiplier: 0.5 });
    // A New task asks the host nothing: no session, no preselection to read.
    expect(io.invoke).not.toHaveBeenCalled();
    expect(frames.every((frame) => frame.known || frame.models.length === 0)).toBe(true);
  });

  it('a New task opened again has the Gugu group in its first frame (one catalog for every composer)', async () => {
    mount(<Probe provider="codex" />);
    await settle();
    act(() => root!.unmount());
    frames.length = 0;
    mount(<Probe provider="codex" />);
    expect(frames[0]).toMatchObject({ known: true });
    expect(frames[0]!.models.map((model) => model.id)).toEqual(['gpt-6-astra']);
    // Opened again, the catalog is read once more (what changed while no composer listened), the group drawn meanwhile.
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(2);
    expect(frames.every((frame) => frame.known && frame.models.length === 1)).toBe(true);
  });

  it('a catalog restored from the snapshot (no menu details) is not taken as read: the group waits for the read', async () => {
    let answer!: (rows: unknown) => void;
    // Every read waits (the feed opening and the restored value each ask once): the group waits for them.
    io.catalog.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { platformModels } = await import('@/lib/agentModelReplicas');
    platformModels.set([], ROWS.map(({ creditMultiplier: _m, creditMultipliers: _ms, contextWindow: _c, reasoningEfforts: _r, ...kept }) => kept));
    mount(<Probe provider="claude" />);
    await settle();
    expect(current).toMatchObject({ known: false, models: [] });
    await act(async () => { answer(ROWS); });
    await settle();
    expect(current!.known).toBe(true);
    expect(current!.models[0]).toMatchObject({ creditMultiplier: 0.5 });
  });

  it('says the reason the machine gives for not offering the group, though the account has the models', async () => {
    mount(<Probe provider="legless" />);
    await settle();
    expect(current).toMatchObject({ known: true, models: [], catalogError: 'gugu-models:not-routable' });
    act(() => root!.unmount());
    // An engine and leg the renderer has no facts about: only the machine's answer decides (runtime not connected there).
    io.harness.mockResolvedValue(harnessAnswer({ offered: false, reason: 'gugu-models:runtime-not-connected' }));
    queryClient.clear();
    mount(<Probe provider="claude" />);
    await settle();
    expect(io.harness).toHaveBeenLastCalledWith('claude', 'acp');
    expect(current).toMatchObject({ known: true, models: [], catalogError: 'gugu-models:runtime-not-connected', settled: true });
  });

  it('follows the machine\'s answer when it is read again, and a failed read of it says so with a retry that asks again', async () => {
    mount(<Probe provider="claude" />);
    await settle();
    expect(current!.models.map((model) => model.id)).toEqual(['glm-5.3-flash', 'opus-5.5']);
    io.harness.mockResolvedValue(harnessAnswer({ offered: false, reason: 'gugu-models:no-identity-chat' }));
    await act(async () => { current!.refresh(); });
    await settle();
    expect(current).toMatchObject({ models: [], catalogError: 'gugu-models:no-identity-chat' });
    act(() => root!.unmount());
    queryClient.clear();
    io.harness.mockRejectedValue(new Error('machine gone'));
    mount(<Probe provider="claude" />);
    await settle();
    expect(current).toMatchObject({ known: true, models: [], settled: false, catalogError: expect.stringContaining('host-not-ready') });
    io.harness.mockResolvedValue(harnessAnswer());
    await act(async () => { current!.retry(); });
    await settle();
    expect(current!.models.map((model) => model.id)).toEqual(['glm-5.3-flash', 'opus-5.5']);
    expect(current!.catalogError).toBeNull();
  });

  it('a session adds its preselection, read of the host for that session only', async () => {
    mount(<Probe provider="claude" session="session-1" />);
    await settle();
    expect(io.invoke).toHaveBeenCalledWith(null, expect.any(String), { providerId: 'claude', surface: 'acp', sessionId: 'session-1' });
    expect(current).toMatchObject({ known: true, agentDefault: { modelId: 'glm-5.3-flash' }, sessionSelection: { modelId: 'glm-5.3-flash' } });
  });

  it('an agent default the picker does not list (members only) is not offered as the default', async () => {
    io.invoke.mockResolvedValue({ models: [], agentDefault: { modelId: 'opus-5.5' } });
    mount(<Probe provider="claude" session="session-2" />);
    await settle();
    expect(current).toMatchObject({ known: true, agentDefault: null });
  });

  it('a failed catalog read says so with a retry, and the retry reads again', async () => {
    io.catalog.mockRejectedValueOnce(new Error('offline'));
    mount(<Probe provider="claude" />);
    await settle();
    expect(current).toMatchObject({ known: true, models: [], settled: false, catalogError: expect.stringContaining('host-not-ready') });
    await act(async () => { current!.retry(); });
    await settle();
    expect(current!.models.map((model) => model.id)).toEqual(['glm-5.3-flash', 'opus-5.5']);
    expect(current!.catalogError).toBeNull();
  });

  it('a models-changed signal or the account\'s plan changing reads the catalog again; a focus or a return does not', async () => {
    mount(<Probe provider="claude" />);
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event(PLATFORM_MODELS_CHANGED_EVENT)); });
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(2);
    // Switching between Gugu windows, or back from elsewhere with the same plan: the costly catalog is not read.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(2);
    // A membership bought on the web (#7056): the credits, read on the return, say the plan changed.
    await act(async () => { plan.listeners.forEach((listener) => listener()); });
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(3);
  });

  it('stays settled while a refresh is on its way (a harness notice is not withdrawn and drawn again)', async () => {
    mount(<Probe provider="claude" />);
    await settle();
    expect(current!.settled).toBe(true);
    let answer!: (rows: unknown) => void;
    io.catalog.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    frames.length = 0;
    await act(async () => { window.dispatchEvent(new Event(PLATFORM_MODELS_CHANGED_EVENT)); });
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(2);
    await act(async () => { answer(ROWS); });
    await settle();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.settled)).toBe(true);
  });

  it("a session's preselection is read again when its machine comes back", async () => {
    mount(<Probe provider="claude" session="remote-1" />);
    await settle();
    expect(io.invoke).toHaveBeenCalledTimes(1);
    io.invoke.mockResolvedValue({ models: [], agentDefault: null, sessionSelection: { modelId: 'opus-5.5' } });
    await act(async () => { reconnect.get('box')!(); });
    await settle();
    expect(io.invoke).toHaveBeenCalledTimes(2);
    expect(current!.sessionSelection).toEqual({ modelId: 'opus-5.5' });
  });
});
