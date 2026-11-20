import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('@gugu/session-core/exec', () => ({ spawnOwnedChild: mocks.spawn }));
import { prepareCodexHistory } from './subscription';

beforeEach(() => mocks.spawn.mockReset());
function server(path = '/managed/sessions/one.jsonl') {
  const requests: { method: string; params: unknown }[] = [];
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin: {
    write: (line: string) => {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.id) queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id,
        result: request.method === 'thread/read' ? { thread: { id: 'one', path } } : {},
      }) + '\n'));
    },
  } });
  const stop = vi.fn(async () => {});
  mocks.spawn.mockReturnValue({ child, stop });
  return { requests, stop };
}

it('verifies an appended task by native ID and managed path in the shared preparation process', async () => {
  const running = server();
  await prepareCodexHistory({ cli: '/bin/codex', env: { CODEX_HOME: '/managed' } }, {
    verifyThreads: [{ id: 'one', path: '/managed/sessions/one.jsonl' }],
  });
  expect(running.requests.map(row => row.method)).toEqual(['initialize', 'initialized', 'thread/read']);
  expect(running.requests.at(-1)?.params).toEqual({ threadId: 'one', includeTurns: false });
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(running.stop).toHaveBeenCalledOnce();
});

it('refuses a native read that still resolves into the source user home', async () => {
  const running = server('/user/.codex/sessions/one.jsonl');
  await expect(prepareCodexHistory({ cli: '/bin/codex', env: { CODEX_HOME: '/managed' } }, {
    verifyThreads: [{ id: 'one', path: '/managed/sessions/one.jsonl' }],
  })).rejects.toThrow('different imported session');
  expect(running.stop).toHaveBeenCalledOnce();
});

it('keeps automatic preparation initialize-only when no tasks were explicitly selected', async () => {
  const running = server();
  await prepareCodexHistory({ cli: '/bin/codex', env: { CODEX_HOME: '/managed' } });
  expect(running.requests.map(row => row.method)).toEqual(['initialize', 'initialized']);
  expect(running.stop).toHaveBeenCalledOnce();
});
