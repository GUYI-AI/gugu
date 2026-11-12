// @vitest-environment jsdom
// #2548 the new-agent box opened from a chat's composer (mock v33 派智能体): with the desktop sidebar as one list it asks
// 「想让新智能体做点什么？」 whoever opened it, and in a group the target chip reads 「进群：<群名>」. Switch off: unchanged.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ switchOn: true }));
vi.mock('@renderer/features/sidebar/use-desktop-sidebar-v2', () => ({ useDesktopSidebarV2Switch: () => state.switchOn }));
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
vi.mock('@renderer/lib/sessionpage-message-host', () => ({ sessionpageMessageHost: () => ({}) }));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@renderer/lib/stores/app-state', () => ({ sidebarStore: { orderedProjects: [] } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@/platform', () => ({ platform: {} }));

const { TaskDispatchComposer } = await import('./task-dispatch-composer');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.switchOn = true;
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
  it('switch on, in a group: asks 想让新智能体做点什么？ and the chip reads 进群：<群名>', async () => {
    await act(async () => root.render(<TaskDispatchComposer chatId="group-1" chatName="产品讨论群" joinChat />));
    expect(placeholder()).toBe('想让新智能体做点什么？');
    expect(chip()?.textContent).toBe('进群：产品讨论群');
    expect(verbTag()).toContain('新智能体');
  });

  it("switch on: a caller's own wording (a session's 想让一个新的 X…) gives way to the same question", async () => {
    await act(async () => root.render(<TaskDispatchComposer chatId="dm-1" placeholder={(agent) => `想让一个新的 ${agent} 做点什么？`} />));
    expect(placeholder()).toBe('想让新智能体做点什么？');
    expect(chip()).toBeNull();
  });

  it('switch off: today’s words — 想让 {agent} 做点什么？, the bare group name, 新任务', async () => {
    state.switchOn = false;
    await act(async () => root.render(<TaskDispatchComposer chatId="group-1" chatName="产品讨论群" joinChat />));
    expect(placeholder()).toBe('想让 Claude 做点什么？');
    expect(chip()?.textContent).toBe('产品讨论群');
    expect(verbTag()).toContain('新任务');
  });
});
