// @vitest-environment jsdom
// #2569 the sample's footer is the new-task composer a group has. It says why it cannot send (no agent ready, one
// installing), sends by turning the sample into the person's group (with its folder) through the app's own steps, and
// hands the typed message to that group's new-task box with the sample's context; a step that fails is said under the
// box and the message stays.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ComposerProps = {
  projectId: string | undefined;
  draftKey?: string;
  blocked?: boolean;
  blockReason?: string | null;
  sendWithoutProject?: (input: unknown) => void;
};
const io = vi.hoisted(() => ({
  composer: null as null | ComposerProps,
  agents: [] as Array<{ id: string; name: string; capabilities: { sessionpage: unknown } }>,
  statuses: undefined as undefined | Array<{ id: string; status: string }>,
  installing: new Set<string>(),
  key: { version: 1, dismissed: false } as Record<string, unknown> | null,
  record: vi.fn(),
  dismiss: vi.fn(),
  directory: '/Users/p/projects',
  taken: new Set<string>(),
  createProject: vi.fn(),
  projects: new Map<string, unknown>(),
  ensureMounted: vi.fn(),
  inspect: vi.fn(),
  writeFile: vi.fn(),
  listed: new Set<string>(),
  navigate: vi.fn(),
  forget: vi.fn(),
  logError: vi.fn(),
  toast: vi.fn(),
  setComposerVerb: vi.fn(),
  openChat: vi.fn(),
  signedIn: 'u' as string | null,
}));

vi.mock('@renderer/features/sessions/new-session-page', () => ({
  NewSessionComposer: (props: ComposerProps) => {
    io.composer = props;
    return <div data-testid="new-task-composer" />;
  },
}));
vi.mock('@renderer/features/sessions/composer-verb-tag', () => ({ composerVerbLook: (tone: string) => ({ tone, tag: () => null }) }));
vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgents: () => ({ data: io.agents }) }));
vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useAgentInstallationStatuses: () => ({ data: io.statuses }),
  useInstallingAgents: () => io.installing,
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    locale: 'zh-CN',
    translate: (key: string, params?: Record<string, unknown>) => key === 'projects.sample.name' ? '周末去杭州'
      : params ? `${key}{${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join('|')}}` : key,
  }),
}));
vi.mock('@/lib/sampleProject', () => ({
  readSampleProject: async () => io.key,
  recordSampleProjectConversion: async (_userId: string, became: Record<string, unknown>) => {
    io.record(became);
    io.key = { version: 2, dismissed: false, ...became };
  },
  dismissSampleProject: async () => { await io.dismiss(); },
}));
vi.mock('@/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => ({ getSnapshot: () => ({ ownerId: io.signedIn }) }) }));
vi.mock('@/lib/composerVerbBridge', () => ({ setComposerVerb: io.setComposerVerb }));
// The chat list has loaded (the shell published it); the groups in `listed` are drawn as rows.
vi.mock('@/lib/sidebarChatsBridge', () => ({ readSidebarChatSignals: () => ({ listedGroups: io.listed }), subscribeSidebarChatSignals: () => () => {} }));
vi.mock('@/lib/chatSummariesBridge', () => ({ readChatSummary: (chatId: string) => (io.listed.has(chatId) ? { id: chatId, name: '周末去杭州' } : undefined) }));
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen: io.openChat }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: io.toast }));
vi.mock('@renderer/app/screen-layout-actions', () => ({ forgetSampleProjectOnScreen: io.forget }));
vi.mock('@renderer/features/folders/group-home', async () => {
  const { composerDrafts } = await import('@renderer/features/sessions/composer-drafts');
  const groupDraftKey = (chatId: string) => `group:${chatId}`;
  return { groupDraftKey, prepareGroupTask: (chatId: string, from: string) => composerDrafts.moveToEmpty(from, groupDraftKey(chatId)) };
});
// 新建群（同时新建一个文件夹）:群和文件夹一起建出来;这里文件夹 id 记作 project-N,它的群是 chat-of-project-N。
vi.mock('@renderer/features/folders/create-group-with-folder', () => ({
  createGroupWithFolder: async (input: unknown) => {
    const folderId = await io.createProject(input);
    io.projects.set(folderId, {});
    return `chat-of-${folderId}`;
  },
}));
vi.mock('@renderer/features/folders/group-folders-store', () => ({ groupFoldersStore: { chatOfFolder: () => undefined, refresh: vi.fn() } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: io.projects, ensureMounted: io.ensureMounted }),
}));
vi.mock('@renderer/features/settings/app-settings-client', () => ({
  LOCAL_SETTINGS_HOST_KEY: 'local',
  fetchAppSettingValue: async () => ({ defaultProjectsDirectory: io.directory }),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    folders: { inspectFolderPath: io.inspect, listGroupFolders: async (chatId: string) => [{ id: chatId.replace(/^chat-of-/, '') }] },
    workspace: { files: { writeFile: io.writeFile } },
  },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: io.navigate } } }));
