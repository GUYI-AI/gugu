import { replica } from '@/lib/replica';
import { events, onMachineEvent } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { ExtensionAgentStatus } from '@shared/extensions/agent-status';
import type { AppSettings } from '@shared/extensions/app-settings';
import type { EnablePlace } from '@shared/extensions/host-actions';
import { localizedManifestText, marketCategoryOf, type MarketCategory } from '@shared/extensions/catalog';
import type { MarketListItem, MarketVersionHistoryEntry } from '@shared/extensions/market';
import type { MarketListing } from '@shared/extensions/market-entries';
import { marketHome, type MarketHome } from '@shared/extensions/market-home';
import { extensionsInventoryChangedChannel, marketRefreshedChannel } from '@shared/extensions/marketEvents';
import { extensionsApiOf, LOCAL_HOST, PHONE_HOST } from './extensions-api';
import { decodeShot } from './panel/decoded-shots';

/**
 * @@@market-replicas — the App market and an installed App's pages, keyed by host (`local`, `remote:<deviceId>`, `phone`;
 * @@@client-state-model). The host's `changed` push refreshes the market models (their `watch`, one per host while shown).
 */

/** What the phone's App store answers for the market (registered by phoneMarketPage.ts). */
export type PhoneMarket = {
  shelf: () => Promise<MarketShelfFull>;
  marketListing: (args: { extensionId: string; version: string }) => Promise<{ success: true; data: MarketListing } | { success: false; error: string }>;
  marketHistory: (args: { extensionId: string }) => Promise<{ success: boolean; data?: MarketVersionHistoryEntry[]; error?: string }>;
  onRefreshed: (listener: (refreshed: { outcome: string }) => void) => () => void;
};
let phoneMarket: PhoneMarket | null = null;
export function definePhoneMarket(market: PhoneMarket): void {
  phoneMarket = market;
}
function phone(): PhoneMarket {
  if (!phoneMarket) throw new Error('The phone App store is not loaded');
  return phoneMarket;
}

function marketApiOf(hostKey: string): Pick<PhoneMarket, 'marketListing' | 'marketHistory'> {
  return hostKey === PHONE_HOST ? phone() : extensionsApiOf(hostKey);
}

// ── the shelf ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The whole shelf (every page, no search word) and how the home page arranges it. */
export type MarketShelfFull = {
  errorKind: 'unreachable' | null;
  items: MarketListItem[];
  invalid: { dirName: string; reason: string }[];
  total: number;
  page: number;
  hasMore: boolean;
  featured: MarketListItem[];
  /** `popular` null: the ranking could not be read (`rankingError`); the page says so. */
  home: Omit<MarketHome<MarketListItem>, 'featured'>;
  rankingError: string | null;
  fetchedAt: string | null;
};

/** One card of the first screen as kept across restarts: whole fields of this locale only. */
export type MarketCard = {
  id: string;
  version: string;
  name: string;
  subtitle: string;
  iconUrl: string | null;
  category: MarketCategory;
  deprecated: boolean;
  /** The language its screenshots are in (the featured card says so when it is not the reader's). */
  defaultLocale: string;
};

/** The market's first screen, kept across restarts (C2/D1/D5); a card outside `CARD_LIMITS` is left out whole (null). */
export type MarketFirstScreen = {
  featured: (MarketCard | null)[];
  featuredCount: number;
  grid: (MarketCard | null)[];
  remainingCount: number;
  categories: MarketCategory[];
};

/** `full` absent: a value restored from the snapshot, only the first screen is known. */
export type MarketShelf = { full?: MarketShelfFull; first?: MarketFirstScreen };

export const FIRST_SCREEN_FEATURED = 2;
export const FIRST_SCREEN_GRID = 9;
// Bound: per card ≤ 640 chars with keys (icon URL `market/media/<sha256>.<ext>` ≈ 120); 11 × 640 + ≈ 300 = 7,340 ≤ 7,680.
export const CARD_LIMITS = { id: 64, version: 32, name: 64, subtitle: 160, iconUrl: 160, defaultLocale: 35 } as const;

