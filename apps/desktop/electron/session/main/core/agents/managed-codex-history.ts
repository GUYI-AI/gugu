import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';

/** Both automatic migration and manual tasks prepare the final managed root through this entry. */
export async function prepareManagedCodexHistory(
  home: ResolvedAgentHome,
  signal: AbortSignal,
  onProgress?: (progress: { phase: 'preparing' | 'history'; startedAt: number; attempt: number } | null) => void,
  verifyThreads?: readonly { id: string; path: string }[],
): Promise<void> {
  // Scanning or admitting disk space must not initialize the CLI/PTY environment graph.
  const [{ prepareCodexHistory }, { resolveLocalAgentCli }, { resolveLocalAgentSpawnEnv }] = await Promise.all([
    import('@gugu/session-plugins/agents/codex-history'),
    import('@main/core/acp/transport/local-acp-process-host'),
    import('./agent-run-context'),
  ]);
  const [cli, env] = await Promise.all([
    resolveLocalAgentCli('codex', 'primary'), resolveLocalAgentSpawnEnv('codex', 'version-probe'),
  ]);
  await prepareCodexHistory({ cli, env: { ...env, CODEX_HOME: home.configRoot } }, { signal, onProgress, verifyThreads });
  signal.throwIfAborted();
}
