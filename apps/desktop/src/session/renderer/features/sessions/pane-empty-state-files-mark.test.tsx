// @vitest-environment jsdom
// The task start page and the empty pane list the Files App among the built-ins with the one Files mark (the folder glyph,
// in the text colour so it follows the theme), never the App's coloured PNG; any other App keeps its own mark.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Folder } from '@/lib/icons';

const h = vi.hoisted(() => ({
  tabs: [
    { kind: 'workspace.main', extensionId: 'workspace', title: 'Files', iconDataUrl: 'data:image/png;base64,files' },
    { kind: 'notes.main', extensionId: 'notes', title: 'Notes', iconDataUrl: 'data:image/png;base64,notes' },
  ],
}));

vi.mock('@renderer/features/extensions/installed-extensions', () => ({
  WORKSPACE_APP_ID: 'workspace', LOCAL_HOST: 'local',
  useInstalledApps: () => ({ state: 'value', value: { enabledTabContributions: h.tabs }, stale: false, error: null }),
  peekInstalledAppsTracked: () => ({ allTabContributions: h.tabs }),
}));
vi.mock('@renderer/features/tabs/pane-context', () => ({ usePaneContext: () => ({ paneId: 'pane' }) }));
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useSessionViewContext: () => ({ projectId: 'project', sessionId: 'task' }),
  useWorkspaceViewModel: () => ({ paneLayout: { openBeside: vi.fn() }, openTerminalAsTab: vi.fn() }),
}));
vi.mock('@renderer/features/sessions/start-side-session', () => ({ canStartSideSession: () => true, startSideSession: vi.fn() }));
vi.mock('@renderer/features/settings/use-terminal-enabled', () => ({ useTerminalEnabled: () => ({ state: 'value', value: true }), terminalShown: () => true }));
vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgents: () => ({ state: 'value', value: [], stale: false, error: null }) }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: vi.fn() }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

const { useSessionWorkspaceActions } = await import('./pane-empty-state');

function Icons() {
  const actions = useSessionWorkspaceActions(() => {}, () => {});
  return <>{actions.map((action) => <i key={action.id} data-id={action.id}>{action.icon}</i>)}</>;
}

describe('the start page and empty pane list the Files App with the one Files mark', () => {
  it('[guard] Files draws the folder glyph, not the App PNG; another App keeps its own mark', () => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(<Icons />), 'text/html');
    const files = doc.querySelector('[data-id="workspace.main"]')!;
    const folder = new DOMParser().parseFromString(renderToStaticMarkup(<Folder />), 'text/html').querySelector('svg')!;
    expect(files.querySelector('img')).toBeNull();
    expect(files.querySelector('svg')?.innerHTML).toBe(folder.innerHTML);
    expect(doc.querySelector('[data-id="notes.main"] img')?.getAttribute('src')).toBe('data:image/png;base64,notes');
  });
});
