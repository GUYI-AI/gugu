import { refreshTag, replica } from '@/lib/replica';
import { events } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { ExtensionAgentStatus } from '@shared/extensions/agent-status';
import type { AppSettings } from '@shared/extensions/app-settings';
import type { EnablePlace } from '@shared/extensions/host-actions';
import type { MarketListItem, MarketVersionHistoryEntry } from '@shared/extensions/market';
import type { MarketListing } from '@shared/extensions/market-entries';
import { extensionsInventoryChangedChannel } from '@shared/extensions/marketEvents';
import { extensionsApiOf, INSTALLED, LOCAL_HOST, PHONE_HOST, phoneStore, unwrap, type PhoneStore } from './extensions-api';
import { keepShelf, keptShelfItems } from './panel/kept-shelf';

// @@@market-replicas — the App market and an installed App's pages, keyed by host (@@@client-state-model).

/** The models read from a host's market catalog: one catalog change reads them all again (`marketChanged`). */
const MARKET = 'market';

function marketApiOf(hostKey: string): Pick<PhoneStore, 'marketListing' | 'marketHistory'> {
  return hostKey === PHONE_HOST ? { marketListing: phoneStore('marketListing'), marketHistory: phoneStore('marketHistory') } : extensionsApiOf(hostKey);
}

export type MarketShelfFull = {
  errorKind: 'unreachable' | null;
  items: MarketListItem[];
  invalid: { dirName: string; reason: string }[];
  total: number;
  page: number;
  hasMore: boolean;
  fetchedAt: string | null;
};

type KeptExtra = Pick<MarketShelfFull, 'invalid' | 'total' | 'page'>;

function withNew(items: MarketListItem[], more: MarketListItem[]): MarketListItem[] {
  const seen = new Set(items.map((item) => item.manifest.id));
  return [...items, ...more.filter((item) => !seen.has(item.manifest.id))];
}

async function readDesktopShelf(hostKey: string): Promise<MarketShelfFull> {
  const api = extensionsApiOf(hostKey);
  const first = unwrap(await api.market({ page: 0, query: '' }), 'The market');
  for (const entry of first.invalid) log.warn(`extension catalog: ${entry.dirName} could not be listed: ${entry.reason}`);
  if (first.error) log.warn(`extension market unreachable: ${first.error}`);
  let items = first.extensions;
  let last = first;
  for (let page = 1; last.hasMore; page += 1) {
    const next = await api.market({ page, query: '' });
    // The complete catalog is read whole (a page missing would move the rows).
    if (!next.success || !next.data || next.data.errorKind) throw new Error('The complete market catalog could not be read');
    items = withNew(items, next.data.extensions);
    last = next.data;
  }
  return {
    errorKind: first.errorKind,
    items,
    invalid: first.invalid,
    total: last.total,
    page: last.page,
    hasMore: last.hasMore,
    fetchedAt: first.fetchedAt ?? null,
  };
}

/** A computer's complete catalog (the phone's is `phoneMarketCatalog`). The last one this page drew is the first frame after a restart (`local`, kept-shelf.ts). */
export const marketShelf = replica({
  name: 'marketShelf',
  tags: [MARKET],
  scope: 'device',
  read: async (_owner: string, hostKey: string): Promise<MarketShelfFull> => {
    const full = await readDesktopShelf(hostKey);
    if (!full.errorKind) keepShelf(hostKey, full.items, { invalid: full.invalid, total: full.total, page: full.page } satisfies KeptExtra);
    return full;
  },
  local: (_owner: string, hostKey: string): MarketShelfFull | undefined => {
    const kept = keptShelfItems<MarketListItem, KeptExtra | undefined>(hostKey);
    return kept?.extra ? { errorKind: null, items: kept.items, ...kept.extra, hasMore: false, fetchedAt: null } : undefined;
  },
  // The host's own index is cheap: opening the page reads it again.
  fresh: 0,
});

/** Recent installs per App (`chat.market_install_ranking`), for the recommended order and the featured row. */
export const marketInstallRanking = replica({
  name: 'marketInstallRanking',
  scope: 'account',
  read: async (): Promise<Map<string, number>> => {
    // Imported lazily: node tests render pages importing this module; the account client is the browser's.
    const { chatDb } = await import('@/lib/supabase');
    const { data, error } = await chatDb.rpc('market_install_ranking');
    if (error) throw error;
    return new Map(((data ?? []) as { app_id: string; score: number }[]).map(({ app_id, score }) => [app_id, score]));
  },
  fresh: 60_000,
});

