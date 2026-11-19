import { app } from 'electron';
import { execFile } from '@gugu/core/local/childProcess';
import { promisify } from 'node:util';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { appSettingsService } from '../settings/settings-service';
import { log } from '@main/lib/logger';
import { events } from '@main/lib/events';
import { browserKernelSelectionChannel } from '@shared/events/browserEvents';
import { createServerTaskBrowser } from '../../../../server/server-task-browser';
import type { BrowserKernelAction, BrowserKernelKind, BrowserKernelStatus } from '@shared/browser-kernel';
import { STANDALONE_MAC_ASSET } from './standalone-kernel-catalog';
import { installStandaloneKernel, readStandaloneKernelInstallation } from './standalone-kernel-installer';
import { StandaloneKernelManager } from './standalone-kernel-manager';
import { StandaloneBrowserPool } from './standalone-browser-pool';
import { standaloneBrowserCredentialStore } from './standalone-browser-launch-policy';

const execute = promisify(execFile);

/** Device-local installation and profiles. Creating the service never downloads or starts Chrome. */
class StandaloneKernelService {
  private readonly asset = process.platform === 'darwin' && process.arch === 'arm64' ? STANDALONE_MAC_ASSET : null;
  private readonly root = path.join(app.getPath('userData'), 'BrowserKernels');
  private update: BrowserKernelStatus['update'] = null;
  readonly pool = new StandaloneBrowserPool({
    profilesRoot: path.join(app.getPath('userData'), 'StandaloneBrowserProfiles'),
    installation: () => this.installation(),
    create: ({ profile, executable }) => createServerTaskBrowser({
      binary: () => executable, profile, credentialStore: standaloneBrowserCredentialStore(process.env, app.isPackaged), log,
    }),
  });
  private readonly manager = new StandaloneKernelManager({
    asset: this.asset,
    selection: () => this.selection(),
    select: async kernel => {
      const browser = await appSettingsService.get('browser');
      await appSettingsService.update('browser', { ...browser, kernel });
      events.emit(browserKernelSelectionChannel, { kernel });
    },
    installation: () => this.installation(),
    install: ({ signal, progress }) => {
      if (!this.asset) throw new Error('Standalone Chrome is not supported on this computer');
      return installStandaloneKernel({ root: this.root, asset: this.asset, signal, progress });
    },
    remove: async () => {
      // Also preserve a version owned by another live application instance. Never reap it here.
      const processes = (await execute('/bin/ps', ['-axo', 'comm='])).stdout;
      if (processes.split('\n').some(command => command.trim().startsWith(this.root + path.sep))) {
        throw new Error('Standalone Chrome is still running. Close its tabs before deleting it.');
      }
      if (this.asset) await rm(path.join(this.root, this.asset.version), { recursive: true, force: true });
    },
    inUse: () => this.pool.inUse,
  });

  async selection(): Promise<BrowserKernelKind> {
    const value = (await appSettingsService.get('browser')).kernel;
    if (value !== undefined && value !== 'builtin' && value !== 'standalone') throw new Error('Invalid browser kernel preference');
    return value ?? 'builtin';
  }

  installation() { return this.asset ? readStandaloneKernelInstallation(this.root, this.asset) : Promise.resolve(null); }

  async hasProfiles(): Promise<boolean> {
    try { return (await readdir(path.join(app.getPath('userData'), 'StandaloneBrowserProfiles'))).length > 0; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  async status(): Promise<BrowserKernelStatus> { return { ...await this.manager.status(), update: this.update }; }

  async action(action: BrowserKernelAction): Promise<BrowserKernelStatus> {
    switch (action) {
      case 'builtin': await this.manager.useBuiltin(); break;
      case 'download-and-switch': await this.manager.downloadAndSwitch(); break;
      case 'cancel': await this.manager.cancel(); break;
      case 'remove': await this.manager.remove(); break;
      case 'check-update': {
        const response = await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json', {
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Chrome version check returned HTTP ${response.status}`);
        const body = await response.json() as { channels?: { Stable?: { version?: unknown } } };
        const version = body.channels?.Stable?.version;
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Chrome version check returned an invalid version');
        // Never download an unreviewed moving archive, even when the official channel has advanced.
        this.update = { version, reviewed: version === this.asset?.version };
        break;
      }
      default: throw new Error('Unknown browser kernel action');
    }
    return this.status();
  }
}

let service: StandaloneKernelService | undefined;
export function standaloneKernelService(): StandaloneKernelService {
  if (!service) {
    service = new StandaloneKernelService();
    app.once('will-quit', () => { void service?.pool.dispose().catch(error => log.warn('Standalone Chrome shutdown failed', { error: String(error) })); });
  }
  return service;
}
