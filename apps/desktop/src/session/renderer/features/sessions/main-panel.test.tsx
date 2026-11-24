// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ kind: 'project-error', reach: 'Lab Mac is offline' as string | null, link: 'closed', cloud: false, deviceId: 'mac-1' as string | null, presence: 'present' }));
const ensureMounted = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fill = vi.hoisted(() => vi.fn());
vi.mock('./open-session-in-session', () => ({ openSessionInSessionWhenReady: fill }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  // A listed session's store: unprovisioned until ready; a project that never mounted has none.
  getSessionPageStore: () => ['idle', 'provisioning', 'provision-error'].includes(state.kind) ? { state: 'unprovisioned', data: { projectId: 'p' } }
    : state.kind === 'ready' ? { state: 'provisioned', data: { projectId: 'p' } } : undefined,
  sessionViewKind: () => state.kind,
  getSessionManagerStore: () => ({}), sessionErrorMessage: () => 'Connection lost',
}));
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useSessionViewContext: () => ({ projectId: 'p', sessionId: 's' }), useWorkspaceViewModel: () => ({}),
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ ensureMounted }) }));
vi.mock('@renderer/features/projects/project-presence', () => ({ projectPresence: () => state.presence }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => ({ label: 'Lab Mac', lastSeenAt: null }), connectionState: () => 'offline', cloudScope: () => state.cloud ? { state: 'asleep' } : null, findListedSession: () => { throw new Error('Input eligibility must not read the directory'); } } }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => state.deviceId } }));
vi.mock('@renderer/lib/machine-clients', () => ({ machineLinkState: () => state.link }));
vi.mock('./workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => state.reach }));
vi.mock('./use-cloud-computer-gate', () => ({ useCloudComputerGate: () => state.cloud ? { label: 'Cloud', deviceId: 'mac-1', failure: null } : null }));
vi.mock('./session-tab-registry', () => ({ sessionTabView: {} }));
vi.mock('./view/session-main-column', () => ({ SessionMainColumn: () => null }));
vi.mock('@renderer/lib/ui/button', () => ({ Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ leaveSessionView: vi.fn() }));
vi.mock('@/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: ({ label }: { label: string }) => <span>{label}</span> }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn() }) }));

import { SessionContentGate } from './main-panel';

let root: Root;
let container: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  state.kind = 'project-error'; state.reach = 'Lab Mac is offline'; state.link = 'closed'; state.cloud = false; state.deviceId = 'mac-1'; state.presence = 'present'; fill.mockClear(); ensureMounted.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = () => act(() => root.render(<SessionContentGate><span>Task workspace</span></SessionContentGate>));
/** What the block says, without its strip (the cold strip carries the machine's connection state, #2301 Q3). */
const body = () => [...container.querySelectorAll('[data-slot="cold-session-strip"]')].reduce((text, strip) => text.replace(strip.textContent ?? '', ''), container.textContent ?? '');
const stripState = () => container.querySelector('[data-slot="cold-session-strip"] [data-testid="session-machine-status"]')?.getAttribute('data-state');

// owner 11-24: one page. A session whose machine does not answer opens as its usual page (the machine's state in its strip),
// ❌ a separate offline page.
describe('a session whose machine does not answer', () => {
  it.each(['idle', 'provisioning', 'provision-error'])('draws its usual page and fills its conversation once: %s', kind => {
    state.kind = kind;
    render();
    expect(container.textContent).toBe('Task workspace');
    expect(container.querySelector('button')).toBeNull();
    expect(fill).toHaveBeenCalledExactlyOnceWith({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true });
    state.kind = 'ready'; state.reach = null; state.link = 'open';
    render();
    expect(container.textContent).toBe('Task workspace');
    expect(fill).toHaveBeenCalledOnce();
  });

  it.each(['project-mounting', 'project-error'])('says only that the machine is away when its project never mounted: %s', kind => {
    state.kind = kind;
    render();
    expect(body()).toBe('');
    expect(stripState()).toBe('device_offline');
    expect(container.querySelector('button')).toBeNull();
  });

  it('fills the conversation once the machine is back and the session ready', () => {
    state.reach = null;
    render();
    expect(stripState()).toBe('device_offline');
    expect(fill).not.toHaveBeenCalled();
    state.kind = 'ready'; state.link = 'open';
    render();
    expect(container.textContent).toBe('Task workspace');
    expect(fill).toHaveBeenCalledExactlyOnceWith({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true });
    render();
    expect(fill).toHaveBeenCalledOnce();
  });

  it('retains the ready workspace during a disconnect or reconnect', () => {
    state.kind = 'ready';
    render();
    expect(container.textContent).toBe('Task workspace');
    state.link = 'connecting';
    render();
    expect(container.textContent).toBe('Task workspace');
    expect(fill).not.toHaveBeenCalled();
  });

  it('keeps cloud wake ahead of it', () => {
    state.cloud = true;
    render();
    expect(container.textContent).toBe('remoteHost.status.waking');
  });

  it('does not fill an ordinary online task or a user-emptied layout', () => {
    state.kind = 'ready'; state.reach = null; state.link = 'open';
    render(); render();
    expect(container.textContent).toBe('Task workspace');
    expect(fill).not.toHaveBeenCalled();
  });

  it('keeps an ordinary failure actionable when the machine is connected', () => {
    state.reach = null; state.link = 'open';
    render();
    expect(container.textContent).toContain('task.setUpWorkspaceFailed');
    expect(container.querySelector('button')?.textContent).toBe('common.retry');
  });

  it('prepares with the usual progress while the machine answers', () => {
    state.kind = 'provisioning'; state.reach = null; state.link = 'open';
    render();
    expect(container.textContent).toBe('task.settingUpWorkspace');
  });
});

// #3425 A project of another machine that the table does not have yet, while only its machine's own list can say whether it exists
// (the machine's hidden task workspace is in no account copy): the guard lets the view through, and the pane must not be blank.
describe('a project of another machine that is not in the table yet', () => {
  it('says the machine is away for an unmounted project', () => {
    state.kind = 'missing'; state.presence = 'unknown';
    render();
    expect(body()).toBe('');
    expect(stripState()).toBe('device_offline');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps cloud wake ahead of it, as for an unmounted project', () => {
    state.kind = 'missing'; state.presence = 'unknown'; state.cloud = true;
    render();
    expect(container.textContent).toBe('remoteHost.status.waking');
  });

  it('does not start mounting before the project is registered; mounts when it is', () => {
    state.kind = 'missing'; state.presence = 'unknown';
    render();
    expect(ensureMounted).not.toHaveBeenCalled();
    state.kind = 'project-mounting'; state.presence = 'present';
    render();
    expect(ensureMounted).toHaveBeenCalledExactlyOnceWith('p');
  });

  it('stays empty for a project known to be gone, and for one no machine owns', () => {
    state.kind = 'missing'; state.presence = 'deleted';
    render();
    expect(container.textContent).toBe('');
    state.presence = 'unknown'; state.deviceId = null;
    render();
    expect(container.textContent).toBe('');
  });
});
