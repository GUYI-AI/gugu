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
  NewSessionComposer: ({ placeholder, verb }: { placeholder?: string | ((agent: string) => string); verb?: { tag: (agentId?: string) => React.ReactNode } }) => (
    <div data-composer-placeholder={typeof placeholder === 'function' ? placeholder('Claude') : placeholder}>{verb?.tag(undefined)}</div>
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
vi.mock('./use-machine-create-target', () => ({ machineComposerProps: () => ({}) }));
vi.mock('@renderer/features/library/library-host', () => ({ machineLibraryHost: () => ({}) }));
vi.mock('./implicit-session-home-project', () => ({ ensureImplicitSessionHomeProjectId: () => new Promise(() => {}) }));
const messageHost = vi.hoisted(() => ({ rememberedTaskProject: vi.fn(async () => null) }));
vi.mock('@renderer/lib/sessionpage-message-host', () => ({ sessionpageMessageHost: () => messageHost }));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@renderer/lib/stores/app-state', () => ({ sidebarStore: { orderedProjects: [] } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@/platform', () => ({ platform: { getLocalDeviceSelfSnapshot: async () => ({ device_id: 'mac' }) } }));

const { TaskDispatchComposer } = await import('./task-dispatch-composer');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
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
