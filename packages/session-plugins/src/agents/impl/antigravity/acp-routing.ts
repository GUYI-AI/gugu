import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpSpawnContext, IAcpBehavior } from '@gugu/session-core/agents/plugins';
import { withLoopbackNoProxy } from './session-bundle';

/** ACP's resource-not-found code: the runtime's provider-session-missing recovery recognizes it. */
const ACP_RESOURCE_NOT_FOUND = -32002;

export function antigravityStore(env: Readonly<Record<string, string>>, id: string): 'antigravity-acp' | 'antigravity-cli' {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Antigravity stored conversation has an invalid id');
  }
  const root = env.GEMINI_HOME?.trim();
  if (!root) throw new Error('Antigravity stored conversation requires the managed GEMINI_HOME');
  const legacy = existsSync(join(root, 'antigravity-acp', 'conversations', `${id}.db`));
  const cli = existsSync(join(root, 'antigravity-cli', 'conversations', `${id}.db`));
  if (legacy && cli) throw new Error('Antigravity conversation exists in both stores; refuse an ambiguous resume');
  if (!legacy && !cli) {
    throw Object.assign(new Error('Antigravity stored conversation was not found in either store'), { code: ACP_RESOURCE_NOT_FOUND });
  }
  return legacy ? 'antigravity-acp' : 'antigravity-cli';
}

export const antigravitySessionProgram: NonNullable<IAcpBehavior['sessionProgram']> = ctx =>
  antigravityStore(ctx.env, ctx.providerSessionId) === 'antigravity-acp' ? 'antigravity' : undefined;

export function buildAntigravityAcpSpawn(ctx: AcpSpawnContext) {
  const legacy = ctx.authProgram === null || ctx.sessionProgram === 'antigravity';
  if (legacy) {
    const command = ctx.programs?.antigravity ?? (ctx.authProgram === null ? ctx.cli : undefined);
    if (!command) throw new Error('Antigravity legacy store requires the host-resolved agy_acp_server installation');
    return { command, args: [], env: withLoopbackNoProxy(ctx.env) };
  }
  const root = ctx.env.GEMINI_HOME?.trim();
  if (!root) throw new Error('Antigravity CLI ACP requires the managed GEMINI_HOME');
  return { command: ctx.cli, args: ['acp', '--stdio', '--gemini-dir', root], env: withLoopbackNoProxy(ctx.env) };
}
