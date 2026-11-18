import { useState, type ReactNode } from 'react';
import {
  appCategory, connectedAppsCatalog, type AppCategoryId, type CatalogApp,
} from '@/components/assistant/connected-app-catalog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { MarketCard, MarketCategoryBar, MarketFeatured, MarketGrid, useMarketFeatured } from './desktop-market-cards';

const featuredIds = ['feishu', 'dingtalk', 'qq-mail'];

export type ConnectorMarketProps<T extends CatalogApp> = {
  apps: readonly T[];
  query: string;
  isConnectionKnown: (app: T) => boolean;
  open: (id: string) => void;
  icon: (app: T, size: number) => ReactNode;
};

export function ConnectorMarketCatalog<T extends CatalogApp>({
  apps, query, isConnectionKnown, open, icon,
}: ConnectorMarketProps<T>) {
  const { translate, locale } = useSessionMessages();
  const [category, setCategory] = useState<AppCategoryId | 'all'>('all');
  const directory = connectedAppsCatalog(apps, { tab: 'all', query, category: null }, locale);
  const choices = [
    { value: 'all' as const, label: translate('extensions.marketCategoryAll') },
    ...directory.categories.map(({ id, title }) => ({ value: id, label: title })),
  ];
  const active = choices.some(({ value }) => value === category) ? category : 'all';
  const featured = useMarketFeatured(
    featuredIds.flatMap((id) => {
      const app = directory.results.find((item) => item.id === id);
      return app ? [app] : [];
    }),
    directory.results.filter((app) => !featuredIds.includes(app.id))
  );
  const featuredOnPage = !directory.searching && active === 'all' ? featured.items : [];
  const visible = directory.results
    .filter((app) => (active === 'all' || appCategory(app) === active) && !featuredOnPage.includes(app))
    .sort((a, b) => Number(b.state === 'connected') - Number(a.state === 'connected'));
  const card = (app: T, isFeatured = false) => (
    <MarketCard
      key={app.id}
      testId={`${isFeatured ? 'featured-connector' : 'connector-market'}-card-${app.id}`}
      name={app.name}
      description={app.description}
      category={directory.categories.find(({ id }) => id === appCategory(app))?.title}
      icon={icon(app, 44)}
      installed={app.state === 'connected' ? true : isConnectionKnown(app) && !app.saved ? false : undefined}
      statusLabel={translate('integrations.deviceConnected')}
      onOpen={() => open(app.id)}
    />
  );
  return (
    <>
      {!directory.searching && active === 'all' && (
        <MarketFeatured
          title={translate('extensions.featuredConnectors')}
          {...featured}
          renderCard={(app) => card(app, true)}
        />
      )}
      {choices.length > 1 && (
        <MarketCategoryBar choices={choices} selected={active} onChange={setCategory} testIdPrefix="connector-market-chip" />
      )}
      {visible.length > 0 ? (
        <MarketGrid title={translate(directory.searching ? 'extensions.searchResults' : 'extensions.tabConnectors')} heading={directory.searching} testId="connector-market-grid">
          {visible.map((app) => card(app))}
        </MarketGrid>
      ) : featuredOnPage.length === 0 ? (
        <div className="mk-empty" role="status">{translate('extensions.noConnectors')}</div>
      ) : null}
    </>
  );
}
