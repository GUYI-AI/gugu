// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reading } from '@/lib/replica';
import type { ManagedAgentVersions } from '@shared/core/agents/managed-versions';
import { ManagedVersionsRow } from './ManagedVersionsRow';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ owner: 'owner', reading: { state: 'unknown' } as Reading<ManagedAgentVersions>, refresh: vi.fn(), clean: vi.fn(), confirm: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/replica', () => ({ replicaAccount: () => ({ id: state.owner }), useReplica: () => state.reading }));
vi.mock('./managed-versions-model', () => ({ managedVersions: { refresh: state.refresh }, cleanManagedVersions: state.clean }));
vi.mock('@/lib/userFacingError', () => ({ messageForUser: String }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ key: 'local', remote: null }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string, values?: Record<string, string>) => key + (values ? JSON.stringify(values) : '') }) }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => state.confirm }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: state.toast }));
let root: Root;
let host: HTMLDivElement;
const data = { currentVersion: '1.3.0', versions: ['1.1.0', '1.2.0', '1.3.0'] };
beforeEach(() => { state.owner = 'owner'; state.reading = { state: 'value', value: data, stale: false, error: null }; vi.clearAllMocks(); });
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); });
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ManagedVersionsRow agentId="codex" name="Codex" disabled={false} />));
}
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === key)!;
async function open() { await act(async () => button('agentsPage.oldVersionsClean').click()); }
describe('approved managed versions row', () => {
  it('lists old versions, defaults unchecked and prevents selecting the current version', async () => {
    await mount(); expect(host.textContent).toContain('v1.1.0、v1.2.0');
    await open();
    const choices = [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(choices).toHaveLength(3);
    expect(choices.every(item => item.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(choices[0].getAttribute('aria-disabled')).toBe('true');
    await act(async () => choices[0].click());
    expect(choices[0].getAttribute('aria-checked')).toBe('false');
    expect(button('agentsPage.oldVersionsCleanAction').disabled).toBe(true);
  });
  it('cleans only a chosen version and only after the existing confirmation', async () => {
    state.clean.mockResolvedValue({ removed: ['1.1.0'], failed: [], snapshot: data });
    await mount(); await open();
    await act(async () => (host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1]).click());
    await act(async () => button('agentsPage.oldVersionsCleanAction').click());
    expect(state.clean).not.toHaveBeenCalled();
    const args = state.confirm.mock.calls[0][0];
    expect(args.title).toBe('agentsPage.oldVersionsConfirm'); expect(args.variant).toBe('destructive');
    await act(async () => args.onSuccess());
    expect(state.clean).toHaveBeenCalledExactlyOnceWith(null, 'codex', ['1.1.0']);
  });
  it('a failed read retains the last list and only enables explicit Retry', async () => {
    await mount(); await open();
    state.reading = { state: 'value', value: data, stale: true, error: new Error('read failed') };
    await act(async () => root.render(<ManagedVersionsRow agentId="codex" name="Codex" disabled={false} />));
    expect(host.textContent).toContain('agentsPage.oldVersionsReadFailed');
    expect(host.textContent).toContain('v1.1.0');
    expect(host.textContent).not.toContain('agentsPage.oldVersionsNoOld');
    await act(async () => button('common.retry').click());
    expect(state.refresh).toHaveBeenLastCalledWith(null, 'codex');
  });
  it('confirmed empty old inventory shows no cleanup action', async () => {
    state.reading = { state: 'value', value: { currentVersion: '1.3.0', versions: ['1.3.0'] }, stale: false, error: null };
    await mount(); expect(host.textContent).toContain('agentsPage.oldVersionsNoOld'); expect(host.querySelector('button')).toBeNull();
  });
  it('an account change invalidates an earlier confirmation', async () => {
    await mount(); await open();
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1].click());
    await act(async () => button('agentsPage.oldVersionsCleanAction').click());
    state.owner = 'another';
    state.confirm.mock.calls[0][0].onSuccess();
    expect(state.clean).not.toHaveBeenCalled();
  });
});