vi.mock('@renderer/utils/logger', () => ({ log: { error: io.logError, warn: vi.fn() } }));

const { SampleComposer, SAMPLE_DRAFT_KEY } = await import('./sample-composer');
const { composerDrafts } = await import('@renderer/features/sessions/composer-drafts');
const groupDraftKey = (chatId: string) => `group:${chatId}`;
const { resetSampleConversion, sampleConversion, sampleConversionOf } = await import('./sample-conversion');
const { zhCNSampleProject } = await import('./content/zh-CN');

const CODEX = { id: 'codex', name: 'Codex', capabilities: { sessionpage: { acp: { identity: 'addressable', messageTransport: 'router' } } } };
const typed = '周六要是下雨，行程怎么改？';
const input = {
  provider: 'codex', model: null, platformModel: 'gugu-model', effort: 'high', permissionMode: 'full-access', sessionView: 'general',
};

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const text = () => host.textContent ?? '';
const render = () => act(async () => root.render(<SampleComposer ownerId="u" content={zhCNSampleProject} />));
const send = async () => {
  await act(async () => io.composer!.sendWithoutProject!(input));
  await flush();
};

beforeEach(() => {
  resetSampleConversion();
  io.composer = null;
  io.agents = [CODEX];
  io.statuses = [{ id: 'codex', status: 'available' }];
  io.installing = new Set();
  io.key = { version: 1, dismissed: false };
  io.directory = '/Users/p/projects';
  io.taken = new Set();
  io.listed = new Set();
  io.projects = new Map();
  io.signedIn = 'u';
  for (const mock of [io.record, io.dismiss, io.createProject, io.ensureMounted, io.inspect, io.writeFile, io.navigate, io.forget, io.logError, io.toast, io.setComposerVerb, io.openChat]) mock.mockReset();
  let created = 0;
  io.createProject.mockImplementation(async () => {
    const projectId = `project-${++created}`;
    io.listed.add(`chat-of-${projectId}`);
    return projectId;
  });
  io.inspect.mockImplementation(async (path: string) => ({ isDirectory: io.taken.has(path), isGitRepo: false }));
  io.writeFile.mockResolvedValue({ success: true, data: { success: true, bytesWritten: 1 } });
  composerDrafts.set(SAMPLE_DRAFT_KEY, typed);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  composerDrafts.discard(SAMPLE_DRAFT_KEY);
  composerDrafts.discard(groupDraftKey('chat-of-project-1'));
});

