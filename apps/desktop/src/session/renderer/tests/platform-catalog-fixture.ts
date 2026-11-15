import { followRendererSession } from '@/lib/replica';
import { platformModels } from '@/lib/agentModelReplicas';
import type { PlatformCatalogModel } from '@/lib/agentModelSelection';
import { agentsMetadata } from '@renderer/lib/stores/agent-replicas';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import type { PlatformModelProtocol } from '@shared/core/agents/platform-model';

/**
 * Tests of a composer's Gugu group: the group derives from the account's catalog and the engine's sessionpage
 * integration on its machine (platform-model-catalog.ts). This signs an account in and puts both as read.
 */
export type CatalogRow = {
  id: string;
  displayName?: string;
  protocol: PlatformModelProtocol;
  creditMultiplier?: number | null;
  contextWindow?: number | null;
  reasoningEfforts?: string[] | null;
  requiresMembership?: boolean;
  hidden?: boolean;
};

export function accountCatalogRows(rows: readonly CatalogRow[]): PlatformCatalogModel[] {
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName ?? row.id,
    protocols: [row.protocol],
    enabled: true,
    requiresMembership: row.requiresMembership === true,
    hidden: row.hidden === true,
    creditMultiplier: row.creditMultiplier ?? null,
    creditMultipliers: row.creditMultiplier ? { [row.protocol]: row.creditMultiplier } : {},
    contextWindow: row.contextWindow ?? null,
    reasoningEfforts: row.reasoningEfforts ?? null,
  }));
}

/** An agent whose both legs can carry a Gugu identity (the case a Gugu group is offered for). */
export function routableAgent(id: string, name = id): AgentPayload {
  const leg = { identity: 'addressable', messageTransport: 'router' };
  return { id, name, capabilities: { sessionpage: { acp: leg, tui: leg } } } as unknown as AgentPayload;
}

export function seedPlatformCatalog(input: {
  account?: string;
  rows: readonly CatalogRow[];
  agents: readonly AgentPayload[];
  machine?: string | null;
}): void {
  followRendererSession('SIGNED_IN', input.account ?? 'account-1');
  platformModels.set([], accountCatalogRows(input.rows));
  agentsMetadata.set([input.machine ?? null], [...input.agents]);
}
