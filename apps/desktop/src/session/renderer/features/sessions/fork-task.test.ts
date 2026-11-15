import { observable, runInAction } from 'mobx';
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listed: null as Map<string, unknown> | null,
  fork: vi.fn(),
  open: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({ openSessionInSessionWhenReady: h.open }));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: () => ({ forkSession: h.fork }) } }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  asProvisioned: () => ({}), getSessionPageStore: () => ({}), getSessionManagerStore: () => ({ sessions: h.listed }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: h.toast }));
vi.mock('@/lib/userFacingError', () => ({ messageForUser: (error: Error) => error.message }));

const { forkTask } = await import('./fork-task');
const flush = () => new Promise(resolve => setTimeout(resolve));

beforeEach(() => { h.listed = observable.map<string, unknown>(); h.fork.mockReset(); h.open.mockReset(); h.toast.mockReset(); });

it('opens the fork only once the task list has it, since the view guard sends an unknown task to the empty page', async () => {
  h.fork.mockResolvedValue({ id: 'fork' });
  const navigate = vi.fn();
  forkTask({ projectId: 'p', sessionId: 'source', navigate, translate: key => key });
  await flush();
  expect(navigate.mock.calls).toEqual([['session', { projectId: 'p', sessionId: 'source' }]]);
  runInAction(() => h.listed!.set('fork', {}));
  expect(navigate).toHaveBeenLastCalledWith('session', { projectId: 'p', sessionId: 'fork' });
  expect(h.open).toHaveBeenCalledWith({ projectId: 'p', sessionId: 'fork' });
  expect(h.toast).toHaveBeenCalledWith({ title: 'sidebar.forked' });
});

it('says so when the fork fails', async () => {
  h.fork.mockRejectedValue(new Error('no'));
  forkTask({ projectId: 'p', sessionId: 'source', navigate: vi.fn(), translate: key => key });
  await flush();
  expect(h.toast).toHaveBeenCalledWith({ title: 'sidebar.forkFailed', description: 'no', variant: 'destructive' });
});