function cardOf(item: MarketListItem, locale: string): MarketCard | null {
  const text = localizedManifestText(item.manifest, locale);
  const card: MarketCard = {
    id: item.manifest.id,
    version: item.manifest.version,
    name: text.name,
    subtitle: text.subtitle,
    iconUrl: item.cloud.iconUrl,
    category: marketCategoryOf(item.manifest),
    deprecated: Boolean(item.cloud.deprecated),
    defaultLocale: item.manifest.defaultLocale,
  };
  const fits = card.id.length <= CARD_LIMITS.id && card.version.length <= CARD_LIMITS.version && card.name.length <= CARD_LIMITS.name
    && card.subtitle.length <= CARD_LIMITS.subtitle && (card.iconUrl ?? '').length <= CARD_LIMITS.iconUrl
    && card.defaultLocale.length <= CARD_LIMITS.defaultLocale;
  return fits ? card : null;
}

export function firstScreenOf(full: MarketShelfFull, locale: string): MarketFirstScreen {
  const categories: MarketCategory[] = [];
  for (const item of full.items) {
    const category = marketCategoryOf(item.manifest);
    if (!categories.includes(category)) categories.push(category);
  }
  return {
    featured: full.featured.slice(0, FIRST_SCREEN_FEATURED).map((item) => cardOf(item, locale)),
    featuredCount: full.featured.length,
    grid: full.home.remaining.slice(0, FIRST_SCREEN_GRID).map((item) => cardOf(item, locale)),
    remainingCount: full.home.remaining.length,
    categories,
  };
}

