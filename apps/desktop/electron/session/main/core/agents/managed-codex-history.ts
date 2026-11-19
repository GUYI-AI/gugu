import { prepareCodexHistory } from '@gugu/session-plugins/agents/codex-history';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { resolveLocalAgentCli } from '@main/core/acp/transport/local-acp-process-host';
import { resolveLocalAgentSpawnEnv } from './agent-run-context';

/** Both automatic migration and manual tasks prepare the final managed root through this entry. */
export async function prepareManagedCodexHistory(
  home: ResolvedAgentHome,
  signal: AbortSignal,
  onProgress?: (progress: { phase: 'preparing' | 'history'; startedAt: number; attempt: number } | null) => void,
  verifyThreads?: readonly { id: string; path: string }[],
): Promise<void> {
  const [cli, env] = await Promise.all([
    resolveLocalAgentCli('codex', 'primary'), resolveLocalAgentSpawnEnv('codex', 'version-probe'),
  ]);
  await prepareCodexHistory({ cli, env: { ...env, CODEX_HOME: home.configRoot } }, { signal, onProgress, verifyThreads });
  signal.throwIfAborted();
}
