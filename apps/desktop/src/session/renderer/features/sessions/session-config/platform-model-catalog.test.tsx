// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composer's Gugu group derives from the account's catalog (`platformModels`, kept across restarts) and the engine's
 * sessionpage integration on its machine; only a session's preselection is asked of the host (`sessionPlatformSelection`).
 * ❌ a second catalog per surface and machine that every New task starts empty.
 */
const io = vi.hoisted(() => ({
  catalog: vi.fn(),
  invoke: vi.fn(),
  agents: vi.fn(),
}));
vi.mock('@/lib/agentModelSelection', () => ({
  fetchPlatformModelCatalog: () => io.catalog(),
  fetchAgentHarnessModels: vi.fn(),
  readAgentModelSelection: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  invokeOnMachine: (...args: unknown[]) => io.invoke(...args),
  rpcOn: () => ({ agents: { list: () => io.agents() } }),
  rpc: {},
  events: { on: () => () => {} },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));

import { notifyManager } from '@tanstack/react-query';
import { followRendererSession, queryClient } from '@/lib/replica';
import { PLATFORM_MODELS_CHANGED_EVENT } from '@shared/core/agents/platform-model';
import { accountCatalogRows, routableAgent } from '@renderer/tests/platform-catalog-fixture';
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
  io.agents.mockReset().mockResolvedValue([routableAgent('claude'), routableAgent('codex'), routableAgent('legless')]);
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
  it('is unknown (not an empty group) until the catalog and the agent list are read, then lists the engine protocol', async () => {
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
    expect(io.catalog).toHaveBeenCalledTimes(1);
  });

  it('says why the group is absent: an engine with no wire protocol, a leg without a Gugu identity', async () => {
    mount(<Probe provider="legless" />);
    await settle();
    expect(current).toMatchObject({ known: true, models: [], catalogError: expect.stringContaining('not-routable') });
    act(() => root!.unmount());
    io.agents.mockResolvedValue([{ id: 'claude', capabilities: { sessionpage: { acp: { identity: 'none', messageTransport: 'none' } } } }]);
    queryClient.clear();
    mount(<Probe provider="claude" />);
    await settle();
    expect(current).toMatchObject({ known: true, models: [], catalogError: expect.stringContaining('no-identity-chat') });
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

  it('a models-changed signal and coming back to the window read the catalog again (once per switch)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mount(<Probe provider="claude" />);
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event(PLATFORM_MODELS_CHANGED_EVENT)); });
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 10_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(io.catalog).toHaveBeenCalledTimes(3);
  });
});
