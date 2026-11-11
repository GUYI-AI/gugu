import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { hermesAuthStatus } from './auth';

const HOME = process.platform === 'win32' ? 'AppData/Local/hermes' : '.hermes';

function ctx(files: Record<string, unknown>, env: Record<string, string> = {}): AgentAuthContext {
  return {
    cli: 'hermes',
    env,
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) => {
        const value = files[path];
        if (value === undefined) return null;
        return typeof value === 'string' ? value : JSON.stringify(value);
      }),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  };
}

describe('hermesAuthStatus (#2507)', () => {
  it('a fresh Hermes with no config, no stored login and no key is signed out', async () => {
    expect(await hermesAuthStatus(ctx({}))).toEqual({ kind: 'unauthenticated' });
  });

  it('after `hermes auth add nous` (auth.json holds the Nous login) it is signed in by subscription', async () => {
    const auth = { version: 1, providers: { nous: { access_token: 'x' } }, active_provider: 'nous' };
    expect(await hermesAuthStatus(ctx({ [`${HOME}/auth.json`]: auth }))).toEqual({
      kind: 'authenticated',
      credentialKind: 'subscription',
    });
  });

  it('a provider key in the environment is enough, the way Hermes picks providers by credential', async () => {
    expect(await hermesAuthStatus(ctx({}, { OPENROUTER_API_KEY: 'sk-or-x' }))).toEqual({
      kind: 'authenticated',
      credentialKind: 'api-key',
    });
  });

  it('an unreadable auth.json is unknown, not signed out', async () => {
    expect((await hermesAuthStatus(ctx({ [`${HOME}/auth.json`]: '{not json' }))).kind).toBe('unknown');
  });
});
