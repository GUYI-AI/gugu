import { useMemo, type Ref } from 'react';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { localizedManifestText, MARKET_CATEGORIES, marketCategoryOf, type MarketCategory } from '@shared/extensions/catalog';
import { marketHome } from '@shared/extensions/market-home';
import type { MarketListItem } from '@shared/extensions/market';
import type { ResourceContext } from '@shared/resource-actions';
import type { MarketShelfFull } from '../market-replicas';
import { MarketCard, MarketCategoryBar, MarketGrid, type MarketCategoryChoice } from './desktop-market-cards';
import { MarketExtensionIcon } from './market-extension-icon';
import { ShelfMoreSkeleton } from './extension-skeletons';

type ExtensionMarketFilter = 'all' | MarketCategory;
/** The shelf as the page draws it: which search it is (`query`, '' = none) and whether the next page is on its way. */
export type DesktopMarketShelf = Omit<MarketShelfFull, 'fetchedAt'> & { status: 'ready'; query: string; loadingMore: boolean };

export function DesktopExtensionMarket({
  shelf, scores, query, category, onCategoryChange, installedIds, onOpen, resourceOf, sentinelRef, stale, selectedId,
}: {
  shelf: DesktopMarketShelf;
  /** Installs per App, which puts the most installed first (market-home); null = unreadable. */
  scores: ReadonlyMap<string, number> | null;
  query: string;
  category: ExtensionMarketFilter;
  onCategoryChange: (category: ExtensionMarketFilter) => void;
  installedIds?: ReadonlySet<string>;
  onOpen: (item: MarketListItem) => void;
  resourceOf: (id: string) => ResourceContext;
  sentinelRef: Ref<HTMLDivElement>;
  stale: string | null;
  /** An App's page is open beside the list: this one is marked. */
  selectedId?: string;
}) {
  const { translate, locale } = useSessionMessages();
  const home = useMemo(() => {
    if (shelf.query || shelf.hasMore || shelf.items.some(({ cloud }) => !cloud.firstPublishedAt)) return null;
    const byId = new Map(shelf.items.map((item) => [item.manifest.id, item]));
    return marketHome(shelf.items.map(({ manifest, cloud }) => ({ ...cloud, manifest })), scores ?? null)
      .map(({ manifest }) => byId.get(manifest.id)!);
  }, [shelf, scores]);

  const categoryLabel = (key: MarketCategory) => translate(`extensions.category.${key}`);
  const entries = query ? shelf.items : home ?? shelf.items;
  const categories = [...MARKET_CATEGORIES, 'other'] as const;
  const choices: MarketCategoryChoice<ExtensionMarketFilter>[] = [
    { value: 'all', label: translate('extensions.marketCategoryAll') },
    ...categories.filter((key) => entries.some((item) => marketCategoryOf(item.manifest) === key))
      .map((key) => ({ value: key, label: categoryLabel(key) })),
  ];
  const activeCategory = choices.some((choice) => choice.value === category) ? category : 'all';
  const visible = activeCategory === 'all' ? entries : entries.filter((item) => marketCategoryOf(item.manifest) === activeCategory);
  const title = query ? translate('extensions.searchResults') : activeCategory === 'all'
    ? translate('extensions.allExtensions') : categoryLabel(activeCategory);

  const card = (item: MarketListItem) => {
    const id = item.manifest.id;
    const { name, subtitle } = localizedManifestText(item.manifest, locale);
    return (
      <MarketCard
        key={id}
        testId={`extension-card-${id}`}
        name={name}
        icon={<MarketExtensionIcon name={name} iconUrl={item.cloud.iconUrl} />}
        publisher={translate('extensions.official')}
        category={categoryLabel(marketCategoryOf(item.manifest))}
        description={locale.startsWith('zh') ? subtitle.replace(/\bagents?\b/gi, '智能体') : subtitle}
        installed={installedIds?.has(id)}
        deprecated={Boolean(item.cloud.deprecated)}
        selected={id === selectedId}
        onOpen={() => onOpen(item)}
        resource={resourceOf(id)}
      />
    );
  };

  return (
    <>
      {choices.length > 1 && (
        <MarketCategoryBar choices={choices} selected={activeCategory} onChange={onCategoryChange} testIdPrefix="extensions-market-chip" />
      )}
      {visible.length > 0 ? (
        <MarketGrid title={title} heading={!!query} stale={stale} testId={`extensions-market-section-${query ? 'results' : activeCategory}`}>
          {visible.map((item) => card(item))}
        </MarketGrid>
      ) : !shelf.hasMore ? (
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