type MarketSearch = Pick<MarketShelfFull, 'errorKind' | 'items' | 'invalid' | 'total' | 'page' | 'hasMore'>;

/** Loading more is a new key (`pages` + 1): only the next page is asked; a failure leaves the previous key as it is. */
export const marketSearch = replica({
  name: 'marketSearch',
  tags: [MARKET],
  scope: 'device',
  read: async (_owner: string, hostKey: string, query: string, pages: number): Promise<MarketSearch> => {
    const api = extensionsApiOf(hostKey);
    const before = pages > 1 ? marketSearch.peek(hostKey, query, pages - 1) : null;
    let found = before?.state === 'value' && before.value.hasMore && !before.value.errorKind ? before.value : null;
    for (let page = found ? pages - 1 : 0; page < pages && (!found || (found.hasMore && !found.errorKind)); page += 1) {
      const next = unwrap(await api.market({ page, query }), 'The market');
      const { extensions, errorKind, invalid, total, hasMore } = next;
      found = { errorKind, items: found ? withNew(found.items, extensions) : extensions, invalid, total, page: next.page, hasMore };
    }
    return found!;
  },
  keep: 60_000,
});

export const marketEntry = replica({
  name: 'marketEntry',
  tags: [MARKET],
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<MarketListItem | null> => {
    const result = await extensionsApiOf(hostKey).marketEntry({ extensionId });
    if (!result.success) throw new Error(result.error ?? 'market entry unreadable');
    return result.data ?? null;
  },
  fresh: 60_000,
});

/** `outdated`: that machine's gugu is too old to say. */
export const marketListing = replica({
  name: 'marketListing',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string, version: string): Promise<{ listing: MarketListing } | { outdated: true }> => {
    let result: Awaited<ReturnType<PhoneStore['marketListing']>>;
    try {
      result = await marketApiOf(hostKey).marketListing({ extensionId, version });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'server_outdated') return { outdated: true };
      throw error;
    }
    if (!result.success) throw new Error(result.error);
    return { listing: result.data };
  },
  // A version's listing never changes.
  fresh: Infinity,
});

export const marketVersionHistory = replica({
  name: 'marketVersionHistory',
  tags: [MARKET],
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<MarketVersionHistoryEntry[]> =>
    unwrap(await marketApiOf(hostKey).marketHistory({ extensionId }), 'history'),
  fresh: Infinity,
  // A transient failure is read again before it is said.
  retry: 3,
});

export const extensionSettings = replica({
  name: 'extensionSettings',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<AppSettings> =>
    unwrap(await extensionsApiOf(hostKey).settings({ extensionId }), 'App settings'),
});

/** Which agents and groups an App is given to (D-30): account scope, so an account switch never shows the last one's. */
export const appPlaces = replica({
  name: 'appPlaces',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<EnablePlace[]> => unwrap(await extensionsApiOf(hostKey).appPlaces({ extensionId }), 'App places'),
});

export const extensionAgentTools = replica({
  name: 'extensionAgentTools',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string, _version: string) => {
    const result = await extensionsApiOf(hostKey).agentTools({ extensionId });
    if (!result.success) throw new Error(result.error ?? 'tools unreadable');
    return result.data ?? null;
  },
  fresh: Infinity,
});

export const extensionAgentSkills = replica({
  name: 'extensionAgentSkills',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string, _version: string): Promise<string[]> => {
    const result = await extensionsApiOf(hostKey).agentSkills({ extensionId });
    if (!result.success) throw new Error(result.error ?? 'skills unreadable');
    return result.data ?? [];
  },
  fresh: Infinity,
});

export const extensionDataBytes = replica({
  name: 'extensionDataBytes',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<number> => unwrap(await extensionsApiOf(hostKey).appData({ extensionId }), 'App data').bytes,
});

/** #6387 Each App's agent program: how many sessions use it, why it last failed to start. */
export const extensionAgentStatus = replica({
  name: 'extensionAgentStatus',
  tags: [INSTALLED],
  scope: 'device',
  read: async (_owner: string, hostKey: string): Promise<Record<string, ExtensionAgentStatus>> => unwrap(await extensionsApiOf(hostKey).agentStatus(), 'agent status'),
  fresh: 60_000,
});

const changedAt = new Map<string, string | null>();

export function marketChanged(hostKey: string, fetchedAt: string | null = null): boolean {
  if (fetchedAt !== null && changedAt.get(hostKey) === fetchedAt) return false;
  changedAt.set(hostKey, fetchedAt);
  void refreshTag(MARKET, hostKey);
  return true;
}

events.on(extensionsInventoryChangedChannel, () => { void extensionAgentStatus.refresh(LOCAL_HOST); });
