import { searchApps } from './app-search';
import { FEATURED_COUNT, type CloudMarketEntry } from './market';

type HomeEntry = Pick<CloudMarketEntry, 'manifest' | 'version' | 'publishedAt' | 'firstPublishedAt' | 'featured' | 'firstRun' | 'deprecated' | 'compat'>;

/**
 * The market home's one order: the most installed Apps first (topped up with the official picks), then the rest newest
 * first. Deprecated Apps and those waiting on their author are left out.
 */
export function marketHome<T extends HomeEntry>(entries: readonly T[], scores: ReadonlyMap<string, number> | null): T[] {
  for (const entry of entries) {
    if (typeof entry.firstPublishedAt !== 'string' || !entry.firstPublishedAt) {
      throw new Error(`Market App ${entry.manifest.id} has no first publication date`);
    }
  }
  const eligible = entries.filter((entry) => !entry.deprecated && entry.compat?.reason !== 'needs-author-update');
  const scoreOf = (entry: T) => scores?.get(entry.manifest.id) ?? 0;
  const top = eligible
    .filter((entry) => scoreOf(entry) > 0 && !entry.firstRun)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || a.manifest.id.localeCompare(b.manifest.id))
    .slice(0, FEATURED_COUNT);
  for (const entry of eligible) {
    if (top.length >= FEATURED_COUNT) break;
    if (entry.featured && !entry.firstRun && !top.includes(entry)) top.push(entry);
  }
  const byId = new Map(eligible.map((entry) => [entry.manifest.id, entry]));
  const newest = searchApps(
    eligible.map((entry) => ({ manifest: entry.manifest, state: 'market' as const, version: entry.version, publishedAt: entry.publishedAt, firstPublishedAt: entry.firstPublishedAt })),
    { sort: 'newest' }
  ).items.map((record) => byId.get(record.manifest.id)!);
  return [...top, ...newest.filter((entry) => !top.includes(entry))];
}
