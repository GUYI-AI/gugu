import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BrowsingDataKind } from '@shared/browser';
import type { StandaloneBrowserPool, StandaloneHostCommand } from './standalone-browser-pool';

/** What a cookie import writes through; Electron's `session.cookies` has the same shape. */
export type CookieSink = {
  set(details: ImportedCookie): Promise<void>;
  flushStore(): Promise<void>;
};
export type ImportedCookie = {
  url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean;
  expirationDate?: number; sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
};

type CdpCookie = Record<string, unknown>;
/** What the built-in engine's "site data" covers; cookies and the HTTP cache are separate categories. */
const SITE_DATA_STORAGE_TYPES = 'file_systems,indexeddb,local_storage,websql,service_workers,cache_storage';
const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' } as const;

export function toCdpCookie(cookie: ImportedCookie): CdpCookie {
  return {
    name: cookie.name, value: cookie.value, url: cookie.url,
    ...(cookie.domain ? { domain: cookie.domain } : {}),
    ...(cookie.path ? { path: cookie.path } : {}),
    secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
    ...(cookie.sameSite && cookie.sameSite !== 'unspecified' ? { sameSite: SAME_SITE[cookie.sameSite] } : {}),
    ...(typeof cookie.expirationDate === 'number' ? { expires: cookie.expirationDate } : {}),
  };
}

/** A cookie as Chrome reports it → what `Storage.setCookies` accepts; session cookies keep no expiry. */
export function toCookieParam(cookie: CdpCookie): CdpCookie {
  const keep = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'];
  const param: CdpCookie = Object.fromEntries(keep.filter(key => cookie[key] !== undefined).map(key => [key, cookie[key]]));
  if (cookie.session !== true && typeof cookie.expires === 'number' && cookie.expires > 0) param.expires = cookie.expires;
  return param;
}

/** The standalone engine's side of the same data controls the built-in engine has: cookie import and clearing. */
export class StandaloneProfileData {
  constructor(private readonly options: {
    pool: StandaloneBrowserPool;
    profilesRoot: string;
    /** Every browser profile the person has, whether or not it has been opened in the standalone engine. */
    partitions(): Promise<readonly string[]>;
  }) {}

  /** One throwaway tab per import, opened by the first cookie and closed by `flushStore` so Chrome writes them to disk. */
  cookies(partition: string): CookieSink {
    let host: Promise<{ command: StandaloneHostCommand; close(): Promise<void> }> | undefined;
    return {
      set: async cookie => {
        host ??= this.options.pool.openProfileHost(partition);
        const result = await (await host).command('Network.setCookie', toCdpCookie(cookie)) as { success?: boolean };
        if (result.success === false) throw new Error('Chrome rejected the cookie');
      },
      flushStore: async () => {
        const open = host;
        host = undefined;
        if (open) await (await open).close();
      },
    };
  }

  async clear(partition: string, kind: BrowsingDataKind): Promise<void> {
    if (!await this.exists(partition)) return; // Never open Chrome just to empty a profile it has never used.
    switch (kind) {
      case 'cookies': return this.host(partition, command => command('Network.clearBrowserCookies'));
      case 'cache': return this.host(partition, command => command('Network.clearBrowserCache'));
      // A running profile keeps its tabs: Chrome clears one origin at a time, so only a dormant one can be emptied whole.
      case 'siteData': return this.options.pool.livePartitions.includes(partition) ? this.clearSiteDataInPlace(partition) : this.reset(partition, true);
      case 'all': return this.reset(partition, false);
    }
  }

  /** Every profile, including a dormant one whose Chrome is not running, and directories no profile claims any more. */
  async clearAll(kind: BrowsingDataKind): Promise<void> {
    const partitions = new Set([...await this.options.partitions(), ...this.options.pool.livePartitions]);
    for (const partition of partitions) await this.clear(partition, kind);
    if (kind !== 'all') return;
    const owned = new Set([...partitions].map(partition => path.basename(this.options.pool.directoryFor(partition))));
    for (const name of await readdir(this.options.profilesRoot).catch(() => [])) {
      if (!owned.has(name)) await rm(path.join(this.options.profilesRoot, name), { recursive: true, force: true });
    }
  }

  private async host(partition: string, operation: (command: StandaloneHostCommand) => Promise<unknown>): Promise<void> {
    const host = await this.options.pool.openProfileHost(partition);
    try { await operation(host.command); } finally { await host.close(); }
  }

  /**
   * `Storage.clearDataForOrigin` takes one origin and nothing lists the origins holding data, so this covers the sites
   * that are open or hold cookies. A site with stored data, no cookie and no open tab is left until its profile is idle.
   */
  private async clearSiteDataInPlace(partition: string): Promise<void> {
    const origins = new Set(await this.options.pool.openOrigins(partition));
    await this.host(partition, async command => {
      const { cookies = [] } = await command('Network.getAllCookies') as { cookies?: { domain?: string; secure?: boolean }[] };
      for (const { domain, secure } of cookies) {
        const host = domain?.replace(/^\./, '');
        if (!host) continue;
        origins.add(`https://${host}`);
        if (!secure) origins.add(`http://${host}`);
      }
      let failed = 0;
      for (const origin of origins) {
        await command('Storage.clearDataForOrigin', { origin, storageTypes: SITE_DATA_STORAGE_TYPES }).catch(() => { failed += 1; });
      }
      if (failed) throw new Error(`Chrome could not clear the data of ${failed} site${failed === 1 ? '' : 's'}`);
    });
  }

  /** Chrome offers no "clear all site data" command, so an idle profile is emptied; cookies may be carried over. */
  private async reset(partition: string, keepCookies: boolean): Promise<void> {
    let cookies: CdpCookie[] = [];
    if (keepCookies) {
      await this.host(partition, async command => {
        cookies = ((await command('Network.getAllCookies')) as { cookies?: CdpCookie[] }).cookies ?? [];
      });
    }
    await this.options.pool.resetProfile(partition, {
      clean: () => rm(this.options.pool.directoryFor(partition), { recursive: true, force: true }),
      restore: cookies.length ? async command => { await command('Storage.setCookies', { cookies: cookies.map(toCookieParam) }); } : undefined,
    });
  }

  private async exists(partition: string): Promise<boolean> {
    if (this.options.pool.livePartitions.includes(partition)) return true;
    return stat(this.options.pool.directoryFor(partition)).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
  }
}
