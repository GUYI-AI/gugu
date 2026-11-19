// @vitest-environment jsdom
import { followRendererSession } from '../../../../apps/desktop/src/lib/replica';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNode, createReactHarness } from '../../../support/testHarness';
import type { UnfinishedSingleAgentOutcome } from '../../../../apps/desktop/src/lib/unfinishedSingleAgentSweep';

const h = vi.hoisted(() => ({ outcomes: [] as UnfinishedSingleAgentOutcome[], toast: vi.fn(), refresh: vi.fn(async () => {}) }));
vi.mock('../../../../apps/desktop/src/lib/unfinishedSingleAgentSweep', () => ({ sweepUnfinishedSingleAgents: async () => h.outcomes }));
vi.mock('../../../../apps/desktop/src/lib/agentProvision', () => ({ defaultResumeStore: { list: () => [] } }));
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ refreshChats: h.refresh }) }));
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: h.toast }) }));
import { UnfinishedAgentCreateSweeper } from '../../../../apps/desktop/src/components/UnfinishedAgentCreateSweeper';

let ui: ReturnType<typeof createReactHarness>;
afterEach(() => { ui.cleanup(); followRendererSession('SIGNED_OUT', null); vi.clearAllMocks(); });
async function render(outcomes: UnfinishedSingleAgentOutcome[]) {
  h.outcomes = outcomes;
  followRendererSession('SIGNED_IN', 'owner');
  ui = createReactHarness();
  await ui.render(createNode(UnfinishedAgentCreateSweeper));
}

describe('unfinished creation startup only reports failed reads', () => {
  it('refreshes a completed creation without a success toast', async () => {
    await render([{ operationId: 'ok', kind: 'completed', session: {} as Extract<UnfinishedSingleAgentOutcome, { kind: 'completed' }>['session'] }]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.toast).not.toHaveBeenCalled();
  });
  it('keeps ordinary pending creations quiet', async () => {
    await render([{ operationId: 'pending', kind: 'pending', stages: [] }]);
    expect(h.toast).not.toHaveBeenCalled();
  });
  it('shows a failed read while preserving the pending request', async () => {
    await render([{ operationId: 'error', kind: 'pending', stages: [], error: 'network down' }]);
    expect(h.toast.mock.calls.map((call) => call[1])).toEqual(['error']);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
