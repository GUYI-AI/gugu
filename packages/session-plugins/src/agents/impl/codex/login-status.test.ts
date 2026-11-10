import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { provider } from './index';

/**
 * `codex login status` as the binary prints it (codex-rs/cli/src/login.rs `run_login_status`, everything on stderr):
 * a stored credential exits 0, none exits 1 with 「Not logged in」. 0.167 reworded the API-key line, and Gugu read it as
 * 「读不出」 (2026-11-10 gpu, API-key login through `codex login --with-api-key`).
 */
function ctx(result: { stderr: string } | { exitCode: number; stderr: string }): AgentAuthContext {
  return {
    cli: 'codex',
    env: {},
    exec: vi.fn(async () => {
      if ('exitCode' in result) {
        throw Object.assign(new Error(`Command failed: codex login status\n${result.stderr}`), { code: result.exitCode, stdout: '', stderr: result.stderr });
      }
      return { stdout: '', stderr: result.stderr };
    }),
    fs: {
      read: vi.fn(async (path: string) => (path === '.codex/auth.json' ? '{"auth_mode":"apikey"}' : null)),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  };
}

const checkStatus = (context: AgentAuthContext) => provider.behavior.auth!.checkStatus!(context);

describe('codex login status', () => {
  it('reads a 0.167 API-key login as configured', async () => {
    await expect(checkStatus(ctx({ stderr: 'API key configured - sk-test-***23456\nAuthentication is checked when you send a request.\n' })))
      .resolves.toMatchObject({ kind: 'authenticated', credentialKind: 'api-key' });
  });

  it('still reads the older wording', async () => {
    await expect(checkStatus(ctx({ stderr: 'Logged in using an API key - sk-test-***23456\n' })))
      .resolves.toMatchObject({ kind: 'authenticated' });
  });

  it('reads 「Not logged in」 as signed out and an unreadable store as unknown', async () => {
    await expect(checkStatus(ctx({ exitCode: 1, stderr: 'Not logged in\n' }))).resolves.toEqual({ kind: 'unauthenticated' });
    await expect(checkStatus(ctx({ exitCode: 1, stderr: 'Error checking login status: permission denied\n' }))).resolves.toEqual({ kind: 'unknown' });
  });
});
