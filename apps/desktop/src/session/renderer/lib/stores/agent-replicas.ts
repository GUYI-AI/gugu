import type { HarnessModelCredentialStatus } from '@gugu/session-core/agents/plugins';
import type { HarnessCatalogLookup } from '@main/core/agents/harness-model-catalog';
import { replica } from '@/lib/replica';
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
 * @@@agent-readings — what a machine says about its agents, one replica per kind, keyed by the machine (null = this
 * computer; another machine's answers ❌ under this computer's entry). All derive from the machine's install state, so an
 * install, update, uninstall or re-probe refreshes the whole family (`refreshAgentReadings`, the one list of members;
 * the old `['agents', …]` prefix invalidation leaked #2802, #5605, #5719 and the source versions).
 */
type Machine = string | null;

const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000);

/** The agents a machine offers for new tasks (name, icon, capabilities, sessionpage integration). */
export const agentsMetadata = replica({
  name: 'agentsMetadata',
  scope: 'account',
  read: (_owner, machine: Machine) => rpcOn(machine).agents.list() as Promise<AgentPayload[]>,
  // This computer's list changes by a push (`wireAgentReadings`); another machine's by what someone did in its terminal.
  fresh: 30_000,
});

/** Library → Agents: every agent a machine knows, installed or not. */
export const managementAgents = replica({
  name: 'managementAgents',
  scope: 'account',
  read: (_owner, machine: Machine) => rpcOn(machine).agents.listManagement() as Promise<AgentPayload[]>,
  fresh: 30_000,
});

/** One agent's library detail; asked again whenever the detail opens (its probe may have moved on). */
export const managementAgent = replica({
  name: 'managementAgent',
  scope: 'account',
  read: (_owner, machine: Machine, id: string) => rpcOn(machine).agents.getManagement(id) as Promise<AgentPayload | null>,
  retry: true,
  retryDelay: backoff,
});

/** One registered agent of this computer, offered for new tasks or not (sign-in, the assistant's engine). */
export const agentMetadata = replica({
  name: 'agentMetadata',
  scope: 'device',
  read: (_owner, id: string) => rpc.agents.get(id) as Promise<AgentPayload | null>,
  fresh: 5 * 60_000,
});

/** The icon of every registered agent (a lookup table, not the list offered for new tasks). */
export const agentIcons = replica({
  name: 'agentIcons',
  scope: 'device',
  read: () => rpc.agents.listIcons() as Promise<Record<string, AgentIconAsset>>,
  fresh: Infinity,
});

/**
 * Which models an agent's harness can run. The main process owns invalidation and answers from memory, so every mount
 * asks (`fresh: 0`, #7081), focus asks, and a `refreshing` answer is asked again every 700 ms until the probe settles.
 */
export const harnessModelCatalog = replica({
  name: 'harnessModelCatalog',
  scope: 'account',
  read: (_owner, providerId: string, leg: SessionpageLeg, machine: Machine) =>
    rpcOn(machine).agents.modelCatalog(providerId, leg) as Promise<HarnessCatalogLookup>,
  refreshOnFocus: true,
  refreshEvery: (lookup) => (lookup?.refreshing ? 700 : false),
});

/** Whether the provider of one of a harness's own models has a credential on its machine (#4956). */
export const harnessModelCredential = replica({
  name: 'harnessModelCredential',
  scope: 'account',
  read: async (_owner, providerId: string, modelId: string, machine: Machine): Promise<HarnessModelCredentialStatus> => {
    const runtime = await getAgentConfigRuntimeClient(machine);
    const result = await runtime.modelCredential({ providerId, modelId });
    if (!result.success) throw new Error(`modelCredential(${providerId}, ${modelId}) failed`, { cause: result.error });
    return result.data;
  },
  // A credential changes by a sign-in, and that path refreshes it (`refreshAgentReadings`, the sign-in flows).
  fresh: 60_000,
});

/** Install state of every agent on a machine; this computer's is patched by its push (`wireAgentReadings`). */
export const agentInstallationStatus = replica({
  name: 'agentInstallationStatus',
  scope: 'account',
  read: (_owner, machine: Machine) => rpcOn(machine).agents.listAgentInstallationStatus() as Promise<AgentInstallationStatus[]>,
  fresh: 30_000,
  retry: true,
  retryDelay: backoff,
});

/** The versions each install registry offers for an agent. */
export const installSourceVersions = replica({
  name: 'installSourceVersions',
  scope: 'account',
  read: (_owner, machine: Machine, id: string) =>
    rpcOn(machine).agents.getInstallSourceVersions(id as never) as Promise<InstallSourceVersions>,
  fresh: 30 * 60_000,
  retry: true,
  retryDelay: backoff,
});

/** An agent's extra arguments and environment on a machine. */
export const agentSettings = replica({
  name: 'agentSettings',
  scope: 'account',
  read: (_owner, machine: Machine, id: string) => rpcOn(machine).agents.getSettings(id) as Promise<AgentSettings | null>,
  fresh: 60_000,
});

/** Read the whole family again for a machine. `keepStatus`: the install state was just patched from the push. */
export function refreshAgentReadings(machine: Machine, options: { keepStatus?: boolean } = {}): Promise<void> {
  return Promise.all([
    agentsMetadata.refresh(machine),
    managementAgents.refresh(machine),
    managementAgent.refresh(machine),
    harnessModelCatalog.refresh(undefined, undefined, machine),
    harnessModelCredential.refresh(undefined, undefined, machine),
    installSourceVersions.refresh(machine),
    agentSettings.refresh(machine),
    ...(options.keepStatus ? [] : [agentInstallationStatus.refresh(machine)]),
    ...(machine === null ? [agentMetadata.refresh(), agentIcons.refresh()] : []),
  ]).then(() => undefined);
}

/** This computer's pushes about its agents, wired once per document (fork changes; an agent's full install status). */
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
