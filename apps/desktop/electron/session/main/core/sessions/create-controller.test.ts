import { beforeEach, expect, it, vi } from 'vitest';
import type { CreateSessionParams } from '@shared/core/sessions/create-session';

const calls = vi.hoisted(() => ({ create: vi.fn(), provision: vi.fn(), admit: vi.fn(), hold: vi.fn(), placed: vi.fn() }));
vi.mock('./session-service', () => ({ sessionService: { createSession: calls.create, provisionWorkspace: calls.provision } }));
vi.mock('./session-life-creation', () => ({ admitFirstMessages: calls.admit }));
vi.mock('./first-turn-placement', () => ({ holdFirstTurnForPlacement: calls.hold, firstTurnFilesPlaced: calls.placed }));
vi.mock('./name-generation/generateSessionName', () => ({ generateSessionName: vi.fn() }));
vi.mock('./operations/getProjectWorkspaces', () => ({ getProjectWorkspaces: vi.fn() }));
import { createAndProvision, sessionCreateController } from './create-controller';

const PAGE = 3;

const input = { projectId: 'project', sessionConfig: { initialSession: { id: 'new-task' } } } as CreateSessionParams;
beforeEach(() => {
  vi.clearAllMocks();
  calls.create.mockResolvedValue({ success: true, data: {} });
  calls.provision.mockResolvedValue({ success: true, data: { path: '/workspace', workspaceId: 'workspace' } });
  calls.admit.mockResolvedValue(undefined);
});

it('creates and prepares the task before admitting its initial turn, within one RPC', async () => {
  const result = await createAndProvision(input, { sender: PAGE });
  expect(result).toEqual({ stage: 'provision', result: { success: true, data: { path: '/workspace', workspaceId: 'workspace' } } });
  expect(calls.create).toHaveBeenCalledExactlyOnceWith(input);
  expect(calls.provision).toHaveBeenCalledExactlyOnceWith('new-task');
  expect(calls.admit).toHaveBeenCalledExactlyOnceWith('new-task');
  expect(calls.create.mock.invocationCallOrder[0]).toBeLessThan(calls.provision.mock.invocationCallOrder[0]);
  expect(calls.provision.mock.invocationCallOrder[0]).toBeLessThan(calls.admit.mock.invocationCallOrder[0]);
});

it('#2558 a task whose files are still being placed: its first turn is admitted now, only its dispatch waits for this page', async () => {
  await createAndProvision(input, { placingFiles: true, sender: PAGE });
  expect(calls.hold).toHaveBeenCalledExactlyOnceWith('new-task', PAGE);
  expect(calls.admit).toHaveBeenCalledExactlyOnceWith('new-task');
  expect(calls.hold.mock.invocationCallOrder[0], 'held before its admission can start a dispatch').toBeLessThan(calls.admit.mock.invocationCallOrder[0]);
});

it('a page from before #2558 asks the same with deferFirstTurn, and still gets its turn admitted', async () => {
  await createAndProvision(input, { deferFirstTurn: true, sender: PAGE });
  expect(calls.hold).toHaveBeenCalledExactlyOnceWith('new-task', PAGE);
  expect(calls.admit).toHaveBeenCalledExactlyOnceWith('new-task');
});

it('without files to place nothing is held', async () => {
  await createAndProvision(input, { sender: PAGE });
  expect(calls.hold).not.toHaveBeenCalled();
});

it('the page saying its placement settled lets the dispatch go; admitting again is the same single admission', async () => {
  await sessionCreateController.admitFirstMessages('new-task');
  expect(calls.placed).toHaveBeenCalledExactlyOnceWith('new-task');
  expect(calls.admit).toHaveBeenCalledExactlyOnceWith('new-task');
});

it('does not prepare or admit a task which creation refused', async () => {
  const failure = { success: false, error: { type: 'project-not-found' } };
  calls.create.mockResolvedValueOnce(failure);
  expect(await createAndProvision(input, { sender: PAGE })).toEqual({ stage: 'create', result: failure });
  expect(calls.provision).not.toHaveBeenCalled();
  expect(calls.admit).not.toHaveBeenCalled();
});

it('reports a preparation exception as an existing task, preserving the actual reason', async () => {
  calls.provision.mockRejectedValueOnce(new Error('The workspace could not be mounted'));
  expect(await createAndProvision(input, { sender: PAGE })).toEqual({ stage: 'provision-error', message: 'The workspace could not be mounted' });
  expect(calls.create).toHaveBeenCalledOnce();
  expect(calls.admit).not.toHaveBeenCalled();
});
