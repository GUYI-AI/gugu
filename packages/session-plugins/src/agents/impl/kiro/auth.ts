import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';

export const KIRO_LOGIN_METHOD_ID = 'kiro-login';

/**
 * Sign-in state comes from Kiro itself: `kiro-cli whoami --format json` (measured on 3.0.0).
 * Signed out it prints `{"account":null}` and exits 1. Anything else that fails, a timeout included, is unknown:
 * with `KIRO_API_KEY` set it talks to the network, and a failed instrument is not a signed-out reading.
 */
export async function kiroAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  try {
    await ctx.exec(ctx.cli, ['whoami', '--format', 'json'], { timeout: 15_000 });
    return { kind: 'authenticated' };
  } catch (error) {
    const { code, stdout } = (error ?? {}) as { code?: unknown; stdout?: unknown };
    if (code === 1 && /"account"\s*:\s*null/.test(String(stdout ?? ''))) {
      return { kind: 'unauthenticated' };
    }
    return { kind: 'unknown', message: `kiro-cli whoami failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
