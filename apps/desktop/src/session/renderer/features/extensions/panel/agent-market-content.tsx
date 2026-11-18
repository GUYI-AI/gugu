import { CircleAlert, FileCode, LayoutGrid, MessageCircle } from '@/lib/icons';
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
import { MarketCard, MarketCategoryBar, MarketGrid, type MarketCategoryChoice } from './desktop-market-cards';
import { ExtensionMonogram } from './extension-monogram';
import { ShelfSkeleton } from './extension-skeletons';
import { marketAgentDescription } from './market-agent-description';

const categoryIcons = { coding: FileCode, general: MessageCircle };
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
  assistantInstalled: boolean;
  onOpenAssistant: () => void;
  assistantResource?: ResourceContext;
}) {
  const { translate, locale } = useSessionMessages();
  const { data, isPending, isError, refetch } = useManagementAgents();
  const categoryLabel = (key: AgentMarketCategory) => translate(`extensions.agentCategory.${key}`);
  const choices: MarketCategoryChoice<AgentMarketFilter>[] = [
    { value: 'all', icon: LayoutGrid, label: translate('extensions.marketCategoryAll') },
    ...AGENT_MARKET_CATEGORIES.map((key) => ({ value: key, icon: categoryIcons[key], label: categoryLabel(key) })),
  ];
  const search = query.trim();
  const visible = (data ?? []).flatMap((agent) => {
    const group = agentMarketCategoryOf(agent.id);
    if (category !== 'all' && group !== category) return [];
    const description = marketAgentDescription(agent, locale);
    const text = [agent.name, agent.id, agent.publisher, description].join('\n');
    return search && !queryScore(search, text) ? [] : [{ agent, group, description }];
  });
  const assistantText = assistant && category !== 'coding' && matchesExtensionQuery(assistant.manifest, search)
    ? localizedManifestText(assistant.manifest, locale)
    : undefined;
  const count = visible.length + Number(Boolean(assistantText));
  const title = search ? translate('extensions.searchResults') : category === 'all'
    ? translate('extensions.allAgents') : categoryLabel(category);

  return (
    <>
      <MarketCategoryBar choices={choices} selected={category} onChange={onCategoryChange} testIdPrefix="agent-market-chip" />
      {isError && !data && (
        <div className="mk-status" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          <span>{translate('extensions.agentMarketUnavailable')}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refetch()}>{translate('extensions.retry')}</Button>
        </div>
      )}
      {count > 0 ? (
        <MarketGrid title={title} count={count} testId="agent-market-grid">
          {assistant && assistantText && (
            <MarketCard
              testId={`extension-card-${assistant.manifest.id}`}
              name={assistantText.name}
              icon={<span className="mk-icon"><ExtensionMonogram name={assistantText.name} iconDataUrl={assistant.cloud.iconUrl} /></span>}
              publisher={translate('extensions.official')}
              category={categoryLabel('general')}
              description={assistantText.subtitle}
              installed={assistantInstalled}
              onOpen={onOpenAssistant}
              resource={assistantResource}
            />
          )}
          {visible.map(({ agent, group, description }) => (
            <MarketCard
              key={agent.id}
              testId={`agent-market-card-${agent.id}`}
              name={agent.name}
              icon={<AppIcon id={agent.id} size={40} />}
              publisher={agent.publisher === '开源' ? translate('extensions.openSourcePublisher')
                : agent.publisher ? translate('extensions.marketPublisher', { name: agent.publisher }) : undefined}
              category={categoryLabel(group)}
              description={description}
              installed={isInstalledAgent(agent)}
              onOpen={() => onOpenAgentDetail(agent.id)}
            />
          ))}
        </MarketGrid>
      ) : isPending || assistantLoading ? (
        <div className="mk-sec"><ShelfSkeleton label={translate('extensions.loading')} /></div>
      ) : !isError ? (
        <div className="mk-empty">{search ? translate('agentsPage.noMatch', { query: search }) : translate('agentsPage.emptyAll')}</div>
      ) : null}
    </>
  );
}
