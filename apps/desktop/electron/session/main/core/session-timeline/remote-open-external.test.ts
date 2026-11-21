import { describe, expect, it, vi } from 'vitest';
import {
  answerOpenExternal,
  classifyOpenTarget,
  openExternalFromMachine,
  type OpenExternalDeps,
} from './remote-open-external';
import { RemotePaneError } from './remote-pane';

function deps(overrides: Partial<OpenExternalDeps> = {}) {
  const open = vi.fn(async () => ({ opened: true as const }));
  const roots: Record<string, string> = { app: '/srv/app', web: '/srv/app/web' };
  const base: OpenExternalDeps = {
    route: { open },
    sessionRoot: async (sessionId) => roots[sessionId] ?? null,
    isFile: async () => true,
    ...overrides,
  };
  return { deps: base, open };
}

describe('open a web page from a program on this machine', () => {
  it('takes http(s) URLs and files; refuses other schemes', () => {
    expect(classifyOpenTarget('https://github.com/login/device', '/')).toEqual({ url: 'https://github.com/login/device' });
    expect(classifyOpenTarget('report.html', '/srv/app/')).toEqual({ path: '/srv/app/report.html' });
    expect(classifyOpenTarget('./out/a.html', '/srv/app')).toEqual({ path: '/srv/app/out/a.html' });
    expect(classifyOpenTarget('file:///srv/app/%E6%8A%A5%E5%91%8A.html', '/')).toEqual({ path: '/srv/app/报告.html' });
    expect(() => classifyOpenTarget('mailto:a@b.c', '/')).toThrow(/only web pages/);
    expect(() => classifyOpenTarget('  ', '/')).toThrow();
  });

  it('opens on the session named by the program environment, never one guessed from its folder', async () => {
    const { deps: d, open } = deps();
    await openExternalFromMachine({ target: 'https://x.test/', cwd: '/srv/app/web', sessionId: 'app' }, d);
    expect(open).toHaveBeenCalledWith('app', { kind: 'external', url: 'https://x.test/' }, 'pinned');
    // The socket call carries it as `open-url` sends it (GUGU_TASK_ID).
    await answerOpenExternal({ target: 'https://y.test/', cwd: '/', sessionId: 'web' }, d);
    expect(open).toHaveBeenLastCalledWith('web', { kind: 'external', url: 'https://y.test/' }, 'pinned');
  });

  // A model probe or an installer carries no session: the route reaches nobody with it (no_viewer).
  it('hands a program outside any session to the route as "", even inside a session folder', async () => {
    const { deps: d, open } = deps();
    await openExternalFromMachine({ target: 'https://sign-in.test/cli-auth', cwd: '/srv/app', sessionId: '' }, d);
    expect(open).toHaveBeenCalledWith('', { kind: 'external', url: 'https://sign-in.test/cli-auth' }, 'pinned');
  });

  it('renders a file inside the session folder in the desktop browser tab; refuses anything outside', async () => {
    const { deps: d, open } = deps();
    await openExternalFromMachine({ target: 'dist/index.html', cwd: '/srv/app/web', sessionId: 'web' }, d);
    expect(open).toHaveBeenCalledWith('web', { kind: 'browser', url: 'file:///srv/app/web/dist/index.html' }, 'pinned');
    await expect(openExternalFromMachine({ target: '/etc/passwd', cwd: '/srv/app', sessionId: 'app' }, d)).rejects.toMatchObject({
      code: 'outside_workspace',
    });
    const missing = deps({ isFile: async () => false }).deps;
    await expect(openExternalFromMachine({ target: 'nope.html', cwd: '/srv/app', sessionId: 'app' }, missing)).rejects.toMatchObject({
      code: 'not_a_file',
    });
    await expect(openExternalFromMachine({ target: 'a.html', cwd: '/srv/app', sessionId: '' }, d)).rejects.toMatchObject({
      code: 'no_session',
    });
  });

  it('answers the socket call in the device-RPC shape, queued included', async () => {
    const queued = deps({
      route: { open: async () => ({ queued: true as const }) },
    }).deps;
    await expect(answerOpenExternal({ target: 'report.html', cwd: '/srv/app', sessionId: 'app' }, queued)).resolves.toEqual({
      result: { outcome: 'queued', note: expect.stringContaining('next time') },
    });
    const failing = deps({
      route: {
        open: async () => {
          throw new RemotePaneError('no_viewer');
        },
      },
    }).deps;
    await expect(answerOpenExternal({ target: 'https://x.test/' }, failing)).resolves.toMatchObject({ error: { code: 'no_viewer' } });
    await expect(answerOpenExternal({ target: 'ftp://x' }, failing)).resolves.toMatchObject({ error: { code: 'unsupported' } });
  });
});
