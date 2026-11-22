import { describe, expect, it } from 'vitest';
import { withLoopbackNoProxy } from './agent-env';
import { composeAgentSpawnEnv, type AgentRunContext } from './agent-run-context';

describe('withLoopbackNoProxy', () => {
  it('adds loopback even when no proxy variable is set (some harnesses read the OS proxy instead)', () => {
    expect(withLoopbackNoProxy({})).toEqual({ NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' });
  });

  it('merges both spellings, keeps every user entry, and does not repeat loopback', () => {
    expect(withLoopbackNoProxy({ NO_PROXY: 'corp.internal, localhost', no_proxy: '.lan' })).toEqual({
      NO_PROXY: 'corp.internal,localhost,.lan,127.0.0.1,::1',
      no_proxy: 'corp.internal,localhost,.lan,127.0.0.1,::1',
    });
  });
});

describe('composeAgentSpawnEnv', () => {
  // mbp 2026-11-16: Clash global mode, ~/.zshrc exports the Clash proxy vars without NO_PROXY ⇒ claude sent
  // the host's 127.0.0.1 gateway requests through Clash to a remote node and every turn ended in 502.
  it('a user proxy from any layer never captures the host loopback services', () => {
    const ctx = {
      env: { https_proxy: 'http://127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:7890' },
      credentialEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:51570' },
    } as unknown as AgentRunContext;
    const env = composeAgentSpawnEnv(ctx, { hostInjections: [{ NO_PROXY: '.corp' }] });
    expect(env.https_proxy).toBe('http://127.0.0.1:7890');
    expect(env.NO_PROXY).toBe('.corp,localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });
});
