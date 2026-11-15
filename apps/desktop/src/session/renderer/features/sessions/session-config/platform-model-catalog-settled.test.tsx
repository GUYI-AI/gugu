// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@renderer/lib/ipc', () => ({ invokeOnMachine: (...args: unknown[]) => invoke(...args) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));
import { PLATFORM_MODEL_CATALOG_QUERY_KEY, SESSION_CATALOG_GC_MS, usePlatformModelCatalog, type PlatformModelCatalogState } from './platform-model-catalog';
import { unavailablePlatformModelId } from './platform-model-selection';
import { queryClient } from '@renderer/lib/query-client';
import { notifyManager } from '@tanstack/react-query';
// Deliver query results in the same task they resolve in, so a test's flush sees them.
notifyManager.setScheduler((callback) => callback());
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let current: PlatformModelCatalogState;
function Probe() { current = usePlatformModelCatalog('codex', 'acp', 'session'); return null; }
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });

describe('retirement waits for the authoritative catalog response', () => {
  it.each([true, false])('does not turn the interim auth empty list into retirement (success=%s)', async (success) => {
    queryClient.clear();
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValueOnce({ models: [], sessionSelection: { modelId: 'retired-model' } });
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<Probe />); await vi.advanceTimersByTimeAsync(0); });
    expect(current.settled).toBe(false);
    expect(unavailablePlatformModelId(current)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => {
      if (success) finish({ models: [], sessionSelection: { modelId: 'retired-model' } });
      else fail(new Error('catalog offline'));
      // The shared catalog query notifies on the next macrotask.
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(current.settled).toBe(success);
    expect(unavailablePlatformModelId(current)).toBe(success ? 'retired-model' : null);
  });
});

describe('the catalog is shared account-level data', () => {
  function NewTaskProbe() { current = usePlatformModelCatalog('claude', 'acp'); return null; }
  it('a remount (another visit to New task) has the list on its first render and does not ask again', async () => {
    queryClient.clear();
    invoke.mockReset().mockResolvedValue({ models: [{ id: 'glm-5.3-flash', protocol: 'anthropic-messages' }] });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<NewTaskProbe />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(current.settled).toBe(true);
    act(() => root!.unmount());

    root = createRoot(host);
    act(() => root!.render(<NewTaskProbe />));
    expect(current.models.map((model) => model.id)).toEqual(['glm-5.3-flash']);
    expect(current.settled).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('cache lifetime', () => {
  function SessionProbe() { current = usePlatformModelCatalog('claude', 'acp', 'session-gc'); return null; }
  function NewTaskProbe() { current = usePlatformModelCatalog('claude', 'acp'); return null; }
  it('drops a session entry once unread, and keeps the account-level entry', async () => {
    queryClient.clear();
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValue({ models: [{ id: 'glm-5.3-flash', protocol: 'anthropic-messages' }] });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<><SessionProbe /><NewTaskProbe /></>); await vi.advanceTimersByTimeAsync(0); });
    const entries = () => queryClient.getQueryCache().findAll({ queryKey: PLATFORM_MODEL_CATALOG_QUERY_KEY })
      .map((query) => query.queryKey.at(-1));
    expect(entries().sort()).toEqual([null, 'session-gc']);
    act(() => root!.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_CATALOG_GC_MS + 1); });
    expect(entries()).toEqual([null]);
  });
});
