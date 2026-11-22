import { followRendererSession } from '@/lib/replica';
import { platformModels } from '@/lib/agentModelReplicas';
import type { PlatformCatalogModel } from '@/lib/agentModelSelection';
import { harnessModelCatalog } from '@renderer/lib/stores/agent-replicas';
import type { AgentModelCatalogAnswer, GuguModelsOffer } from '@main/core/agents/platform-model-catalog-hook';
import type { PlatformModelProtocol } from '@shared/core/agents/platform-model';

/**
 * Tests of a composer's Gugu group: the group derives from the account's catalog, offered or not as the engine's machine
 * answers with its harness catalog (platform-model-catalog.ts). This signs an account in and puts both as read.
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

/** A machine's harness catalog answer for an engine's leg, with its gate for the Gugu group. */
export function harnessAnswer(gugu: GuguModelsOffer = { offered: true }): AgentModelCatalogAnswer {
  return { state: { kind: 'unknown' }, refreshing: false, gugu };
}

export function seedPlatformCatalog(input: {
  account?: string;
  rows: readonly CatalogRow[];
  /** Engines whose machine offers the Gugu group on both legs. */
  providers: readonly string[];
  machine?: string | null;
}): void {
  followRendererSession('SIGNED_IN', input.account ?? 'account-1');
  platformModels.set([], accountCatalogRows(input.rows));
  for (const provider of input.providers) {
    for (const leg of ['acp', 'tui'] as const) harnessModelCatalog.set([input.machine ?? null, provider, leg], harnessAnswer());
  }
}
