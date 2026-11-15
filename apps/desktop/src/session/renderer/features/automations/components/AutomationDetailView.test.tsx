// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 4 Q2 (cell U2 / AP10): a stored automation seeds its form once, its agent only from the machine's agent list.
 * The form is not mounted until that list is read; meanwhile the sheet holds its place.
 */
const io = vi.hoisted(() => ({
  agents: { state: 'unknown' } as { state: string; value?: unknown[] },
  formMounts: vi.fn(),
}));
vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgents: () => io.agents }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('../use-automations', () => ({ useAutomations: () => ({ runNow: { isPending: false, mutateAsync: vi.fn() }, rename: {} }) }));
vi.mock('../useAutomationSettingsAutoSave', () => ({
  useAutomationSettingsAutoSave: (automation: unknown) => {
    io.formMounts(automation);
    return { formState: { name: 'Daily digest', setName: vi.fn() }, setCronExpr: vi.fn(), handlePromptBlur: vi.fn(), handleNameBlur: vi.fn(), saveError: null };
  },
}));
vi.mock('./NextRunBanner', () => ({ NextRunBanner: () => null }));
vi.mock('./RunHistory', () => ({ RunHistory: () => null }));
vi.mock('./AutomationSettingsFields', () => ({ AutomationSettingsFields: () => null }));
vi.mock('./sheet-header', () => ({ SheetHeader: () => null }));

import { AutomationDetailView } from './AutomationDetailView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const automation = { id: 'a-1', name: 'Daily digest', enabled: true, projectId: 'p-1', agentSessionId: null } as never;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  io.agents = { state: 'unknown' };
  io.formMounts.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

describe('AutomationDetailView — the stored form waits for the agent list', () => {
  it('holds the sheet while the agent list is unknown, then mounts the form once with the list read', () => {
    act(() => root.render(<AutomationDetailView automation={automation} onClose={() => {}} />));
    expect(io.formMounts).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="automation-detail-pending"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-unknown]').length).toBeGreaterThan(0);

    io.agents = { state: 'value', value: [{ id: 'claude' }] };
    act(() => root.render(<AutomationDetailView automation={automation} onClose={() => {}} />));
    expect(io.formMounts).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="automation-detail-pending"]')).toBeNull();
  });

  it('a list that could not be read does not hold the form (the composer says the failure)', () => {
    io.agents = { state: 'error' };
    act(() => root.render(<AutomationDetailView automation={automation} onClose={() => {}} />));
    expect(io.formMounts).toHaveBeenCalled();
  });
});
