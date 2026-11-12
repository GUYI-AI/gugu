import { describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '@shared/projects';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { runProjectAgentAction, type ProjectAgentOps } from './project-agent-actions';

const project = (id = 'p1', path = '/work/app'): LocalProject => ({ type: 'local', id, name: 'App', path, baseRef: null, repositoryWorkspaceId: 'root', createdAt: '', updatedAt: '' });
const folder = (path = '/work/docs', kind: ProjectFolder['kind'] = 'attached'): ProjectFolder => ({ projectId: 'p1', workspaceId: kind === 'root' ? 'root' : 'f1', path, kind, branch: null, sessionIds: [], attachedAt: null });
const ok = <T>(data: T) => ({ success: true as const, data });

function ops(overrides: Partial<ProjectAgentOps> = {}): ProjectAgentOps {
  return {
    list: vi.fn(async () => [project()]), get: vi.fn(async () => project()),
    create: vi.fn(async (_name, path, id) => ok(project(id, path))),
    folders: vi.fn(async () => ok([folder('/work/app', 'root'), folder()])),
    attach: vi.fn(async () => ok(folder())), detach: vi.fn(async () => ok(undefined)),
    bindings: vi.fn(async () => ok([{ projectId: 'p1', chatId: 'chat1' }])),
    localProjectOfGroup: vi.fn(async () => ok('p1')),
    ensureGroup: vi.fn(async () => ok({ chatId: 'chat1' })), bind: vi.fn(async () => ok({})),
    unbind: vi.fn(async () => ok({ expectedChatId: null })), inspect: vi.fn(async () => ({ isDirectory: true })),
    sessionCount: vi.fn(async () => 0), delete: vi.fn(async () => {}), ...overrides,
  };
}

describe('agent project operations', () => {
  it('reads the current project and its actual folder IDs', async () => {
    expect(await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_get' }, ops())).toMatchObject({ project_id: 'chat1', folders: [{ folder_id: 'root', kind: 'root' }, { path: '/work/docs' }] });
  });

  it('names every project by its project group: one row per group, none for a local project in no group', async () => {
    const api = ops({
      list: async () => [project('p1', '/work/app'), project('joined', '/work/legacy'), project('loose', '/work/loose')],
      get: async (id) => project(id, id === 'p1' ? '/work/app' : '/work/legacy'),
      bindings: async () => ok([{ projectId: 'p1', chatId: 'chat1' }, { projectId: 'joined', chatId: 'chat1' }]),
    });
    expect(await runProjectAgentAction({}, { action: 'project_list' }, api)).toEqual([{ project_id: 'chat1', name: 'App', path: '/work/app' }]);
  });

  it('resolves a project id to every folder this device has in it', async () => {
    const api = ops({
      bindings: async () => ok([{ projectId: 'p1', chatId: 'chat1' }, { projectId: 'joined', chatId: 'chat1' }]),
      folders: async (id) => ok(id === 'p1' ? [folder('/work/app', 'root')] : [{ ...folder('/work/legacy', 'root'), projectId: 'joined', workspaceId: 'joined-root' }]),
    });
    expect(await runProjectAgentAction({}, { action: 'project_get', project_id: 'chat1' }, api)).toMatchObject({ project_id: 'chat1', folders: [{ folder_id: 'root' }, { folder_id: 'joined-root' }] });
    await runProjectAgentAction({}, { action: 'project_remove_folder', project_id: 'chat1', folder_id: 'joined-root' }, api);
    expect(api.detach).toHaveBeenCalledWith('joined', 'joined-root');
    await expect(runProjectAgentAction({}, { action: 'project_remove_device', project_id: 'chat1' }, api)).rejects.toThrow('pass path');
    expect(api.unbind).not.toHaveBeenCalled();
  });

  it('refuses a local project id loudly, naming the project id to use', async () => {
    const api = ops();
    await expect(runProjectAgentAction({}, { action: 'project_get', project_id: 'p1' }, api)).rejects.toThrow('use project:chat1');
    await expect(runProjectAgentAction({}, { action: 'project_add_folder', project_id: 'p1', path: '/x' }, ops({ bindings: async () => ok([]) }))).rejects.toThrow('which is in no project');
    await expect(runProjectAgentAction({}, { action: 'project_get', project_id: 'chat-elsewhere' }, ops({ get: async () => undefined }))).rejects.toThrow('This device has no folder for project:chat-elsewhere');
    expect(api.attach).not.toHaveBeenCalled();
  });

  it('requires an explicit project on another device, instead of guessing', async () => {
    const api = ops();
    await expect(runProjectAgentAction({}, { action: 'project_add_folder', path: '/x' }, api)).rejects.toThrow('project_id is required');
    expect(api.attach).not.toHaveBeenCalled();
  });

  it('returns an actionable undo and a visible group notice for attached folders', async () => {
    const api = ops({ folders: async () => ok([folder('/work/app', 'root')]) });
    const added = await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_add_folder', path: '/work/docs' }, api);
    expect(api.attach).toHaveBeenCalledWith('p1', '/work/docs');
    expect(added).toMatchObject({ project_id: 'chat1', undo: { tool: 'project_remove_folder', project_id: 'chat1', folder_id: 'f1' }, group_notice: { chat_id: 'chat1', text: expect.stringContaining('/work/docs') } });
  });

  it('explains an existing local project root before joining its agents to the target group', async () => {
    const source = project('source', '/work/legacy');
    const sourceRoot: ProjectFolder = { ...folder('/work/legacy', 'root'), projectId: source.id, workspaceId: 'source-root' };
    const api = ops({
      get: async (id) => id === source.id ? source : project(),
      folders: async (id) => ok(id === source.id ? [sourceRoot] : [folder('/work/app', 'root')]),
      attach: vi.fn(async () => ({ success: false as const, error: { type: 'is-project-root' as const, projectId: source.id, projectName: source.name, message: 'root' } })),
      bindings: async () => ok([{ projectId: 'p1', chatId: 'chat1' }, { projectId: source.id, chatId: 'old-chat' }]),
      inspect: async () => ({ isDirectory: true, existingProject: source }),
      sessionCount: async () => 2,
    });
    const pending = await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_add_folder', path: source.path }, api);
    expect(pending).toMatchObject({ project_id: 'chat1', needs_confirmation: true, source_project_id: 'old-chat', source_folders: [source.path], sessions: 2 });
    expect(api.bind).not.toHaveBeenCalled();
    expect(api.ensureGroup).not.toHaveBeenCalled();

    const joined = await runProjectAgentAction({ projectId: 'p1' }, {
      action: 'project_add_folder', path: source.path, merge_existing: true, source_project_id: 'old-chat',
    }, api);
    expect(api.bind).toHaveBeenCalledWith(source.id, 'chat1', 'old-chat');
    expect(joined).toMatchObject({
      project_id: 'chat1', source_project_id: 'old-chat', folder_id: 'source-root',
      undo: { tool: 'project_restore_device', project_id: 'old-chat', path: source.path, expected_chat_id: 'chat1' },
      group_notice: { chat_id: 'chat1', text: expect.stringContaining('原群历史保留') },
    });
  });

  it('rejects stale source confirmation before changing folder or group ownership', async () => {
    const api = ops({
      inspect: async () => ({ isDirectory: true, existingProject: project('other', '/work/legacy') }),
      bindings: async () => ok([{ projectId: 'p1', chatId: 'chat1' }, { projectId: 'other', chatId: 'other-chat' }]),
    });
    await expect(runProjectAgentAction({ projectId: 'p1' }, {
      action: 'project_add_folder', path: '/work/legacy', merge_existing: true, source_project_id: 'source-chat',
    }, api)).rejects.toThrow('项目归属已经变化');
    expect(api.attach).not.toHaveBeenCalled();
    expect(api.bind).not.toHaveBeenCalled();
  });

  it('links an empty local project without confirmation, then treats the same group as already attached', async () => {
    const source = project('source', '/work/legacy');
    let linked = false;
    const api = ops({
      get: async (id) => id === source.id ? source : project(),
      folders: async (id) => ok(id === source.id
        ? [{ ...folder(source.path, 'root'), projectId: source.id }]
        : [folder('/work/app', 'root')]),
      attach: async () => ({ success: false, error: { type: 'is-project-root', projectId: source.id, projectName: source.name, message: 'root' } }),
      bindings: async () => ok([{ projectId: 'p1', chatId: 'chat1' }, { projectId: source.id, chatId: linked ? 'chat1' : 'old-chat' }]),
      bind: vi.fn(async () => { linked = true; return ok({}); }),
    });
    const joined = await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_add_folder', path: source.path }, api);
    expect(joined).toMatchObject({ project_id: 'chat1', undo: { tool: 'project_restore_device', project_id: 'old-chat', path: source.path } });
    expect(await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_add_folder', path: source.path }, api)).toMatchObject({ already_attached: true });
    expect(api.bind).toHaveBeenCalledOnce();
  });

  it('keeps a folder attached to a different project out of the root joining path', async () => {
    const api = ops({ attach: async () => ({ success: false, error: { type: 'belongs-to-other-project', projectId: 'source', projectName: 'Source', message: 'taken' } }) });
    await expect(runProjectAgentAction({ projectId: 'p1' }, { action: 'project_add_folder', path: '/work/legacy' }, api)).rejects.toThrow('taken');
    expect(api.bind).not.toHaveBeenCalled();
  });

  it('removing a folder preserves the directory and returns the reattach action', async () => {
    const api = ops();
    const removed = await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_remove_folder', folder_id: 'f1' }, api);
    expect(api.detach).toHaveBeenCalledWith('p1', 'f1');
    expect(api.delete).not.toHaveBeenCalled();
    expect(removed).toMatchObject({ undo: { tool: 'project_add_folder', project_id: 'chat1', path: '/work/docs' } });
  });

  it('returns an executable restore on unlink, including the prior group and expected replacement', async () => {
    let chat: string | null = 'shared';
    const api = ops({
      bindings: async () => ok(chat ? [{ projectId: 'p1', chatId: chat }] : []),
      unbind: vi.fn(async () => { chat = 'original'; return ok({ expectedChatId: chat }); }),
      bind: vi.fn(async (id, target, expected) => { expect(id).toBe('p1'); expect(expected).toBe(chat); chat = target; return ok({}); }),
      inspect: async () => ({ isDirectory: true, existingProject: project() }),
      get: async (id) => id === 'p1' ? project() : undefined,
    });
    const removed = await runProjectAgentAction({}, { action: 'project_remove_device', project_id: 'shared' }, api) as { undo: { tool: 'project_restore_device'; project_id: string; path: string; expected_chat_id: string | null } };
    expect(removed.undo).toEqual({ tool: 'project_restore_device', project_id: 'shared', path: '/work/app', expected_chat_id: 'original' });
    const { tool, ...args } = removed.undo;
    expect(await runProjectAgentAction({}, { action: tool, ...args }, api)).toMatchObject({ restored: true, project_id: 'shared' });
    expect(chat).toBe('shared');
  });

  it('does not adopt a concurrent later binding as the undo checkpoint', async () => {
    const bindings = vi.fn(async () => ok([{ projectId: 'p1', chatId: 'shared' }]));
    const api = ops({ bindings, unbind: async () => { bindings.mockResolvedValue(ok([{ projectId: 'p1', chatId: 'newer' }])); return ok({ expectedChatId: null }); } });
    expect(await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_remove_device' }, api)).toMatchObject({ undo: { project_id: 'shared', expected_chat_id: null } });
    expect(bindings).toHaveBeenCalledOnce();
  });

  it('does not invent an undo when the device was already unlinked', async () => {
    const api = ops({ bindings: async () => ok([]) });
    expect(await runProjectAgentAction({ projectId: 'p1' }, { action: 'project_remove_device' }, api)).toMatchObject({ already_unlinked: true });
    expect(api.unbind).not.toHaveBeenCalled();
  });

  it('reserves the new project group for the acting agent to materialize', async () => {
    const api = ops();
    expect(await runProjectAgentAction({}, { action: 'project_create', name: 'App', path: '/work/app' }, api)).toMatchObject({ project_id: 'chat1', group_notice: { chat_id: 'chat1' } });
    expect(api.ensureGroup).toHaveBeenCalledWith('p1');
  });

  it('does not change a populated project before the owner confirms merging', async () => {
    const api = ops({ localProjectOfGroup: async () => ok(undefined), inspect: async () => ({ isDirectory: true, existingProject: project('existing') }), sessionCount: async () => 2 });
    expect(await runProjectAgentAction({}, { action: 'project_bind_folder', chat_id: 'chat1', name: 'App', path: '/work/app' }, api)).toMatchObject({ needs_confirmation: true, sessions: 2 });
    expect(api.bind).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('refuses a folder attached to a different project rather than merging its owner', async () => {
    const api = ops({ localProjectOfGroup: async () => ok(undefined), inspect: async () => ({ isDirectory: true, existingProject: project('other', '/work/other') }) });
    await expect(runProjectAgentAction({}, { action: 'project_bind_folder', chat_id: 'chat1', name: 'App', path: '/work/docs' }, api)).rejects.toThrow('already belongs');
    expect(api.bind).not.toHaveBeenCalled();
  });

  it('linking the same root again is idempotent', async () => {
    const api = ops();
    expect(await runProjectAgentAction({}, { action: 'project_bind_folder', chat_id: 'chat1', name: 'App', path: '/work/app/' }, api)).toMatchObject({ already_attached: true });
    expect(api.localProjectOfGroup).toHaveBeenCalledWith('chat1');
    expect(api.attach).not.toHaveBeenCalled();
    expect(api.bind).not.toHaveBeenCalled();
  });

  it('a failed link removes only the empty project created by this attempt', async () => {
    const api = ops({ localProjectOfGroup: async () => ok(undefined), bind: async () => ({ success: false, error: { message: 'device lost' } }) });
    await expect(runProjectAgentAction({}, { action: 'project_bind_folder', chat_id: 'chat1', name: 'App', path: '/work/new' }, api)).rejects.toMatchObject({ message: 'device lost' });
    expect(api.delete).toHaveBeenCalledOnce();
  });

  it('a failed link preserves a concurrently reused project', async () => {
    const api = ops({ localProjectOfGroup: async () => ok(undefined), create: async () => ok(project('already-there')), bind: async () => ({ success: false, error: { message: 'device lost' } }) });
    await expect(runProjectAgentAction({}, { action: 'project_bind_folder', chat_id: 'chat1', name: 'App', path: '/work/new' }, api)).rejects.toBeDefined();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('rechecks sessions before rollback and preserves a newly populated project', async () => {
    const api = ops({ localProjectOfGroup: async () => ok(undefined), sessionCount: async () => 1, bind: async () => ({ success: false, error: { message: 'device lost' } }) });
    await expect(runProjectAgentAction({}, { action: 'project_bind_folder', chat_id: 'chat1', name: 'App', path: '/work/new' }, api)).rejects.toBeDefined();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
