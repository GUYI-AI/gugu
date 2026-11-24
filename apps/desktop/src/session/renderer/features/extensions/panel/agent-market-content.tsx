import { vendorName } from '@/i18n/vendorName';
import { CircleAlert } from '@/lib/icons';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { retryOf } from '@/lib/replica';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { Button } from '@renderer/lib/ui/button';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order';
import {
  AGENT_MARKET_CATEGORIES, agentMarketCategoryOf, localizedManifestText, matchesExtensionQuery, type AgentMarketCategory,
} from '@shared/extensions/catalog';
import type { MarketListItem } from '@shared/extensions/market';
import { queryScore } from '@shared/extensions/query-score';
import type { ResourceContext } from '@shared/resource-actions';
import { MarketCard, MarketCategoryBar, MarketGrid, type MarketCategoryChoice } from './desktop-market-cards';
import { MarketExtensionIcon } from './market-extension-icon';
import { ShelfSkeleton } from './extension-skeletons';
import { marketAgentDescription } from './market-agent-description';

export type AgentMarketFilter = 'all' | AgentMarketCategory;

export function AgentMarketContent({
  query, category, onCategoryChange, onOpenAgentDetail, assistant, assistantLoading, assistantInstalled, onOpenAssistant, assistantResource,
}: {
  query: string;
  category: AgentMarketFilter;
  onCategoryChange: (category: AgentMarketFilter) => void;
  onOpenAgentDetail: (agentId: string) => void;
  assistant?: MarketListItem;
  assistantLoading: boolean;
  assistantInstalled?: boolean;
  onOpenAssistant: () => void;
  assistantResource?: ResourceContext;
}) {
  const { translate, locale } = useSessionMessages();
  const reading = useManagementAgents();
  const data = reading.state === 'value' ? reading.value : null;
  const isPending = reading.state === 'unknown';
  const isError = reading.state === 'error';
  const categoryLabel = (key: AgentMarketCategory) => translate(`extensions.agentCategory.${key}`);
  const search = query.trim();
  const agents = data ?? [];
  const rows = agents.map((agent) => ({
    agent,
    group: agentMarketCategoryOf(agent.id),
    description: marketAgentDescription(agent, locale),
  }));
  const choices: MarketCategoryChoice<AgentMarketFilter>[] = [
    { value: 'all', label: translate('extensions.marketCategoryAll') },
    ...AGENT_MARKET_CATEGORIES.filter((key) => rows.some(({ group }) => group === key) || (key === 'general' && assistant))
      .map((key) => ({ value: key, label: categoryLabel(key) })),
  ];
  const activeCategory = choices.some((choice) => choice.value === category) ? category : 'all';
  const matching = rows.filter(({ agent, group, description }) =>
    (activeCategory === 'all' || group === activeCategory) &&
    (!search || queryScore(search, [agent.name, agent.id, agent.publisher, agent.publisher && vendorName(agent.publisher), description].join('\n')))
  );
  const title = search ? translate('extensions.searchResults') : activeCategory === 'all'
    ? translate('extensions.allAgents') : categoryLabel(activeCategory);
  const assistantInResults = assistant && activeCategory !== 'coding' && matchesExtensionQuery(assistant.manifest, search);
  const assistantCard = (item: MarketListItem) => {
    const { name, subtitle } = localizedManifestText(item.manifest, locale);
    return (
      <MarketCard
        key={item.manifest.id}
        testId={`extension-card-${item.manifest.id}`}
        name={name}
        icon={<MarketExtensionIcon name={name} iconUrl={item.cloud.iconUrl} />}
        publisher={translate('extensions.official')}
        category={categoryLabel('general')}
        description={subtitle}
        installed={assistantInstalled}
        onOpen={onOpenAssistant}
        resource={assistantResource}
      />
    );
  };
  const agentCard = ({ agent, group, description }: typeof rows[number]) => (
    <MarketCard
      key={agent.id}
      testId={`agent-market-card-${agent.id}`}
      name={agent.name}
      icon={<AppIcon id={agent.id} size={44} />}
      publisher={agent.publisher === '开源' ? translate('extensions.openSourcePublisher')
        : agent.publisher ? translate('extensions.marketPublisher', { name: vendorName(agent.publisher) }) : undefined}
      category={categoryLabel(group)}
      description={description}
      installed={isInstalledAgent(agent)}
      onOpen={() => onOpenAgentDetail(agent.id)}
    />
  );

  return (
    <>
      {choices.length > 1 && (
        <MarketCategoryBar choices={choices} selected={activeCategory} onChange={onCategoryChange} testIdPrefix="agent-market-chip" />
      )}
      {data ? <RefreshFailed reading={reading} /> : null}
      {isError && (
        <div className="mk-status" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          <span>{translate('extensions.agentMarketUnavailable')}</span>
          <Button type="button" variant="ghost" size="sm" onClick={retryOf(reading)}>{translate('extensions.retry')}</Button>
        </div>
      )}
      {matching.length > 0 || assistantInResults ? (
        <MarketGrid title={title} heading={!!search} testId="agent-market-grid">
          {assistantInResults && assistantCard(assistant)}
          {matching.map((item) => agentCard(item))}
        </MarketGrid>
      ) : isPending || assistantLoading ? (
        <div className="mk-sec"><ShelfSkeleton label={translate('extensions.loading')} /></div>
      ) : !isError ? (
        <div className="mk-empty">{search ? translate('agentsPage.noMatch', { query: search }) : translate('agentsPage.emptyAll')}</div>
      ) : null}
    </>
  );
}
