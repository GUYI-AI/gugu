// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Runs read before whose read again failed stay drawn and say so (❌ "last run" / "next run" drawn as current). */
const io = vi.hoisted(() => ({ latest: { state: 'unknown' } as unknown, next: { state: 'unknown' } as unknown, retry: vi.fn() }));
vi.mock('../use-automations', () => ({
  useLatestAutomationRun: () => io.latest,
  useScheduledAutomationRun: () => io.next,
  useRetryAutomationRuns: () => io.retry,
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectStore: () => undefined, projectDisplayName: () => 'Project' }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionPageStore: () => undefined, sessionAgentStatus: () => null, sessionAgentStatusDetail: () => null }));
vi.mock('@renderer/lib/components/agent-status-indicator', () => ({ AgentStatusIndicator: () => null }));
vi.mock('@renderer/lib/ui/absolute-time', () => ({ AbsoluteTime: ({ value }: { value: string }) => <time>{value}</time> }));
vi.mock('./AutomationAgentAvatar', () => ({ AutomationAgentAvatar: () => null }));

import { AutomationRow } from './AutomationRow';
import { NextRunBanner } from './NextRunBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const automation = { id: 'a-1', name: 'Daily digest', enabled: true, projectId: 'p-1', agentSessionId: null, triggerConfig: { expr: '0 9 * * *' } } as never;
const failedOver = <V,>(value: V) => ({ state: 'value', value, stale: true, error: new Error('machine unreachable') });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

describe('automation runs read before, their read again failing', () => {
  it('the row keeps its last and next run and says both failed', () => {
    io.latest = failedOver({ status: 'done', startedAt: '2026-11-15T09:00:00Z', finishedAt: null, triggerKind: 'schedule' });
    io.next = failedOver({ scheduledAt: '2026-11-17T09:00:00Z' });
    act(() => root.render(<AutomationRow automation={automation} />));
    expect(container.textContent).toContain('2026-11-15T09:00:00Z');
    expect(container.textContent).toContain('2026-11-17T09:00:00Z');
    expect(container.querySelectorAll('[data-refresh-failed]')).toHaveLength(2);
  });

  it('read and current: nothing is said', () => {
    io.latest = { state: 'value', value: null, stale: false, error: null };
    io.next = { state: 'value', value: { scheduledAt: '2026-11-17T09:00:00Z' }, stale: false, error: null };
    act(() => root.render(<AutomationRow automation={automation} />));
    expect(container.querySelector('[data-refresh-failed]')).toBeNull();
  });

  it('the banner keeps the next run and says the failure with a retry', () => {
    io.next = { ...failedOver({ scheduledAt: '2026-11-17T09:00:00Z' }), retry: io.retry };
    act(() => root.render(<NextRunBanner automationId="a-1" />));
    expect(container.textContent).toContain('2026-11-17T09:00:00Z');
    expect(container.querySelector('[data-refresh-failed]')).not.toBeNull();
    act(() => { (container.querySelector('[data-refresh-failed] button') as HTMLButtonElement).click(); });
    expect(io.retry).toHaveBeenCalled();
  });
});
