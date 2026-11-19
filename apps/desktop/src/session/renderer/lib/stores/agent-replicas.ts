import type { HarnessModelCredentialStatus } from '@gugu/session-core/agents/plugins';
import type { AgentModelCatalogAnswer } from '@main/core/agents/platform-model-catalog-hook';
import { replica } from '@/lib/replica';
import { rendererLogger } from '@/lib/log';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import type {
  AgentIconAsset,
  AgentInstallationStatus,
  AgentPayload,
  AgentSettings,
  InstallSourceVersions,
} from '@shared/core/agents/agent-payload';
import { agentCapabilitiesChangedChannel } from '@shared/core/agents/agentEvents';
import { agentInstallationStatusUpdatedChannel } from '@shared/events/appEvents';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';

/**
 * @@@agent-readings — what a machine (null = this computer) says about its agents. All derive from its install state, so
 * an install change refreshes the whole family (`refreshAgentReadings`; a prefix invalidation leaked #2802, #5605, #5719).
 */
type Machine = string | null;

const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000);
/** Then the reading is an error (❌ unknown for ever). */
const RETRIES = 3;

export const agentsMetadata = replica({
  name: 'agentsMetadata',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine) => rpcOn(machine).agents.list() as Promise<AgentPayload[]>,
  // Another machine's list changes by what someone did in its terminal (no push).
  fresh: 30_000,
});

export const managementAgents = replica({
  name: 'managementAgents',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine) => rpcOn(machine).agents.listManagement() as Promise<AgentPayload[]>,
  fresh: 30_000,
});

export const managementAgent = replica({
  name: 'managementAgent',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine, id: string) => rpcOn(machine).agents.getManagement(id) as Promise<AgentPayload | null>,
  retry: RETRIES,
  retryDelay: backoff,
});

export const agentMetadata = replica({
  name: 'agentMetadata',
  scope: 'device',
  read: (_owner, id: string) => rpc.agents.get(id) as Promise<AgentPayload | null>,
  fresh: 5 * 60_000,
});

export const agentIcons = replica({
  name: 'agentIcons',
  scope: 'device',
  read: () => rpc.agents.listIcons() as Promise<Record<string, AgentIconAsset>>,
  fresh: Infinity,
});

/** Models a harness runs, and the host's own gate for the Gugu group (`gugu`). Main answers from memory: every mount asks (#7081). */
export const harnessModelCatalog = replica({
  name: 'harnessModelCatalog',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, providerId: string, leg: SessionpageLeg, machine: Machine) =>
    rpcOn(machine).agents.modelCatalog(providerId, leg) as Promise<AgentModelCatalogAnswer>,
  refreshOnFocus: true,
  refreshEvery: (lookup) => (lookup?.refreshing ? 700 : false),
  // Opening a menu asks again; a read already on its way answers it (the host decides whether to probe again).
  refreshJoinsRead: true,
});

/** Native facts for one explicitly selected model; never written into the default harness catalog. */
export const targetModelCatalog = replica({
  name: 'targetModelCatalog',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine, providerId: string, leg: SessionpageLeg, model: string) =>
    rpcOn(machine).agents.targetModelCatalog(providerId, leg, model),
  // A mounted target asks again, as the former query's refetchOnMount: 'always' did.
  fresh: 0,
  refreshOnFocus: false,
});

// #4956
const credentialLog = rendererLogger('harness-model-credential');

export const harnessModelCredential = replica({
  name: 'harnessModelCredential',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner, providerId: string, modelId: string, machine: Machine): Promise<HarnessModelCredentialStatus> => {
    try {
      const runtime = await getAgentConfigRuntimeClient(machine);
      const result = await runtime.modelCredential({ providerId, modelId });
      if (!result.success) throw new Error(`modelCredential(${providerId}, ${modelId}) failed`, { cause: result.error });
      return result.data;
    } catch (error) {
      // Said here, once per read: its reader turns a failure into "cannot tell".
      credentialLog.warn({ providerId, modelId, machine, error: String(error) }, 'model credential could not be read');
      throw error;
    }
  },
  fresh: 60_000,
});

export const agentInstallationStatus = replica({
  name: 'agentInstallationStatus',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine) => rpcOn(machine).agents.listAgentInstallationStatus() as Promise<AgentInstallationStatus[]>,
  fresh: 30_000,
  retry: RETRIES,
  retryDelay: backoff,
});

export const installSourceVersions = replica({
  name: 'installSourceVersions',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine, id: string) =>
    rpcOn(machine).agents.getInstallSourceVersions(id as never) as Promise<InstallSourceVersions>,
  fresh: 30 * 60_000,
  retry: RETRIES,
  retryDelay: backoff,
});

export const agentSettings = replica({
  name: 'agentSettings',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine, id: string) => rpcOn(machine).agents.getSettings(id) as Promise<AgentSettings | null>,
  fresh: 60_000,
});

/** `keepStatus`: the install state was just patched from the push. */
export function refreshAgentReadings(machine: Machine, options: { keepStatus?: boolean } = {}): Promise<void> {
  return Promise.all([
    agentsMetadata.refresh(machine),
    managementAgents.refresh(machine),
    managementAgent.refresh(machine),
    harnessModelCatalog.refresh(undefined, undefined, machine),
    harnessModelCredential.refresh(undefined, undefined, machine),
    targetModelCatalog.refresh(machine),
    installSourceVersions.refresh(machine),
    agentSettings.refresh(machine),
    ...(options.keepStatus ? [] : [agentInstallationStatus.refresh(machine)]),
    ...(machine === null ? [agentMetadata.refresh(), agentIcons.refresh()] : []),
  ]).then(() => undefined);
}

/** Wired once per document. */
export function wireAgentReadings(): () => void {
  const offs = [
    events.on(agentCapabilitiesChangedChannel, () => {
      void agentsMetadata.refresh(null);
      void agentMetadata.refresh();
    }),
    events.on(agentInstallationStatusUpdatedChannel, (event: AgentInstallationStatus) => {
      if (agentInstallationStatus.key(null)) {
        agentInstallationStatus.set([null], (statuses) => {
          if (!statuses) return undefined;
          const index = statuses.findIndex((status) => status.id === event.id);
          return index === -1 ? [...statuses, event] : statuses.map((status, at) => (at === index ? event : status));
        });
      }
      void refreshAgentReadings(null, { keepStatus: true });
    }),
  ];
  return () => offs.forEach((off) => off());
}
