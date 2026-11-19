import { zhCNMarketAgentDescriptions } from '@renderer/localization/messages';
import type { AgentMetadata } from '@shared/core/agents/agent-payload';

const legacyAgentIds = new Map([
  ['agy', 'antigravity'],
  ['kiro-cli', 'kiro'],
]);

export function marketAgentDescription(agent: Pick<AgentMetadata, 'id' | 'description'>, locale: string): string {
  if (!locale.toLowerCase().startsWith('zh')) return agent.description;
  const id = legacyAgentIds.get(agent.id) ?? agent.id;
  return Object.hasOwn(zhCNMarketAgentDescriptions, id)
    ? zhCNMarketAgentDescriptions[id] ?? agent.description
    : agent.description;
}
