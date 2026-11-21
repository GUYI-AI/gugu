// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A new task on another machine: no project chosen = that machine's task workspace, ensured there (#609); a chosen one is
 * used as the project block settled it. A workspace ensured again that failed blocks sending (❌ the id from before).
 */
const io = vi.hoisted(() => ({ ensure: vi.fn(), reconnect: new Map<string, () => void>() }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    ensureTaskWorkspace: io.ensure,
    device: () => ({ label: 'Box', lastSeenAt: null }),
    connectionState: () => 'connected',
    dialsSinceOpen: () => 0,
    wakeFailure: () => null,
  },
}));
vi.mock('@renderer/lib/machine-clients', () => ({
  onMachineReconnected: (deviceId: string, cb: () => void) => { io.reconnect.set(deviceId, cb); return () => { io.reconnect.delete(deviceId); }; },
}));
vi.mock('@renderer/features/remote-hosts/machine-notice', () => ({ machineNotice: () => null, useMachineNotice: () => undefined }));
vi.mock('@renderer/features/library/library-host', () => ({ machineLibraryHost: (host: object) => host }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

import { notifyManager } from '@tanstack/react-query';
import { followRendererSession, queryClient } from '@/lib/replica';
import { useMachineCreateContext, type MachineCreateContext, type MachineCreateTarget } from './use-machine-create-target';

notifyManager.setScheduler((callback) => callback());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: MachineCreateContext | null = null;
function Probe({ target }: { target: MachineCreateTarget }) {
  current = useMachineCreateContext(target);
  return null;
}
let root: Root | null = null;
const show = (target: MachineCreateTarget) => act(() => { root = createRoot(document.createElement('div')); root.render(<Probe target={target} />); });
const hide = () => act(() => { root?.unmount(); root = null; });
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

beforeEach(() => {
  queryClient.clear();
  io.ensure.mockReset();
  followRendererSession('SIGNED_IN', 'account-1');
});
afterEach(hide);

describe('useMachineCreateContext', () => {
  it('a chosen project is used as is: nothing is ensured, nothing pending', async () => {
    show({ deviceId: 'box', projectId: 'bound' });
    await settle();
    expect(current).toMatchObject({ projectId: 'bound', blockReason: null, isContextPending: false });
    expect(io.ensure).not.toHaveBeenCalled();
  });

  it('a reconnect that cannot ensure the workspace again blocks sending (❌ the id from before the reconnect)', async () => {
    io.ensure.mockResolvedValueOnce('tw-1').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'TASK_WORKSPACE_UNAVAILABLE' }));
    show({ deviceId: 'box' });
    await settle();
    expect(current).toMatchObject({ projectId: 'tw-1', blockReason: null });
    await act(async () => { io.reconnect.get('box')!(); });
    await settle();
    expect(io.ensure).toHaveBeenCalledTimes(2);
    expect(current!.projectId).toBeUndefined();
    expect(current!.blockReason).not.toBeNull();
  });

  it('a composer opened again ensures the workspace again (the machine may have come back without it meanwhile)', async () => {
    io.ensure.mockResolvedValue('tw-1');
    show({ deviceId: 'box' });
    await settle();
    hide();
    show({ deviceId: 'box' });
    await settle();
    expect(io.ensure).toHaveBeenCalledTimes(2);
    expect(current).toMatchObject({ projectId: 'tw-1' });
  });
});
