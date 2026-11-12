import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { copilotAuthStatus } from './auth';

type Exec = AgentAuthContext['exec'];

function ctx(env: Record<string, string>, exec: Exec): AgentAuthContext {
  return { cli: 'copilot', exec, fs: {} as AgentAuthContext['fs'], env };
}

const fail = (code: number) => Object.assign(new Error(`exit ${code}`), { code });

/** 钥匙串与 gh 各自怎么答。 */
function machine(keychain: 'present' | 'absent' | 'broken', gh: 'signed-in' | 'signed-out'): Exec {
  return vi.fn(async (command: string) => {
    if (command === 'security') {
      if (keychain === 'present') return { stdout: '', stderr: '' };
      throw fail(keychain === 'absent' ? 44 : 1);
    }
    if (command === 'gh') {
      if (gh === 'signed-in') return { stdout: '', stderr: '' };
      throw fail(1);
    }
    throw new Error(`unexpected ${command}`);
  }) as unknown as Exec;
}

describe('copilotAuthStatus (#2507)', () => {
  const platform = process.platform;
  const onMac = () => Object.defineProperty(process, 'platform', { value: 'darwin' });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  it('a GitHub token in the environment counts as signed in without touching the keychain', async () => {
    const exec = machine('absent', 'signed-out');
    expect(await copilotAuthStatus(ctx({ COPILOT_GITHUB_TOKEN: 'github_pat_x' }, exec))).toMatchObject({ kind: 'authenticated' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('all three bring-your-own-model variables count as signed in by key; two of three do not', async () => {
    onMac();
    const full = { COPILOT_PROVIDER_BASE_URL: 'https://x/v1', COPILOT_PROVIDER_API_KEY: 'k', COPILOT_MODEL: 'm' };
    expect(await copilotAuthStatus(ctx(full, machine('absent', 'signed-out')))).toEqual({ kind: 'authenticated', credentialKind: 'api-key' });
    const { COPILOT_MODEL: _model, ...partial } = full;
    expect(await copilotAuthStatus(ctx(partial, machine('absent', 'signed-out')))).toEqual({ kind: 'unauthenticated' });
  });

  it("Copilot's own login in the keychain counts as signed in", async () => {
    onMac();
    expect(await copilotAuthStatus(ctx({}, machine('present', 'signed-out')))).toMatchObject({ kind: 'authenticated' });
  });

  it("falls back to gh's login the way Copilot itself does", async () => {
    onMac();
    expect(await copilotAuthStatus(ctx({}, machine('absent', 'signed-in')))).toMatchObject({ kind: 'authenticated' });
  });

  it('nothing anywhere on a Mac is a signed-out reading', async () => {
    onMac();
    expect(await copilotAuthStatus(ctx({}, machine('absent', 'signed-out')))).toEqual({ kind: 'unauthenticated' });
  });

  it('a failed keychain query is unknown, not signed out', async () => {
    onMac();
    expect(await copilotAuthStatus(ctx({}, machine('broken', 'signed-out')))).toMatchObject({ kind: 'unknown' });
  });
});
