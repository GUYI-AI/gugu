// @vitest-environment jsdom
// #2548 the new-agent box opened from a chat's composer (mock v33 派智能体): it asks 「想让新智能体做点什么？」 whoever opened
// it, and in a group the target chip reads 「进群：<群名>」.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real zh-CN table, so the test reads the words a person sees.
vi.mock('@renderer/localization/use-session-messages', async () => {
  const { zhCNMessages } = await import('@renderer/localization/messages');
  const table = zhCNMessages as Record<string, string>;
  return {
    useSessionMessages: () => ({
      translate: (key: string, values: Record<string, string> = {}) => {
        const text = table[key];
        if (text === undefined) throw new Error(`missing ${key}`);
        return text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
      },
    }),
  };
});
vi.mock('./new-session-page', () => ({
  NewSessionComposer: ({ placeholder, verb, projectId }: { placeholder?: string | ((agent: string) => string); verb?: { tag: (agentId?: string) => React.ReactNode }; projectId?: string }) => (
    <div data-composer-placeholder={typeof placeholder === 'function' ? placeholder('Claude') : placeholder} data-send-project={projectId ?? ''}>{verb?.tag(undefined)}</div>
  ),
}));
vi.mock('./composer-tray', () => ({
  ComposerTray: ({ folderPicker, children }: { folderPicker?: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <div data-tray-folder="">{folderPicker}</div>
      {children}
    </div>
  ),
}));
vi.mock('@renderer/features/remote-hosts/use-new-session-machine', () => ({
  useNewSessionMachine: () => ({ remote: null, machineContext: null, devicePicker: null, projectPicker: null }),
}));
// The project a composer sends to (what `machineComposerProps` hands it), so a test can read where a task would go.
vi.mock('./use-machine-create-target', () => ({ machineComposerProps: (_context: unknown, props: { projectId?: string }) => ({ projectId: props.projectId }) }));
// The project picker as a button that picks one project (its menu is the tray's own component, tested there).
vi.mock('./composer-context-tray', async (original) => ({
  ...(await original<object>()),
  ComposerProjectPicker: ({ onSelect }: { onSelect: (projectId: string | undefined) => void }) => (
    <button type="button" data-testid="project-picker" onClick={() => onSelect('proj-picked')}>project</button>
  ),
}));
vi.mock('@renderer/features/projects/components/main-panel/project-folder-stage', () => ({
  useProjectFolderStage: (projectId: string) => ({
    scopedFolders: { folders: [], chosen: null }, targetProjectId: projectId, executionDevice: null, machineContext: null,
    machineOf: () => ({ label: '' }), pickAndAttach: async () => {}, runMachinePicker: null, runMachine: { created: () => {} },
  }),
}));
vi.mock('@renderer/features/projects/components/main-panel/composer-folder-picker', () => ({ ComposerFolderPicker: () => null }));
vi.mock('@renderer/features/library/library-host', () => ({ machineLibraryHost: () => ({}) }));
vi.mock('./implicit-session-home-project', async () => {
  const { replica } = await import('@/lib/replica');
  return { implicitSessionHome: replica({ name: 'implicitSessionHome', scope: 'account', read: () => new Promise<string>(() => {}), fresh: Infinity }) };
});
const messageHost = vi.hoisted(() => ({ rememberedTaskProject: vi.fn(async () => null), rememberTaskProject: vi.fn(async () => {}) }));
vi.mock('@renderer/lib/sessionpage-message-host', () => ({ sessionpageMessageHost: () => messageHost }));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@renderer/lib/stores/app-state', () => ({ sidebarStore: { orderedProjects: [] } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));

const { TaskDispatchComposer } = await import('./task-dispatch-composer');
const { followRendererSession, queryClient } = await import('@/lib/replica');
const { devicesModel } = await import('@/store/devicesCache');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  queryClient.clear();
  followRendererSession('SIGNED_IN', 'tester');
  // This computer's own row (the remembered project is kept per chat and device).
  devicesModel.set([], [{ device_id: 'mac', is_current_device: true } as never]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const placeholder = () => host.querySelector<HTMLElement>('[data-composer-placeholder]')!.dataset.composerPlaceholder;
const chip = () => host.querySelector<HTMLElement>('[data-testid="composer-birth-group"]');
const verbTag = () => host.querySelector<HTMLElement>('[data-composer-placeholder]')!.textContent;

describe('TaskDispatchComposer copy', () => {
  it('in a group: asks 想让新智能体做点什么？ and the chip reads 进群：<群名>', async () => {
    await act(async () => root.render(<TaskDispatchComposer chatId="group-1" chatName="产品讨论群" joinChat />));
    expect(placeholder()).toBe('想让新智能体做点什么？');
    expect(chip()?.textContent).toBe('进群：产品讨论群');
    expect(verbTag()).toContain('新智能体');
  });

  it('in a chat it cannot join (a DM): the same question, no group chip', async () => {
    await act(async () => root.render(<TaskDispatchComposer chatId="dm-1" />));
    // The chat's remembered project is read first (none here).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(placeholder()).toBe('想让新智能体做点什么？');
    expect(chip()).toBeNull();
  });
});

describe('#2599 the project field in a group', () => {
  it('starts empty in a group: the project picked for this chat before is not read (a project there is where the agent lives)', async () => {
    messageHost.rememberedTaskProject.mockClear();
    await act(async () => root.render(<TaskDispatchComposer chatId="group-1" chatName="产品讨论群" joinChat />));
    await act(async () => {});
    expect(messageHost.rememberedTaskProject).not.toHaveBeenCalled();
  });

  it('starts empty in a topic too: the agent does not join it, but it lives in the topic\'s group', async () => {
    messageHost.rememberedTaskProject.mockClear();
    await act(async () => root.render(<TaskDispatchComposer chatId="topic-1" chatName="定价页方案" inGroup />));
    await act(async () => {});
    expect(messageHost.rememberedTaskProject).not.toHaveBeenCalled();
  });

  it('a direct message still starts from the project picked for it before', async () => {
    messageHost.rememberedTaskProject.mockClear();
    await act(async () => root.render(<TaskDispatchComposer chatId="dm-1" />));
    await act(async () => {});
    expect(messageHost.rememberedTaskProject).toHaveBeenCalledWith('dm-1', 'mac');
  });
});

describe('the remembered project is a reading', () => {
  it('holds the box while a direct message\'s remembered project is read (❌ the machine box first, then the project\'s)', async () => {
    messageHost.rememberedTaskProject.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => root.render(<TaskDispatchComposer chatId="dm-2" />));
    expect(host.querySelector('[data-composer-placeholder]')).toBeNull();
    expect(host.querySelector('[data-unknown]')).not.toBeNull();
  });

  it('a remembered project that could not be read is said with a retry, and nothing can be sent (❌ "no project" and the implicit directory)', async () => {
    messageHost.rememberedTaskProject.mockRejectedValueOnce(new Error('host gone'));
    await act(async () => root.render(<TaskDispatchComposer chatId="dm-3" />));
    await act(async () => {});
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const failed = host.querySelector('[data-testid="task-dispatch-project-failed"]');
    expect(failed?.textContent).toContain('读不到这个对话上次用的项目');
    // No composer: the task cannot be sent anywhere until the project is known.
    expect(host.querySelector('[data-composer-placeholder]')).toBeNull();

    messageHost.rememberedTaskProject.mockResolvedValueOnce(null);
    await act(async () => { failed!.querySelector<HTMLButtonElement>('[data-read-failed] button')!.click(); });
    // react-query hands the answer over on its next notify tick.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector('[data-testid="task-dispatch-project-failed"]')).toBeNull();
    expect(host.querySelector('[data-composer-placeholder]')).not.toBeNull();
  });

  it('after a failed read the project can be picked by hand, and the task goes to the picked project', async () => {
    messageHost.rememberedTaskProject.mockRejectedValueOnce(new Error('host gone'));
    await act(async () => root.render(<TaskDispatchComposer chatId="dm-4" />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const failed = host.querySelector('[data-testid="task-dispatch-project-failed"]')!;
    // The picker sits beside the failure; with nothing picked there is no composer, so nothing can be sent.
    expect(failed.querySelector('[data-testid="project-picker"]')).not.toBeNull();
    expect(failed.querySelector('[data-read-failed]')).not.toBeNull();
    expect(host.querySelector('[data-composer-placeholder]')).toBeNull();

    await act(async () => { failed.querySelector<HTMLButtonElement>('[data-testid="project-picker"]')!.click(); });
    const composer = host.querySelector<HTMLElement>('[data-composer-placeholder]');
    expect(composer).not.toBeNull();
    expect(composer!.dataset.sendProject).toBe('proj-picked');
  });
});
