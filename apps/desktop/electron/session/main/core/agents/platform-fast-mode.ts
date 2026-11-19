import { execFile } from '@gugu/core/local/childProcess';
import { planDirectSpawn } from '@gugu/session-core/exec';
import type { CreationFastGroup } from '@shared/core/agents/create-fast-mode';
import { log } from '@main/lib/logger';

/** Platform GPT models use the installed Codex model metadata, without a vendor login probe. */
export async function platformCreationFastGroup(provider: string, model: string,
  read: () => Promise<string> = readCodexModelMetadata): Promise<CreationFastGroup | null> {
  if (provider !== 'codex' || !model.startsWith('platform:')) return null;
  try {
    const payload: unknown = JSON.parse(await read());
    const rows = payload && typeof payload === 'object' && 'models' in payload ? payload.models : null;
    if (!Array.isArray(rows)) throw new Error('Codex bundled catalog did not contain models');
    const selected = rows.find(row => row?.slug === model.slice('platform:'.length));
    const tiers: unknown = selected?.service_tiers;
    if (!Array.isArray(tiers) || !tiers.some(tier => tier?.id === 'priority' || tier?.id === 'fast')) return null;
    return { model, selected: 'off', available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] };
  } catch (error) {
    log.warn('[platform-fast-mode] native model metadata unavailable', { provider, model, error: String(error) });
    return null;
  }
}

async function readCodexModelMetadata(): Promise<string> {
  const { resolveLocalAcpSpawnContext } = await import('../acp/transport/local-acp-process-host');
  const { cli, agentEnv } = await resolveLocalAcpSpawnContext('codex');
  const launch = planDirectSpawn(cli, ['debug', 'models', '--bundled'], { env: agentEnv });
  return new Promise((resolve, reject) => execFile(launch.command, launch.args, {
    env: launch.env ?? agentEnv, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, ...launch.spawnOverrides,
  }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
}
