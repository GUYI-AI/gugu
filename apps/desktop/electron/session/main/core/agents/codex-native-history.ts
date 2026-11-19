import { eq } from 'drizzle-orm';
import { promisify } from 'node:util';
import { execFile } from '@gugu/core/local/childProcess';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { readAgentHomeMarker } from '@gugu/session-core/agents/plugins/helpers';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { ensureAgentDependenciesProbed, localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { log } from '@main/lib/logger';
import { reportAgentHomeMigrationFailure } from '../../../../error-summary-reporting-host';

import type { NativeHistoryProvider } from '@gugu/session-plugins/agents/codex-history';

let resolveProvider: () => Promise<NativeHistoryProvider> = async () => { throw new Error('Host did not install native history probe credentials'); };
export function setNativeHistoryProviderResolver(resolver: () => Promise<NativeHistoryProvider>): void { resolveProvider = resolver; }

const attempts = new Map<string, Promise<void>>();
const requested = new Set<string>();
export function startNativeCodexHistoryRelocation(home: ResolvedAgentHome | null, signal: AbortSignal): void {
  if (!home || signal.aborted) return;
  if (attempts.has(home.configRoot)) { requested.add(home.configRoot); return; }
  const attempt = (async () => {
    if (!await readAgentHomeMarker(home)) return;
    const { relocateNativeCodexHistory, readNativeHistoryLedger } = await import('@gugu/session-plugins/agents/codex-history');
    if ((await readNativeHistoryLedger(home))?.complete) return;
    const [{ resolveLocalAgentCli }, { resolveLocalAgentSpawnEnv }] = await Promise.all([
      import('@main/core/acp/transport/local-acp-process-host'), import('./agent-run-context'),
    ]);
    await ensureAgentDependenciesProbed(localDependencyManager);
    const [cli, env] = await Promise.all([resolveLocalAgentCli('codex', 'primary'), resolveLocalAgentSpawnEnv('codex', 'version-probe')]);
    const version = await promisify(execFile)(env.GUGU_CODEX_BIN?.trim() || cli, ['--version'], { env: { ...env, CODEX_HOME: home.configRoot }, signal, timeout: 30_000, encoding: 'utf8' });
    const ownedIds = new Set(db.select({ id: sessions.providerSessionId }).from(sessions).where(eq(sessions.provider, 'codex')).all()
      .flatMap(row => row.id ? [row.id] : []));
    const result = await relocateNativeCodexHistory({
      home, ownedIds, context: { cli, env }, resolveProvider, cliVersion: version.stdout, signal,
      onError: error => reportAgentHomeMigrationFailure(error, 'native-history'),
    });
    log.info('Native Codex history relocation', result.counts);
  })().catch((error: unknown) => {
    if (signal.aborted) return;
    log.error('Could not relocate native Codex history');
    reportAgentHomeMigrationFailure(error, 'native-history');
  }).finally(() => {
    attempts.delete(home.configRoot);
    if (requested.delete(home.configRoot)) startNativeCodexHistoryRelocation(home, signal);
  });
  attempts.set(home.configRoot, attempt);
}
export async function nativeCodexHistoryCounts(home: ResolvedAgentHome) {
  try {
    const { readNativeHistoryLedger, nativeHistoryCounts } = await import('@gugu/session-plugins/agents/codex-history');
    const ledger = await readNativeHistoryLedger(home);
    return ledger ? nativeHistoryCounts(ledger) : undefined;
  } catch (error) {
    reportAgentHomeMigrationFailure(error, 'native-history');
    return undefined;
  }
}
