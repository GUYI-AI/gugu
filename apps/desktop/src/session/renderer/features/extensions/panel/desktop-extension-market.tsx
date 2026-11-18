import type { Ref } from 'react';
import { Ellipsis, LayoutGrid, Search, SquareTerminal, Zap } from '@/lib/icons';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { ASSISTANT_APP_ID } from '@shared/extensions/assistant-entry';
import { localizedManifestText, MARKET_CATEGORIES, marketCategoryOf, matchesExtensionQuery, type MarketCategory } from '@shared/extensions/catalog';
import type { ResourceContext } from '@shared/resource-actions';
import type { AppMarketState } from './app-market-content';
import { MarketCard, MarketCategoryBar, MarketGrid, type MarketCategoryChoice } from './desktop-market-cards';
import { ExtensionMonogram } from './extension-monogram';
import { ShelfMoreSkeleton } from './extension-skeletons';

const categoryIcons = { research: Search, productivity: Zap, developer: SquareTerminal, other: Ellipsis };
type ExtensionMarketFilter = 'all' | MarketCategory;
export type DesktopMarketShelf = Omit<Extract<AppMarketState, { status: 'ready' }>, 'featured' | 'home'>;

export function DesktopExtensionMarket({
  shelf, query, category, onCategoryChange, installedIds, onOpen, resourceOf, sentinelRef, stale, assistant,
}: {
  shelf: DesktopMarketShelf;
  query: string;
  category: ExtensionMarketFilter;
  onCategoryChange: (category: ExtensionMarketFilter) => void;
  installedIds: ReadonlySet<string>;
  onOpen: (item: DesktopMarketShelf['items'][number]) => void;
  resourceOf: (id: string) => ResourceContext;
  sentinelRef: Ref<HTMLDivElement>;
  stale: string | null;
  assistant?: DesktopMarketShelf['items'][number];
}) {
  const { translate, locale } = useSessionMessages();
  const categoryLabel = (key: MarketCategory) => translate(`extensions.category.${key}`);
  const categories = [...MARKET_CATEGORIES, 'other'] as const;
  const choices: MarketCategoryChoice<ExtensionMarketFilter>[] = [
    { value: 'all', icon: LayoutGrid, label: translate('extensions.marketCategoryAll') },
    ...categories.map((key) => ({ value: key, icon: categoryIcons[key], label: categoryLabel(key) })),
  ];
  const entries = shelf.items.filter((item) => item.manifest.id !== ASSISTANT_APP_ID);
  const visible = category === 'all' ? entries : entries.filter((item) => marketCategoryOf(item.manifest) === category);
  const title = query ? translate('extensions.searchResults') : category === 'all'
    ? translate('extensions.allExtensions') : categoryLabel(category);
  const total = shelf.total - Number(Boolean(assistant && matchesExtensionQuery(assistant.manifest, query)));

  return (
    <>
      <MarketCategoryBar choices={choices} selected={category} onChange={onCategoryChange} testIdPrefix="extensions-market-chip" />
      {visible.length > 0 ? (
        <MarketGrid
          title={title}
          count={visible.length}
          stale={stale}
          testId={`extensions-market-section-${query ? 'results' : category}`}
        >
          {visible.map((item) => {
            const id = item.manifest.id;
            const { name, subtitle } = localizedManifestText(item.manifest, locale);
            return (
              <MarketCard
                key={id}
                testId={`extension-card-${id}`}
                name={name}
                icon={<span className="mk-icon"><ExtensionMonogram name={name} iconDataUrl={item.cloud.iconUrl} /></span>}
                publisher={translate('extensions.official')}
                category={categoryLabel(marketCategoryOf(item.manifest))}
                description={subtitle}
                installed={installedIds.has(id)}
                deprecated={Boolean(item.cloud.deprecated)}
                onOpen={() => onOpen(item)}
                resource={resourceOf(id)}
              />
            );
          })}
        </MarketGrid>
      ) : !shelf.hasMore ? (
        <div className="mk-empty">{query ? translate('extensions.noMatch', { query }) : translate('extensions.extensionMarketEmpty')}</div>
      ) : null}
      {shelf.hasMore && (
        <div className="mk-foot" ref={sentinelRef} data-testid="extension-market-more">
          {shelf.loadingMore ? <ShelfMoreSkeleton label={translate('extensions.loading')} />
            : translate('extensions.marketShown', { shown: entries.length, total })}
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
