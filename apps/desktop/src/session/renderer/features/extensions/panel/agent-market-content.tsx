import { CircleAlert } from '@/lib/icons';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order';
import {
  AGENT_MARKET_CATEGORIES, agentMarketCategoryOf, localizedManifestText, matchesExtensionQuery, type AgentMarketCategory,
} from '@shared/extensions/catalog';
import type { MarketListItem } from '@shared/extensions/market';
import { queryScore } from '@shared/extensions/query-score';
import type { ResourceContext } from '@shared/resource-actions';
import { MarketCard, MarketCategoryBar, MarketFeatured, MarketGrid, type MarketCategoryChoice } from './desktop-market-cards';
import { ExtensionMonogram } from './extension-monogram';
import { ShelfSkeleton } from './extension-skeletons';
import { marketAgentDescription } from './market-agent-description';

const featuredAgentIds = ['claude', 'codex'];
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
  const { data, isPending, isError, refetch } = useManagementAgents();
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
  const visible = rows.filter(({ agent, group, description }) =>
    (activeCategory === 'all' || group === activeCategory) &&
    (!search || queryScore(search, [agent.name, agent.id, agent.publisher, description].join('\n')))
  );
  const title = search ? translate('extensions.searchResults') : activeCategory === 'all'
    ? translate('extensions.allAgents') : categoryLabel(activeCategory);
  const assistantInResults = assistant && activeCategory !== 'coding' && matchesExtensionQuery(assistant.manifest, search);
  const assistantCard = (item: MarketListItem, featured = false) => {
    const { name, subtitle } = localizedManifestText(item.manifest, locale);
    return (
      <MarketCard
        key={item.manifest.id}
        testId={`${featured ? 'featured-extension' : 'extension'}-card-${item.manifest.id}`}
        name={name}
        icon={<span className="mk-icon"><ExtensionMonogram name={name} iconDataUrl={item.cloud.iconUrl} /></span>}
        publisher={translate('extensions.official')}
        category={categoryLabel('general')}
        description={subtitle}
        installed={assistantInstalled}
        onOpen={onOpenAssistant}
        resource={assistantResource}
      />
    );
  };
  const agentCard = ({ agent, group, description }: typeof rows[number], featured = false) => (
    <MarketCard
      key={agent.id}
      testId={`${featured ? 'featured-agent' : 'agent-market'}-card-${agent.id}`}
      name={agent.name}
      icon={<AppIcon id={agent.id} size={44} />}
      publisher={agent.publisher === '开源' ? translate('extensions.openSourcePublisher')
        : agent.publisher ? translate('extensions.marketPublisher', { name: agent.publisher }) : undefined}
      category={categoryLabel(group)}
      description={description}
      installed={isInstalledAgent(agent)}
      onOpen={() => onOpenAgentDetail(agent.id)}
    />
  );
  const featured = [
    ...(assistant ? [assistantCard(assistant, true)] : []),
    ...featuredAgentIds.flatMap((id) => {
      const item = rows.find(({ agent }) => agent.id === id);
      return item ? [agentCard(item, true)] : [];
    }),
  ];

  return (
    <>
      {!search && <MarketFeatured
        title={translate('extensions.featuredAgents')}
        items={featured}
        more={rows.filter(({ agent }) => !featuredAgentIds.includes(agent.id)).map((item) => agentCard(item, true))}
        renderCard={(card) => card}
      />}
      {choices.length > 1 && (
        <MarketCategoryBar choices={choices} selected={activeCategory} onChange={onCategoryChange} testIdPrefix="agent-market-chip" />
      )}
      {isError && !data && (
        <div className="mk-status" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          <span>{translate('extensions.agentMarketUnavailable')}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refetch()}>{translate('extensions.retry')}</Button>
        </div>
      )}
      {visible.length > 0 || assistantInResults ? (
        <MarketGrid title={title} heading={!!search} testId="agent-market-grid">
          {assistantInResults && assistantCard(assistant)}
          {visible.map((item) => agentCard(item))}
        </MarketGrid>
      ) : isPending || assistantLoading ? (
        <div className="mk-sec"><ShelfSkeleton label={translate('extensions.loading')} /></div>
      ) : !isError ? (
        <div className="mk-empty">{search ? translate('agentsPage.noMatch', { query: search }) : translate('agentsPage.emptyAll')}</div>
      ) : null}
    </>
  );
}
