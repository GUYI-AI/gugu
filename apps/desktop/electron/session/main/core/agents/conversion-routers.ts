import { app } from 'electron';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '@main/lib/logger';
import { ConversionRouterPool, ConversionRouterStartError, ccSwitchCandidates, harnessBaseUrl, isConversionHarness } from './conversion-router';

// Routers stay up while the app runs: sessions hold their base URL for their whole life, and a pool entry is keyed by
// (harness, record), so a second session on the same record reuses it. They stop when the app quits.
const idleMs = 30 * 60_000;
let pool: Promise<ConversionRouterPool> | undefined;

function routerPool(): Promise<ConversionRouterPool> {
  if (!pool) {
    const started = (async () => {
      const executable = ccSwitchCandidates({
        env: process.env,
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }).find((file) => existsSync(file));
      if (!executable) throw new Error('This installation has no local conversion component for this model');
      const scratchRoot = join(app.getPath('userData'), 'conversion-routers');
      // A previous run that was killed leaves its routers' private directories behind; only this app writes here.
      await rm(scratchRoot, { recursive: true, force: true });
      return new ConversionRouterPool({ executable, scratchRoot }, idleMs, (error) => {
        log.warn('Could not stop a conversion router', { error: error instanceof Error ? error.message : String(error) });
      });
    })();
    pool = started;
    void started.catch(() => { if (pool === started) pool = undefined; });
  }
  return pool;
}

/** Base URL the harness uses for a custom model whose protocol the bundled router converts. */
export async function convertedBaseUrl(providerId: string, connectionId: string, upstream: string, relayKey: string): Promise<string> {
  if (!isConversionHarness(providerId)) throw new Error(`${providerId} cannot use a converted custom model`);
  try {
    const { router } = await (await routerPool()).acquire(providerId, connectionId, upstream, relayKey);
    return harnessBaseUrl(providerId, router);
  } catch (error) {
    if (error instanceof ConversionRouterStartError && error.phase === 'listen') {
      const { reason, phase, elapsedMs, exitCode } = error;
      log.warn('Local model protocol converter startup failed', { providerId, reason, phase, elapsedMs, exitCode });
    }
    throw error;
  }
}

export function releaseConversionRouters(): void {
  const started = pool;
  pool = undefined;
  void started?.then((routers) => routers.close()).catch((error: unknown) => {
    log.warn('Could not stop every conversion router', { error: error instanceof Error ? error.message : String(error) });
  });
}
