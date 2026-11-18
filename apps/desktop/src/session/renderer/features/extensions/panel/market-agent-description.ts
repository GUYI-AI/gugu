import { zhCNMarketAgentDescriptions } from '@renderer/localization/messages';
import type { AgentMetadata } from '@shared/core/agents/agent-payload';

export function marketAgentDescription(agent: Pick<AgentMetadata, 'id' | 'description'>, locale: string): string {
  if (locale.toLowerCase().startsWith('zh') && Object.hasOwn(zhCNMarketAgentDescriptions, agent.id)) {
    return zhCNMarketAgentDescriptions[agent.id] ?? agent.description;
  }
  return agent.description;
}
