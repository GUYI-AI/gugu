// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import type { MarketListItem } from '@shared/extensions/market';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, rpcOn: () => ({ extensions: {} }), onMachineEvent: () => () => undefined, events: { on: () => () => undefined } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn() } }));

const { CARD_LIMITS, firstScreenOf, marketShelf, phoneShelfOf } = await import('./market-replicas');
type MarketShelfFull = import('./market-replicas').MarketShelfFull;
const { queryClient } = await import('@/lib/replica');

const DEVICE_BLOCK = 'gugu.readModel.v1:device';

/** One market App with every text at the most a card keeps, in three languages. */
function item(index: number, name = `${'名'.repeat(CARD_LIMITS.name - 3)}${String(index).padStart(3, '0')}`): MarketListItem {
  const id = `app-${String(index).padStart(3, '0')}-${'x'.repeat(CARD_LIMITS.id - 8)}`;
  const subtitle = 's'.repeat(CARD_LIMITS.subtitle);
  return {
    manifest: {
      id, name, subtitle, version: '1.0.0-beta.1234567890123456789', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'zh-CN',
      categories: [['research', 'productivity', 'developer', 'other'][index % 4]!],
      localized: { en: { name: `E${name.slice(1)}`, subtitle }, ja: { name: `J${name.slice(1)}`, subtitle } },
      entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Main' }] },
    },
    ref: { extensionId: id, version: '1.0.0' },
    cloud: {
      version: '1.0.0', iconUrl: `https://apps.example.org/market/media/${'f'.repeat(CARD_LIMITS.iconUrl - 50)}.png`, deprecated: null, compat: null,
      featured: index < 5, firstRun: false, publishedAt: '2026-10-01T00:00:00Z', firstPublishedAt: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      releaseNotes: 'n'.repeat(400),
    },
  } as unknown as MarketListItem;
}

function keptEntry(): { key: unknown[]; value: unknown } | undefined {
  const block = JSON.parse(localStorage.getItem(DEVICE_BLOCK) ?? '{}') as Record<string, { key: unknown[]; value: unknown }>;
  return Object.values(block).find((entry) => entry.key[0] === marketShelf.name);
}

beforeEach(() => {
  localStorage.clear();
  queryClient.removeQueries({ queryKey: [marketShelf.name] });
});

describe('the market shelf kept across restarts (C2/D1/D5)', () => {
  it('100 Apps: the snapshot write succeeds and holds the first screen within 7,680, whatever the market lists', async () => {
    const full: MarketShelfFull = await phoneShelfOf(Array.from({ length: 100 }, (_, index) => item(index)));
    marketShelf.set(['local', 'en'], { full });
    const kept = keptEntry();
    expect(kept).toBeDefined();
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(7680);
    const first = (kept!.value as { first: ReturnType<typeof firstScreenOf> }).first;
    expect(first.featured).toHaveLength(2);
    expect(first.grid).toHaveLength(9);
    expect(first.grid.every((card) => card !== null)).toBe(true);
    expect(first.featuredCount).toBe(full.featured.length);
    expect(first.remainingCount).toBe(full.home.remaining.length);
    expect(first.categories.sort()).toEqual(['developer', 'other', 'productivity', 'research']);
    // Only the locale of the key: the English name, not the others.
    expect(first.grid[0]!.name.startsWith('E')).toBe(true);
    expect(JSON.stringify(kept)).not.toContain('releaseNotes');
  });

  it('a card whose name does not fit is left out whole (its slot a placeholder), never cut short', async () => {
    const items = Array.from({ length: 20 }, (_, index) => item(index));
    const full = await phoneShelfOf(items);
    const longId = full.home.remaining[1]!.manifest.id;
    const withLong = await phoneShelfOf(items.map((entry) => (entry.manifest.id === longId ? item(Number(longId.slice(4, 7)), 'L'.repeat(CARD_LIMITS.name + 1)) : entry)));
    const first = firstScreenOf(withLong, 'zh-CN');
    expect(first.grid[1]).toBeNull();
    expect(first.grid.filter((card) => card !== null)).toHaveLength(8);
    expect(JSON.stringify(first)).not.toContain('L'.repeat(10));
  });

  it('a restored first screen carries as it is (the same answer twice), and another desktop\'s shelf is not kept', async () => {
    const full = await phoneShelfOf(Array.from({ length: 30 }, (_, index) => item(index)));
    marketShelf.set(['phone', 'en'], { full });
    const once = keptEntry()!.value;
    localStorage.clear();
    queryClient.removeQueries({ queryKey: [marketShelf.name] });
    marketShelf.set(['phone', 'en'], once as never);
    expect(keptEntry()!.value).toEqual(once);
    // A restored value is the first screen only: readers draw it, ❌ a full shelf of nine Apps.
    expect((marketShelf.peek('phone', 'en') as { value: { full?: unknown } }).value.full).toBeUndefined();
    localStorage.clear();
    marketShelf.set(['remote:mac2', 'en'], { full });
    expect(keptEntry()).toBeUndefined();
  });

  it('a shelf that could not reach the download site is not kept', async () => {
    const full = { ...(await phoneShelfOf([item(1)])), errorKind: 'unreachable' as const };
    marketShelf.set(['local', 'en'], { full });
    expect(keptEntry()).toBeUndefined();
  });
});