describe('the sample project\'s composer (#2569)', () => {
  it('is the new-task composer with no project yet, its draft kept under the sample, nothing in its way', async () => {
    await render();
    expect(host.querySelector('[data-testid="new-task-composer"]')).not.toBeNull();
    expect(io.composer).toMatchObject({ projectId: undefined, draftKey: SAMPLE_DRAFT_KEY, blocked: false, blockReason: null });
    expect(io.composer?.sendWithoutProject).toBeTypeOf('function');
    expect(text()).not.toContain('projects.sample.note');
  });

  it('no agent ready: says so in words and holds the send', async () => {
    io.statuses = [{ id: 'codex', status: 'not-installed' }];
    await render();
    expect(io.composer?.blockReason).toBe('projects.sample.convert.noAgent');
  });

  it('the picked agent still installing: says it is installing and holds the send, without calling it an error', async () => {
    io.statuses = [{ id: 'codex', status: 'not-installed' }];
    io.installing = new Set(['codex']);
    await render();
    expect(io.composer).toMatchObject({ blocked: true, blockReason: null });
    expect(host.querySelector('[data-sample-composer-status]')?.textContent).toBe('projects.sample.convert.installing{agents=Codex}');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('agent readings not back yet: says nothing (no flash of "no agent")', async () => {
    io.statuses = undefined;
    await render();
    expect(io.composer).toMatchObject({ blocked: false, blockReason: null });
  });

  it('sending makes the group with its folder in the default directory beside a taken name, writes the three files, and hands the message over', async () => {
    io.taken.add('/Users/p/projects/周末去杭州');
    await render();
    await send();
    expect(io.createProject).toHaveBeenCalledWith({ name: '周末去杭州 2', machine: null, path: '/Users/p/projects/周末去杭州 2', create: true });
    expect(io.writeFile.mock.calls.map(([workspaceId, name, body]) => [workspaceId, name, body])).toEqual(
      zhCNSampleProject.files.map((file) => ['project-1', file.name, file.text]),
    );
    expect(io.record.mock.calls.map(([became]) => became)).toEqual([{ projectId: 'project-1' }, { projectId: 'project-1', chatId: 'chat-of-project-1' }]);
    // The typed message now belongs to the group's new-task box, with the sample's request and files as context.
    const moved = composerDrafts.forKey(groupDraftKey('chat-of-project-1'));
    expect(moved.prompt).toBe(typed);
    expect(moved.handoff).toMatchObject({ sendWhenReady: true, picked: input });
    const request = zhCNSampleProject.messages.find((message) => message.kind === 'task');
    expect(moved.handoff?.hiddenContext).toContain(request && 'text' in request ? request.text : 'missing request');
    for (const file of zhCNSampleProject.files) expect(moved.handoff?.hiddenContext).toContain(file.name);
    expect(io.navigate).toHaveBeenCalledWith('chat', { chatId: 'chat-of-project-1' });
    expect(io.forget).toHaveBeenCalledOnce();
    expect(sampleConversion).toMatchObject({ owner: 'u', status: 'handed-off', chatId: 'chat-of-project-1' });
    // #2589 review 5: dismissed on the account at the hand-off, ❌ left to the task's in-memory completion.
    expect(io.dismiss).toHaveBeenCalledOnce();
  });

  it('a dismissal that fails after the hand-off is said in a notice that says what to do, and logged with its reason', async () => {
    io.dismiss.mockRejectedValueOnce(new Error('settings row locked'));
    await render();
    await send();
    expect(io.navigate).toHaveBeenCalledWith('chat', { chatId: 'chat-of-project-1' });
    expect(io.toast).toHaveBeenCalledWith({ tier: 'error', title: 'projects.sample.dismissFailed', description: 'projects.sample.dismissFailedHint' });
    expect(JSON.stringify(io.logError.mock.calls)).toContain('settings row locked');
  });

  // #2589 review 8
  it('a regular file where the folder would go counts as taken: the project goes to the next name', async () => {
    io.inspect.mockImplementation(async (path: string) => (path === '/Users/p/projects/周末去杭州'
      ? { isDirectory: false, isGitRepo: false, isFile: true } : { isDirectory: false, isGitRepo: false }));
    await render();
    await send();
    expect(io.createProject).toHaveBeenCalledWith({ name: '周末去杭州 2', machine: null, path: '/Users/p/projects/周末去杭州 2', create: true });
  });

  // #2589 review 2
  it('on another computer than the one that made it: opens that project\'s group with the message in its new-task box; makes nothing', async () => {
    io.key = { version: 2, dismissed: false, projectId: 'project-on-the-laptop', chatId: 'chat-of-the-laptop-project' };
    io.listed.add('chat-of-the-laptop-project');
    await render();
    await send();
    expect(io.createProject).not.toHaveBeenCalled();
    expect(io.setComposerVerb).toHaveBeenCalledWith('chat-of-the-laptop-project', 'task', typed, { name: '周末去杭州', joinable: true, inGroup: true });
    expect(io.openChat).toHaveBeenCalledWith('chat-of-the-laptop-project', false);
    expect(io.forget).toHaveBeenCalledOnce();
    expect(io.dismiss).toHaveBeenCalledOnce();
    expect(composerDrafts.get(SAMPLE_DRAFT_KEY)).toBe('');
  });

  // #2589 review 1
  it('another account signed in here than the one whose sample it is: nothing is made', async () => {
    io.signedIn = 'someone-else';
    await render();
    await send();
    expect(io.createProject).not.toHaveBeenCalled();
    expect(io.navigate).not.toHaveBeenCalled();
    expect(sampleConversionOf('u')).toMatchObject({ status: 'idle', failure: null });
  });

  it('another account\'s failed conversion is not shown under this account\'s box', async () => {
    io.directory = '';
    await render();
    await send();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => root.render(<SampleComposer ownerId="v" content={zhCNSampleProject} />));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(io.composer?.blocked).toBe(false);
  });

  it('no default projects directory: says so under the box, keeps the message, creates nothing; sending again after setting one goes on', async () => {
    io.directory = '';
    await render();
    await send();
    const alert = host.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.dataset.sampleComposerFailure).toBe('no-default-directory');
    expect(alert?.textContent).toBe('projects.sample.convert.noDirectory');
    expect(io.createProject).not.toHaveBeenCalled();
    expect(composerDrafts.get(SAMPLE_DRAFT_KEY)).toBe(typed);
    io.directory = '/Users/p/projects';
    await send();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(io.createProject).toHaveBeenCalledOnce();
  });

  it('while it works, the send is held and the box says what is happening', async () => {
    let finish!: (value: unknown) => void;
    io.createProject.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render();
    await send();
    expect(io.composer?.blocked).toBe(true);
    expect(host.querySelector('[data-sample-composer-status]')?.textContent).toBe('projects.sample.convert.working');
    io.listed.add('chat-of-project-1');
    await act(async () => finish('project-1'));
    await flush();
    expect(sampleConversion.status).toBe('handed-off');
  });
});
