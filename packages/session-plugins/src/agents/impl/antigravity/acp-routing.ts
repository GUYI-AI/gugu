import { statSync } from 'node:fs';
import { join } from 'node:path';
import { MissingProviderSessionError } from '@gugu/session-core/acp';
import type { AcpSpawnContext, IAcpBehavior } from '@gugu/session-core/agents/plugins';
import { withLoopbackNoProxy } from './session-bundle';

function hasConversationDatabase(path: string): boolean {
  try {
    if (!statSync(path).isFile()) throw new Error('Antigravity conversation path is not a database file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function antigravityStore(env: Readonly<Record<string, string>>, id: string): 'antigravity-acp' | 'antigravity-cli' {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Antigravity stored conversation has an invalid id');
  }
  const root = env.GEMINI_HOME?.trim();
  if (!root) throw new Error('Antigravity stored conversation requires the managed GEMINI_HOME');
  if (!statSync(root).isDirectory()) throw new Error('Antigravity managed GEMINI_HOME is not a directory');
  const legacy = hasConversationDatabase(join(root, 'antigravity-acp', 'conversations', `${id}.db`));
  const cli = hasConversationDatabase(join(root, 'antigravity-cli', 'conversations', `${id}.db`));
  if (legacy && cli) throw new Error('Antigravity conversation exists in both stores; refuse an ambiguous resume');
  if (!legacy && !cli) throw new MissingProviderSessionError('Antigravity stored conversation was not found in either store');
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
