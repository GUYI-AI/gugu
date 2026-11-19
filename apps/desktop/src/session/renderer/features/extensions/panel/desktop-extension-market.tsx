import { useMemo, useState, type Ref } from 'react';
import { useQuery } from '@tanstack/react-query';
import { chatDb } from '@/lib/supabase';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { localizedManifestText, MARKET_CATEGORIES, marketCategoryOf, type MarketCategory } from '@shared/extensions/catalog';
import { marketHome } from '@shared/extensions/market-home';
import type { MarketListItem } from '@shared/extensions/market';
import type { ResourceContext } from '@shared/resource-actions';
import type { AppMarketState } from './app-market-content';
import { MarketCard, MarketCategoryBar, MarketFeatured, MarketGrid, useMarketFeatured, type MarketCategoryChoice } from './desktop-market-cards';
import { MarketExtensionIcon } from './market-extension-icon';
import { ShelfMoreSkeleton } from './extension-skeletons';

type ExtensionMarketFilter = 'all' | MarketCategory;
type AppSort = 'recommended' | 'newest' | 'popular';
export type DesktopMarketShelf = Omit<Extract<AppMarketState, { status: 'ready' }>, 'featured' | 'home'>;

async function readInstallRanking() {
  const { data, error } = await chatDb.rpc('market_install_ranking');
  if (error) throw error;
  return new Map(((data ?? []) as { app_id: string; score: number }[]).map(({ app_id, score }) => [app_id, score]));
}

export function DesktopExtensionMarket({
  shelf, query, category, onCategoryChange, installedIds, onOpen, resourceOf, sentinelRef, stale,
}: {
  shelf: DesktopMarketShelf;
  query: string;
  category: ExtensionMarketFilter;
  onCategoryChange: (category: ExtensionMarketFilter) => void;
  installedIds?: ReadonlySet<string>;
  onOpen: (item: MarketListItem) => void;
  resourceOf: (id: string) => ResourceContext;
  sentinelRef: Ref<HTMLDivElement>;
  stale: string | null;
}) {
  const { translate, locale } = useSessionMessages();
  const [sort, setSort] = useState<AppSort>('recommended');
  const { data: scores } = useQuery({
    queryKey: ['desktop-market-install-ranking'],
    queryFn: readInstallRanking,
    enabled: !query,
    staleTime: 60_000,
    retry: false,
  });
  const home = useMemo(() => {
    if (shelf.query || shelf.hasMore || shelf.items.some(({ cloud }) => !cloud.firstPublishedAt)) return null;
    const byId = new Map(shelf.items.map((item) => [item.manifest.id, item]));
    const result = marketHome(shelf.items.map(({ manifest, cloud }) => ({ ...cloud, manifest })), scores ?? null);
    const rows = (entries: typeof result.featured) => entries.map(({ manifest }) => byId.get(manifest.id)!);
    const extraFeatured = [...new Set([
      ...(result.popular ?? []),
      ...result.remaining.filter((entry) => entry.featured),
    ])].filter((entry) => !entry.firstRun && !result.featured.includes(entry));
    return {
      featured: rows(result.featured),
      moreFeatured: rows(extraFeatured),
      recommended: rows([...result.featured, ...result.remaining]),
      newest: rows(result.newest),
      popular: result.popular && rows(result.popular),
    };
  }, [shelf, scores]);

  const categoryLabel = (key: MarketCategory) => translate(`extensions.category.${key}`);
  const sorts: MarketCategoryChoice<AppSort>[] = [{ value: 'recommended', label: translate('extensions.recommended') }];
  if (home?.newest.length) sorts.push({ value: 'newest', label: translate('extensions.newest') });
  if (home?.popular?.length) sorts.push({ value: 'popular', label: translate('extensions.popular') });
  const activeSort = sorts.some((choice) => choice.value === sort) ? sort : 'recommended';
  const entries = query ? shelf.items : home?.[activeSort] ?? shelf.items;
  const categories = [...MARKET_CATEGORIES, 'other'] as const;
  const choices: MarketCategoryChoice<ExtensionMarketFilter>[] = [
    { value: 'all', label: translate('extensions.marketCategoryAll') },
    ...categories.filter((key) => entries.some((item) => marketCategoryOf(item.manifest) === key))
      .map((key) => ({ value: key, label: categoryLabel(key) })),
  ];
  const activeCategory = choices.some((choice) => choice.value === category) ? category : 'all';
  const featured = useMarketFeatured(home?.featured ?? [], home?.moreFeatured ?? []);
  const featuredOnPage = !query && activeSort === 'recommended' && activeCategory === 'all'
    ? featured.items : [];
  const visible = activeCategory === 'all'
    ? entries.filter((item) => !featuredOnPage.includes(item))
    : entries.filter((item) => marketCategoryOf(item.manifest) === activeCategory);
  const title = query ? translate('extensions.searchResults') : activeCategory === 'all'
    ? translate('extensions.allExtensions') : categoryLabel(activeCategory);

  const card = (item: MarketListItem, featured = false) => {
    const id = item.manifest.id;
    const { name, subtitle } = localizedManifestText(item.manifest, locale);
    return (
      <MarketCard
        key={id}
        testId={`${featured ? 'featured-extension' : 'extension'}-card-${id}`}
        name={name}
        icon={<MarketExtensionIcon name={name} iconUrl={item.cloud.iconUrl} />}
        publisher={translate('extensions.official')}
        category={categoryLabel(marketCategoryOf(item.manifest))}
        description={locale.startsWith('zh') ? subtitle.replace(/\bagents?\b/gi, '智能体') : subtitle}
        installed={installedIds?.has(id)}
        deprecated={Boolean(item.cloud.deprecated)}
        onOpen={() => onOpen(item)}
        resource={resourceOf(id)}
      />
    );
  };

  return (
    <>
      {!query && activeSort === 'recommended' && activeCategory === 'all' && home && (
        <MarketFeatured title={translate('extensions.featuredApps')} {...featured} renderCard={(item) => card(item, true)} />
      )}
      {!query && (
        <MarketCategoryBar choices={sorts} selected={activeSort} onChange={setSort} testIdPrefix="extensions-market-sort" variant="subnav" />
      )}
      {choices.length > 1 && (
        <MarketCategoryBar choices={choices} selected={activeCategory} onChange={onCategoryChange} testIdPrefix="extensions-market-chip" />
      )}
      {visible.length > 0 ? (
        <MarketGrid title={title} heading={!!query} stale={stale} testId={`extensions-market-section-${query ? 'results' : activeCategory}`}>
          {visible.map((item) => card(item))}
        </MarketGrid>
      ) : !shelf.hasMore && featuredOnPage.length === 0 ? (
        <div className="mk-empty">{query ? translate('extensions.noMatch', { query }) : translate('extensions.extensionMarketEmpty')}</div>
      ) : null}
      {shelf.hasMore && (
        <div className="mk-foot" ref={sentinelRef} data-testid="extension-market-more">
          {shelf.loadingMore ? <ShelfMoreSkeleton label={translate('extensions.loading')} />
            : translate('extensions.marketShown', { shown: entries.length, total: shelf.total })}
        </div>
      )}
      {shelf.invalid.length > 0 && (
        <ul className="xp-note-list">
          {shelf.invalid.map((entry) => (
            <li key={entry.dirName}>{translate('extensions.marketInvalid', { name: entry.dirName })}</li>
          ))}
        </ul>
      )}
    </>
  );
}
