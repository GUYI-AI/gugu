// @vitest-environment jsdom
// #2548 inner column agent rows: with `agentAvatar`, the session row's leading slot draws the agent's own face (the chat
// list's Avatar, at the slot's 14px) instead of the harness logo; the trailing status mark stays. Without an agent
// identity, or without the prop, the harness logo stays.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { presentAgentStatus, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  agentUserId: 'agent-1' as string | null,
  presentation: null as AgentStatusPresentation | null,
}));
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({
  sessionAgentBindings: { bindingFor: () => (state.agentUserId ? { agentUserId: state.agentUserId } : undefined) },
}));
vi.mock('@/lib/avatarIdentity', () => ({
  useAvatarIdentity: (id: string) => (id ? { id, type: 'agent', display_name: '定价页搭建', avatar: null, created_at: null } : null),
  useIsAssistantAvatar: () => false,
}));
vi.mock('@/hooks/useShownAgentName', () => ({ useShownAgentName: ({ name }: { name: string }) => name }));
vi.mock('@/components/chat/useAgentsOnCloudComputer', () => ({ useShownAgentStatus: () => ({ presentation: () => state.presentation }) }));
vi.mock('@/hooks/useConversationSessionSummary', () => ({ useConversationSessionSummary: () => null }));
vi.mock('@renderer/features/automations/use-session-schedules', () => ({ useSessionSchedules: () => [] }));
vi.mock('@renderer/lib/stores/use-agents', () => ({
  useAgents: () => ({ data: [{ id: 'claude', name: 'Claude Code', capabilities: { hooks: { kind: 'native' }, sessions: { fork: [] } } }] }),
}));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: ({ id }: { id: string }) => <span data-harness-icon={id} /> }));
vi.mock('./sidebar-session-title', () => ({ SidebarSessionTitle: ({ title }: { title: string }) => <span>{title}</span> }));
vi.mock('./sidebar-identity-card', () => ({
  SidebarIdentityCard: () => null,
  sidebarIdentityCard: { activeSessionId: null },
  useSidebarIdentityCardTrigger: () => ({ dismiss: () => {}, onPointerEnter: () => {}, onPointerLeave: () => {}, onPointerDown: () => {} }),
}));
vi.mock('./sidebar-store', () => ({ mountedSessionPresentation: () => null }));
vi.mock('./use-session-drop-target', () => ({ useSessionDropTarget: () => ({ over: false, bind: () => ({}) }) }));
vi.mock('./session-keyboard-nav', () => ({ sessionKeyboardNav: { cursor: null, pendingArchiveSessionId: null, syncCursorFromPointer: () => {} } }));
vi.mock('./with-mounted-session', () => ({ withMountedSession: () => {} }));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: {
    get: () => ({
      sessions: {
        get: () => ({
          data: { providerId: 'claude', title: '定价页搭建', isPinned: false, isPinnedToSidebar: false, parentSessionId: null, lastInteractedAt: null },
          status: 'idle',
          detail: null,
          seen: true,
          statusSourceFault: null,
        }),
      },
    }),
  },
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionView: () => undefined }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { currentViewId: 'chat', viewParamsStore: {} } },
  sidebarStore: {
    remoteSession: () => undefined,
    agentNameOnHoverEnabled: false,
    launchedByAssistant: () => false,
    nestedProjectLabel: () => null,
    parentOf: () => null,
    isWithin: () => false,
  },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: {} }),
  useWorkspaceSlots: () => ({ currentView: 'chat' }),
}));
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => null }));
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { isLoaded: true, appName: () => undefined } }));
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({ requestArchiveSession: () => {} }));
vi.mock('@renderer/features/sessions/set-session-parent-flow', () => ({ moveSessionUnder: () => {} }));
vi.mock('@renderer/features/sessions/fork-task', () => ({ forkTask: () => {} }));
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({ openSessionInSessionWhenReady: () => {} }));
vi.mock('@renderer/app/screen-layout-actions', () => ({
  dissolveScreenGroup: () => {},
  isScreenView: () => false,
  showSessionBeside: () => {},
  takeSessionOutOfGroup: () => {},
}));
vi.mock('@renderer/lib/commands/registry', () => ({ commandRegistry: { dispatch: () => {} } }));
vi.mock('@/platform', () => ({ platform: { writeClipboardText: () => Promise.resolve() } }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));

const { SidebarSessionItem } = await import('./sidebar-session-item');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(state, { agentUserId: 'agent-1', presentation: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = (agentAvatar: boolean) =>
  act(async () => root.render(<SidebarSessionItem projectId="proj-1" sessionId="conv-1" rowVariant="section" agentAvatar={agentAvatar} />));
const leading = () => host.querySelector('[data-session-id="conv-1"] [aria-label="sidebar.openConversation"]')!.firstElementChild as HTMLElement;
const avatar = () => host.querySelector<HTMLElement>('[data-row-agent-avatar]');
const harnessIcon = () => host.querySelector('[data-harness-icon]');

it('the leading slot is the agent avatar at 14px, not the harness logo', async () => {
  await render(true);
  expect(avatar()?.dataset.rowAgentAvatar).toBe('agent-1');
  expect(leading()).toBe(avatar());
  const face = avatar()!.firstElementChild as HTMLElement;
  expect([face.style.width, face.style.height]).toEqual(['14px', '14px']);
  // No harness badge or status badge on the face: the row's own status mark stays the only one.
  expect(avatar()!.querySelectorAll('.agent-harness-badge, .av-status__dot')).toHaveLength(0);
  expect(harnessIcon()).toBeNull();
});

it('keeps the existing trailing status mark next to the avatar', async () => {
  state.presentation = presentAgentStatus({ reading: { status: 'needs_user', detail: 'question' } });
  await render(true);
  expect(avatar()).not.toBeNull();
  expect(host.querySelector('[aria-label^="agentStatus."]')).not.toBeNull();
});

it('without an agent identity the harness logo stays', async () => {
  state.agentUserId = null;
  await render(true);
  expect(avatar()).toBeNull();
  expect(harnessIcon()?.getAttribute('data-harness-icon')).toBe('claude');
});

it('a row that does not ask for it keeps the harness logo', async () => {
  await render(false);
  expect(avatar()).toBeNull();
  expect(harnessIcon()).not.toBeNull();
});
