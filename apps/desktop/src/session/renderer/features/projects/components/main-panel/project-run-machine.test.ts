// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  carryRunMachine, defaultRunMachine, foldersInScope, rememberRunMachine, resetRunMachineMemoryForTest, runMachineMemory, useProjectRunMachine,
} from './project-run-machine';

const cloud = vi.hoisted(() => ({
  remember: vi.fn(async () => ({})),
  read: vi.fn(async () => ({ deviceId: null, projectByDevice: {}, projectByChat: {}, machineByProject: {} as Record<string, string> })),
  accounts: { localDeviceId: 'this-desktop' as string | null },
}));
vi.mock('@/lib/agentCreateDefaults', () => ({ readAgentCreateDefaults: cloud.read, rememberAgentCreateRunMachine: cloud.remember }));
vi.mock('@renderer/features/projects/stores/account-projects-store', () => ({ accountProjectsStore: cloud.accounts }));
const defaults = (machineByProject: Record<string, string>) => ({ deviceId: null, projectByDevice: {}, projectByChat: {}, machineByProject });
import type { ProjectFoldersState, ShownFolder } from './project-folders';

const folder = (projectId: string): ShownFolder => ({ projectId, workspaceId: projectId, path: '/same/path', kind: 'root', branch: null, attachedAt: null, sessionIds: [], offline: projectId === 'remote', deviceId: projectId === 'remote' ? 'device-b' : null });
const local = folder('local');
const remote = folder('remote');
const state: ProjectFoldersState = { folders: [local, remote], chosen: local, fresh: undefined, loadError: false, unanswered: [], choose: vi.fn(), reload: vi.fn(), attach: vi.fn(), detach: vi.fn() };
const deviceOf = (id: string) => id === 'remote' ? 'device-b' : null;

