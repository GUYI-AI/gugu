import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { jwtPayload, objectAt } from '../../helpers/subscription';
import { readCodexCredentials } from './credentials';
import { CODEX_NATIVE_AUTH_ENDPOINT } from '@gugu/core/local/codex-native-auth.mjs';

export type CodexCredentialKind = 'subscription' | 'api-key' | 'unknown';

export async function codexCredentialInfo(ctx: AgentAuthContext): Promise<{ kind: CodexCredentialKind; account?: string }> {
  if (!ctx.env[CODEX_NATIVE_AUTH_ENDPOINT] && ctx.env.CODEX_HOME && !ctx.fsFollowsConfigRoot) return { kind: 'unknown' };
  try {
    const parsed: unknown = await readCodexCredentials(ctx);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unknown' };
    const mode = (parsed as { auth_mode?: unknown }).auth_mode;
    if (mode === 'apikey') return { kind: 'api-key' };
    if (mode === 'chatgpt') {
      const email = jwtPayload(objectAt(parsed, 'tokens')?.id_token)?.email;
      return { kind: 'subscription', ...(typeof email === 'string' && email ? { account: email } : {}) };
    }
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}
