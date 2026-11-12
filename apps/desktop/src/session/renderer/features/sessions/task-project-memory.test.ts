import { runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import {
  mergeAgentCreateProjectChoice,
  parseAgentCreateDefaults,
  rememberedChatProject,
} from '@gugu/core/shared/ui/agentCreateDefaultsModels';
import { AccountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { rememberedTaskRow, taskProjectChoice } from './task-project-memory';

vi.mock('@/lib/deviceProjects', () => ({ listMyAccountProjects: async () => [] }));
vi.mock('@/platform', () => ({ platform: {} }));

// Audit C1: picking a project that lives on another machine in a chat's task composer was remembered as
// "this computer + that machine's local id": it never read back, and it overwrote this computer's recent project.
const paper: AccountProject = { chatId: 'chat-paper', name: 'Paper', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [{ deviceId: 'gpu', localProjectId: 'gpu-paper' }] };
const notes: AccountProject = { chatId: 'chat-notes', name: 'Notes', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [{ deviceId: 'this-computer', localProjectId: 'local-notes' }] };

function store(): AccountProjectsStore {
  const accounts = new AccountProjectsStore();
  const machineOf: Record<string, string> = { 'gpu-paper': 'gpu' };
  accounts.attach({
    projects: new Map([['gpu-paper', {}], ['local-notes', {}]]),
    machineOf: (id) => machineOf[id] ?? null,
    connected: () => true,
  });
  runInAction(() => {
    accounts.list = [paper, notes];
    accounts.localDeviceId = 'this-computer';
    accounts.status = 'ready';
  });
  return accounts;
}
const machineOf = (id: string) => (id === 'gpu-paper' ? 'gpu' : null);

describe('a chat remembers the project picked for its tasks by the machine the project is on', () => {
  it('a project on another machine is remembered on that machine, reads back, and leaves this computer\'s recent project alone', () => {
    let config: Record<string, unknown> = mergeAgentCreateProjectChoice({}, 'this-computer', 'local-notes');
    const choice = taskProjectChoice('gpu-paper', 'this-computer', machineOf);
    expect(choice).toEqual({ deviceId: 'gpu', projectId: 'gpu-paper' });
    config = mergeAgentCreateProjectChoice(config, choice.deviceId, choice.projectId, 'chat-g');

    const defaults = parseAgentCreateDefaults(config);
    expect(defaults.projectByDevice['this-computer'], 'this computer\'s own recent project is not overwritten').toBe('local-notes');
    expect(defaults.projectByChat['chat-g']).toEqual({ deviceId: 'gpu', projectId: 'gpu-paper' });

    const back = rememberedChatProject(defaults, 'chat-g', 'this-computer')!;
    expect(rememberedTaskRow(back, store()), 'the chat reopens with the same account project').toBe('gpu-paper');
  });

  it('a chat that never picked falls back to this computer\'s recent project', () => {
    const defaults = parseAgentCreateDefaults(mergeAgentCreateProjectChoice({}, 'this-computer', 'local-notes'));
    const back = rememberedChatProject(defaults, 'other-chat', 'this-computer')!;
    expect(back).toEqual({ deviceId: 'this-computer', projectId: 'local-notes' });
    expect(rememberedTaskRow(back, store())).toBe('local-notes');
  });

  it('a project on this computer is remembered on this computer; an archived or unknown one reads back as nothing', () => {
    expect(taskProjectChoice('local-notes', 'this-computer', machineOf)).toEqual({ deviceId: 'this-computer', projectId: 'local-notes' });
    expect(taskProjectChoice(undefined, 'this-computer', machineOf)).toEqual({ deviceId: 'this-computer', projectId: null });
    const accounts = store();
    expect(rememberedTaskRow({ deviceId: 'this-computer', projectId: 'gpu-paper' }, accounts), 'the old wrong record does not resolve').toBeUndefined();
    runInAction(() => { accounts.list = [{ ...paper, archived: true }, notes]; });
    expect(rememberedTaskRow({ deviceId: 'gpu', projectId: 'gpu-paper' }, accounts)).toBeUndefined();
  });
});
