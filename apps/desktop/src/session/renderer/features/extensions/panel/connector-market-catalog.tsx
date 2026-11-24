import { useState, type ReactNode } from 'react';
import {
  appCategory, connectedAppsCatalog, type AppCategoryId, type CatalogApp,
} from '@/components/assistant/connected-app-catalog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { MarketCard, MarketCategoryBar, MarketGrid } from './desktop-market-cards';

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
  const visible = directory.results
    .filter((app) => active === 'all' || appCategory(app) === active)
    .sort((a, b) => Number(b.state === 'connected') - Number(a.state === 'connected'));
  const card = (app: T) => (
    <MarketCard
      key={app.id}
      testId={`connector-market-card-${app.id}`}
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
      {choices.length > 1 && (
        <MarketCategoryBar choices={choices} selected={active} onChange={setCategory} testIdPrefix="connector-market-chip" />
      )}
      {visible.length > 0 ? (
        <MarketGrid title={translate(directory.searching ? 'extensions.searchResults' : 'extensions.tabConnectors')} heading={directory.searching} testId="connector-market-grid">
          {visible.map((app) => card(app))}
        </MarketGrid>
      ) : (
        <div className="mk-empty" role="status">{translate('extensions.noConnectors')}</div>
      )}
    </>
  );
}