describe('remembered run machine (account-wide)', () => {
  // Round-2 A/B R4-b: keys other devices cannot read (a local project id, the phone's no-project key) were stored forever.
  beforeEach(() => {
    resetRunMachineMemoryForTest();
    cloud.remember.mockClear();
    cloud.accounts.localDeviceId = 'this-desktop';
  });

  // #2412 review ③: a failed read must not leave the memory empty for good.
  it('reads again after a failed read', async () => {
    cloud.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(defaults({ 'chat-work': 'gpu' }));
    runMachineMemory.subscribe(() => {})();
    await vi.waitFor(() => expect(cloud.read).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runMachineMemory.subscribe(() => {})();
    await vi.waitFor(() => expect(runMachineMemory.current()).toEqual({ 'chat-work': 'gpu' }));
  });

  // #2412 review ③: a running desktop sees a choice made on the phone later — the next picker that appears reads it
  // (account settings have no revision signal; no timer). Pickers appearing together read once.
  it('reads when a picker appears, once for pickers appearing together', async () => {
    cloud.read.mockReset();
    cloud.read.mockResolvedValueOnce(defaults({ 'chat-work': 'gpu' })).mockResolvedValueOnce(defaults({ 'chat-work': 'this-desktop' }));
    runMachineMemory.subscribe(() => {})();
    runMachineMemory.subscribe(() => {})();
    await vi.waitFor(() => expect(runMachineMemory.current()).toEqual({ 'chat-work': 'gpu' }));
    expect(cloud.read).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runMachineMemory.subscribe(() => {})();
    await vi.waitFor(() => expect(runMachineMemory.current()).toEqual({ 'chat-work': 'this-desktop' }));
  });

  // #2412 review ③: "this computer" is the account project list's device id; until it is known nothing is remembered.
  it('remembers this computer under the account project list\'s device id, and not before it is known', async () => {
    cloud.accounts.localDeviceId = null;
    rememberRunMachine('chat-site', null);
    expect(runMachineMemory.current()['chat-site']).toBeUndefined();
    cloud.accounts.localDeviceId = 'this-desktop';
    rememberRunMachine('chat-site', null);
    await vi.waitFor(() => expect(cloud.remember).toHaveBeenCalledWith('chat-site', 'this-desktop'));
    expect(cloud.remember).toHaveBeenCalledTimes(1);
    expect(runMachineMemory.current()['chat-site']).toBe('this-desktop');
  });

  // Architecture review ④: a machine handed to the project block is its choice there, and goes to the account settings only
  // once a task is created on it.
  it('a carried machine is chosen without being remembered, and is remembered when a task is created on it', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    let hook!: ReturnType<typeof useProjectRunMachine>;
    const Probe = () => {
      hook = useProjectRunMachine('row-site', [{ key: 'local', online: true }, { key: 'gpu', online: true }], 'chat-site');
      return null;
    };
    try {
      carryRunMachine('row-site', 'gpu');
      await act(async () => root.render(React.createElement(Probe)));
      expect(hook.machine).toBe('gpu');
      expect(cloud.remember).not.toHaveBeenCalled();
      await act(async () => hook.created());
      await vi.waitFor(() => expect(cloud.remember).toHaveBeenCalledWith('chat-site', 'gpu'));
      // Later tasks: the remembered machine is the default; nothing is carried any more.
      await act(async () => hook.created());
      expect(hook.machine).toBe('gpu');
      expect(cloud.remember).toHaveBeenCalledTimes(1);

      // Picking another machine drops the carried one.
      carryRunMachine('row-site', 'gpu');
      await act(async () => hook.pick(null));
      await vi.waitFor(() => expect(cloud.remember).toHaveBeenCalledWith('chat-site', 'this-desktop'));
      cloud.remember.mockClear();
      await act(async () => hook.created());
      expect(hook.machine).toBeNull();
      expect(cloud.remember).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('remembers only under a project group id, and writes it to the account', async () => {
    rememberRunMachine(undefined, 'gpu');
    rememberRunMachine('chat-work', 'gpu');
    await vi.waitFor(() => expect(cloud.remember).toHaveBeenCalledWith('chat-work', 'gpu'));
    expect(cloud.remember).toHaveBeenCalledTimes(1);
  });
});

describe('project device scope', () => {
  // DESIGN「新建任务」默认机器:上次那台且在线 → 本机(有文件夹)→ 在线的第一台 → 都离线才回上次那台 → 第一台。
  it('defaults to the last machine only while it is online, else this computer, else the first online one', () => {
    const local = { key: 'local', online: true };
    const gpu = { key: 'gpu', online: true };
    const juma = { key: 'juma', online: false };
    expect(defaultRunMachine([local, gpu], 'gpu')).toBe('gpu');
    expect(defaultRunMachine([local, juma], 'juma')).toBe('local');
    expect(defaultRunMachine([juma, gpu], undefined)).toBe('gpu');
    expect(defaultRunMachine([juma, { key: 'wen', online: false }], 'wen')).toBe('wen');
    expect(defaultRunMachine([juma], undefined)).toBe('juma');
    // A machine without this project's folder is never a default, whatever was saved.
    expect(defaultRunMachine([gpu], 'mac1')).toBe('gpu');
    expect(defaultRunMachine([], 'gpu')).toBeNull();
  });
  it('a remote-only scope chooses that remote folder, including when it is offline', () => {
    const scoped = foldersInScope(state, ['device-b'], deviceOf);
    expect(scoped.folders).toEqual([remote]);
    expect(scoped.chosen).toBe(remote);
    expect(scoped.chosen?.offline).toBe(true);
    expect(state.folders).toEqual([local, remote]);
  });
  it('multiple devices retain the existing choice and each device’s identical path', () => {
    const scoped = foldersInScope(state, ['local', 'device-b'], deviceOf);
    expect(scoped.folders).toHaveLength(2);
    expect(scoped.chosen).toBe(local);
  });
  // PR4:文件夹按自己记着的那台机器分(folder.deviceId),❌ 拿 projectId 反查 —— 同一个本地项目 id 可能先后登记在两条设备行下。
  it('a folder is in scope by the device it was read from, whatever its project id maps to now', () => {
    const moved = { ...remote, projectId: 'local' };
    const scoped = foldersInScope({ ...state, folders: [local, moved] }, ['device-b'], () => null);
    expect(scoped.folders).toEqual([moved]);
  });
  it('a scoped device that has not answered yet is unknown (loading), not a device without folders', () => {
    const waiting = { ...state, folders: [local], chosen: local, unanswered: ['remote'] };
    expect(foldersInScope(waiting, ['device-b'], deviceOf).folders).toBeNull();
    // Another scoped device already has folders: show them, ❌ wait for every device.
    expect(foldersInScope(waiting, ['local', 'device-b'], deviceOf).folders).toEqual([local]);
    // Answered (or past the deadline) and still nothing in scope: that is a real empty scope.
    expect(foldersInScope({ ...waiting, unanswered: [] }, ['device-b'], deviceOf).folders).toEqual([]);
  });

  it('does not call a resting cloud scope unavailable while its folders cannot answer', () => {
    const unavailable = { ...state, folders: [local], unanswered: [] };
    const sleeping = foldersInScope(unavailable, ['device-b'], deviceOf, (id) => id === 'device-b');
    expect(sleeping.folders).toBeNull();
    expect(sleeping.chosen).toBeNull();
    // A real unavailable/empty scope must still block, including after waking.
    expect(foldersInScope(unavailable, ['device-b'], deviceOf, () => false).folders).toEqual([]);
  });

  it('does not hide another scope failure or discard recorded folders because a cloud device rests', () => {
    expect(foldersInScope({ ...state, folders: [] }, ['local'], deviceOf, (id) => id === 'device-b').folders).toEqual([]);
    expect(foldersInScope(state, ['device-b'], deviceOf, () => true).folders).toEqual([remote]);
  });
});
