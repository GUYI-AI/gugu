import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), warn: vi.fn() }));
vi.mock('@gugu/core/local/childProcess', () => ({ fork: mocks.fork }));
vi.mock('@main/lib/logger', () => ({ log: { warn: mocks.warn } }));
vi.mock('../../worker-manifest', () => ({ desktopWorkerPath: () => '/worker.cjs' }));
import { readCodexTasks } from './codex-task-process';

let child: EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; stderr: { resume: () => void } };
beforeEach(() => {
  vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn(), stderr: { resume() {} } });
  mocks.fork.mockReturnValue(child);
});

it.each(['exit', 'invalid-reply', 'spawn'] as const)('codes a %s failure and logs the complete source root', async kind => {
  const request = readCodexTasks('/private/source', new AbortController().signal);
  if (kind === 'spawn') child.emit('error', new Error('spawn /private/worker EACCES'));
  if (kind === 'invalid-reply') child.emit('message', { invalid: true });
  child.emit('close', kind === 'exit' ? 1 : 0);
  await expect(request).rejects.toThrow(/^codex-import-source-unreadable:$/);
  expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sourceRoot: '/private/source' }));
});

it('propagates cancellation without turning it into a read failure', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled by caller');
  const request = readCodexTasks('/private/source', controller.signal);
  controller.abort(reason);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  child.emit('close', null);
  await expect(request).rejects.toBe(reason);
  expect(mocks.warn).not.toHaveBeenCalled();
});
