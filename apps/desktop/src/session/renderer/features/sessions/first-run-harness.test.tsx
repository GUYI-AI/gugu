// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunHarness } from '@/components/firstRun/FirstRunHarness';
import { queryClient } from '@/lib/replica';
import { until } from '../../../../../../../tests/support/awaitCondition';

const f = vi.hoisted(() => ({ queue: vi.fn(), remember: vi.fn(), save: vi.fn(), done: vi.fn(), local: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ updateAsync: f.save, isSaving: false, settings: { state: 'value', value: { value: {}, defaults: {}, overrides: {} }, stale: false, error: null } }),
}));
vi.mock('@renderer/lib/components/app-icon', () => ({ AppIcon: () => null }));
vi.mock('@/components/firstRun/first-run-install-context', () => ({ useFirstRunInstaller: () => f.queue }));
vi.mock('@/lib/firstRun', () => ({ writeFirstRunHarness: f.remember }));
vi.mock('@/components/firstRun/local-copy', async () => {
  const { replica } = await import('@/lib/replica');
  return { localCopy: replica({ name: 'testFirstRunLocalCopy', scope: 'device', read: (_device: string, id: string) => f.local(id) }) };
});

let host: HTMLDivElement; let root: Root;
const render = () => act(async () => root.render(<FirstRunHarness userId="qa-user" onDone={f.done} />));
const next = () => host.querySelector<HTMLButtonElement>('[data-testid="first-run-harness-continue"]')!;
const choice = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="first-run-harness-${id}"] input`)!;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.queue.mockReset(); f.remember.mockReset().mockResolvedValue(undefined); f.save.mockReset().mockResolvedValue(undefined); f.done.mockReset();
  f.local.mockReset().mockResolvedValue({ kind: 'missing' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); queryClient.clear(); });

describe('first-run agent selection (#7582)', () => {
  it('defaults to Codex, allows both, and continues without waiting for installation', async () => {
    await render();
    expect(choice('codex').checked).toBe(true); expect(choice('claude').checked).toBe(false);
    await act(async () => choice('claude').click());
    expect(choice('codex').checked && choice('claude').checked).toBe(true);
    f.queue.mockReturnValue(new Promise(() => {}));
    await act(async () => next().click());
    expect(f.queue).toHaveBeenCalledWith(['codex', 'claude']);
    expect(f.save).toHaveBeenCalledWith({ lastPicked: 'codex' });
    expect(f.remember).toHaveBeenCalledWith('qa-user', ['codex', 'claude']);
    expect(f.done).toHaveBeenCalledOnce();
  });
  it('requires a selection and queues the picked agents', async () => {
    await render(); await act(async () => choice('codex').click());
    expect(next().disabled).toBe(true);
    await act(async () => choice('claude').click()); await act(async () => next().click());
    expect(f.queue).toHaveBeenCalledWith(['claude']);
    expect(f.save).toHaveBeenCalledWith({ lastPicked: 'claude' });
  });
  it('keeps failed setup saves on screen without starting an unrecorded install', async () => {
    f.save.mockRejectedValueOnce(new Error('offline'));
    await render(); await act(async () => next().click());
    expect(f.queue).not.toHaveBeenCalled(); expect(f.done).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline');
  });
  it('says on each tile what this computer has', async () => {
    f.local.mockImplementation(async (id: string) => id === 'codex' ? { kind: 'usable', version: '0.160.0' } : { kind: 'broken' });
    await render();
    const line = (id: string) => host.querySelector(`[data-testid="first-run-harness-${id}-local"]`)?.textContent
    await until('both tiles read this computer', () => Boolean(line('codex') && line('claude')));
    expect(host.querySelector('[data-testid="first-run-harness-codex-local"]')?.textContent).toBe('firstRun.harnessLocalUsable');
    expect(host.querySelector('[data-testid="first-run-harness-claude-local"]')?.textContent).toBe('firstRun.harnessLocalBroken');
  });
});