/** The install ranking; unreadable is said by the page (`rankingError`), ❌ a silent empty. */
async function readRanking(): Promise<{ scores: Map<string, number> | null; error: string | null }> {
  try {
    // Imported lazily: node tests render pages importing this module; the account client is the browser's.
    const { chatDb } = await import('@/lib/supabase');
    const { data, error } = await chatDb.rpc('market_install_ranking');
    if (error) throw error;
    return { scores: new Map(((data ?? []) as { app_id: string; score: number }[]).map((row) => [row.app_id, row.score])), error: null };
  } catch (error) {
    log.warn('market install ranking unreadable:', error);
    return { scores: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function withNew(items: MarketListItem[], more: MarketListItem[]): MarketListItem[] {
  const seen = new Set(items.map((item) => item.manifest.id));
  return [...items, ...more.filter((item) => !seen.has(item.manifest.id))];
}

async function readDesktopShelf(hostKey: string): Promise<MarketShelfFull> {
  const api = extensionsApiOf(hostKey);
  const [result, ranking] = await Promise.all([api.market({ page: 0, query: '' }), readRanking()]);
  if (!result.success || !result.data) throw new Error('market unreadable');
  for (const entry of result.data.invalid) log.warn(`extension catalog: ${entry.dirName} could not be listed: ${entry.reason}`);
  if (result.data.error) log.warn(`extension market unreachable: ${result.data.error}`);
  let items = result.data.extensions;
  let last = result.data;
  for (let page = 1; last.hasMore; page += 1) {
    const next = await api.market({ page, query: '' });
    // The home and the complete listing are read whole (a page missing would move the rows).
    if (!next.success || !next.data || next.data.errorKind) throw new Error('The complete market catalog could not be read');
    items = withNew(items, next.data.extensions);
    last = next.data;
  }
  const { featured, ...home } = marketHome(items.map((item) => ({ ...item, ...item.cloud })), ranking.scores);
  return {
    errorKind: result.data.errorKind, items, invalid: result.data.invalid, total: last.total, page: last.page, hasMore: last.hasMore,
    featured, home, rankingError: ranking.error, fetchedAt: result.data.fetchedAt ?? null,
  };
}

/** The host's `changed` push reads the market models again (one listener per host and model while shown). */
const marketFeed = {
  group: (hostKey: string) => hostKey,
  start: (_owner: string, hostKey: string) => onRefreshedOf(hostKey, (refreshed) => {
    if (refreshed.outcome === 'changed') marketChanged(hostKey, (refreshed as { fetchedAt?: string }).fetchedAt ?? null);
  }),
};

/** The phone's shelf from its App store's entries (phoneMarketPage.ts): same home rules, its own ranking read. */
export async function phoneShelfOf(items: MarketListItem[]): Promise<MarketShelfFull> {
  const ranking = await readRanking();
  const { featured, ...home } = marketHome(items.map((item) => ({ ...item, ...item.cloud })), ranking.scores);
  return { errorKind: null, items, invalid: [], total: items.length, page: 0, hasMore: false, featured, home, rankingError: ranking.error, fetchedAt: null };
}

export const marketShelf = replica({
  name: 'marketShelf',
  scope: 'device',
  read: async (_owner: string, hostKey: string, locale: string): Promise<MarketShelf> => {
    const full = hostKey === PHONE_HOST ? await phone().shelf() : await readDesktopShelf(hostKey);
    // A drawn shelf is replaced only once the new featured pictures are decoded (❌ a skeleton between two shelves).
    const drawn = marketShelf.peek(hostKey, locale);
    if (drawn.state === 'value' && drawn.value.full) {
      await Promise.all(full.featured.map((item) => featuredShot.fetch(hostKey, item.manifest.id, item.manifest.version)));
    }
    return { full };
  },
  // Opening the page reads it again (the host's own index, cheap), drawing the shelf in hand meanwhile.
  fresh: 0,
  persist: {
    maxBytes: 7680,
    maxEntries: 1,
    carry: (value: MarketShelf, hostKey: string, locale: string) =>
      hostKey.startsWith('remote:') ? undefined : !value.full ? value : value.full.errorKind ? undefined : { first: firstScreenOf(value.full, locale) },
  },
  watch: marketFeed,
});

export type MarketSearch = Pick<MarketShelfFull, 'errorKind' | 'items' | 'invalid' | 'total' | 'page' | 'hasMore'>;

/** A search on a desktop's market, its first `pages` pages (loading more = one page more, a new key). */
export const marketSearch = replica({
  name: 'marketSearch',
  scope: 'device',
  read: async (_owner: string, hostKey: string, query: string, pages: number): Promise<MarketSearch> => {
    const api = extensionsApiOf(hostKey);
    let items: MarketListItem[] = [];
    let last: Awaited<ReturnType<typeof api.market>>['data'] | undefined;
    for (let page = 0; page < pages; page += 1) {
      const next = await api.market({ page, query });
      if (!next.success || !next.data) throw new Error('market unreadable');
      items = withNew(items, next.data.extensions);
      last = next.data;
      if (!next.data.hasMore || next.data.errorKind) break;
    }
    return { errorKind: last!.errorKind, items, invalid: last!.invalid, total: last!.total, page: last!.page, hasMore: last!.hasMore };
  },
  keep: 60_000,
  watch: marketFeed,
});

/** One App as the market lists it now (a page not loaded yet, a link to an App): null = not in the market. */
export const marketEntry = replica({
  name: 'marketEntry',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<MarketListItem | null> => {
    const result = await extensionsApiOf(hostKey).marketEntry({ extensionId });
    if (!result.success) throw new Error(result.error ?? 'market entry unreadable');
    return result.data ?? null;
  },
  fresh: 60_000,
  watch: marketFeed,
});

/** A version's product page in the market (about, screenshots). `outdated`: that machine's gugu is too old to say. */
export const marketListing = replica({
  name: 'marketListing',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string, version: string): Promise<{ listing: MarketListing } | { outdated: true }> => {
    let result: Awaited<ReturnType<PhoneMarket['marketListing']>>;
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

/** The featured card's picture: the first screenshot of that version's listing, decoded (null: it has none). Not kept across restarts. */
export const featuredShot = replica({
  name: 'featuredShot',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string, version: string): Promise<{ src: string } | null> => {
    const read = await marketListing.fetch(hostKey, extensionId, version);
    const src = 'listing' in read ? read.listing.screenshots[0] : undefined;
    if (!src) return null;
    await decodeShot(src);
    return { src };
  },
  fresh: Infinity,
});

/** An App's versions in the market (newest first). Host push: the catalog changed. */
export const marketVersionHistory = replica({
  name: 'marketVersionHistory',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<MarketVersionHistoryEntry[]> => {
    const result = await marketApiOf(hostKey).marketHistory({ extensionId });
    if (!result.success || !result.data) throw new Error(result.error ?? 'history unreadable');
    return result.data;
  },
  fresh: Infinity,
  watch: marketFeed,
});

// ── an installed App (desktop hosts) ─────────────────────────────────────────────────────────────────────────────

const unwrap = <T,>(result: { success: boolean; data?: T; error?: string }, what: string): T => {
  if (!result.success || result.data === undefined) throw new Error(result.error ?? `${what} unreadable`);
  return result.data;
};

/** What an App's author declared it keeps (`settings`), as stored. Read again on every open (no push). */
export const extensionSettings = replica({
  name: 'extensionSettings',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<AppSettings> => unwrap(await extensionsApiOf(hostKey).settings({ extensionId }), 'App settings'),
});

/** Which agents and groups an App is given to (D-30). Read on open and after a change (no push). */
export const appPlaces = replica({
  name: 'appPlaces',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<EnablePlace[]> => unwrap(await extensionsApiOf(hostKey).appPlaces({ extensionId }), 'App places'),
});

/** The tools an App's program gives agents, for its installed version (null: it says none). */
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

/** The skills an App gives agents, for its installed version. */
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

/** How much this device keeps for an App. Read on open; clearing it refreshes. */
export const extensionDataBytes = replica({
  name: 'extensionDataBytes',
  scope: 'device',
  read: async (_owner: string, hostKey: string, extensionId: string): Promise<number> => unwrap(await extensionsApiOf(hostKey).appData({ extensionId }), 'App data').bytes,
});

/** #6387 Each App's agent program: how many sessions use it, why it last failed to start. Inventory push refreshes it. */
export const extensionAgentStatus = replica({
  name: 'extensionAgentStatus',
  scope: 'device',
  read: async (_owner: string, hostKey: string): Promise<Record<string, ExtensionAgentStatus>> => unwrap(await extensionsApiOf(hostKey).agentStatus(), 'agent status'),
  fresh: 60_000,
});

// ── push ────────────────────────────────────────────────────────────────────────────────────────────────────────

function onRefreshedOf(hostKey: string, listener: (refreshed: { outcome: string }) => void): () => void {
  if (hostKey === PHONE_HOST) return phone().onRefreshed(listener);
  const machine = hostKey === LOCAL_HOST ? null : hostKey.slice('remote:'.length);
  return onMachineEvent(machine, marketRefreshedChannel, listener);
}

const changedAt = new Map<string, string | null>();

/** The host's catalog changed (push or `marketRefresh` answer): read the market again, once per `fetchedAt`. */
export function marketChanged(hostKey: string, fetchedAt: string | null = null): boolean {
  if (fetchedAt !== null && changedAt.get(hostKey) === fetchedAt) return false;
  changedAt.set(hostKey, fetchedAt);
  void marketShelf.refresh(hostKey);
  void marketSearch.refresh(hostKey);
  void marketVersionHistory.refresh(hostKey);
  void marketEntry.refresh(hostKey);
  return true;
}

// This desktop's App programs changed with what is installed (main's inventory channel).
events.on(extensionsInventoryChangedChannel, () => { void extensionAgentStatus.refresh(LOCAL_HOST); });
