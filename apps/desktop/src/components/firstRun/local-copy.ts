import type { FirstRunHarness } from '@gugu/core/shared/firstRun'
import { rpc } from '@renderer/lib/ipc'
import { agentInstallationStatus } from '@renderer/lib/stores/agent-replicas'
import type { AgentInstallationStatus } from '@shared/core/agents/agent-payload'

/**
 * What first run finds for a harness on this computer. Only `usable` is used as it is; for the other three Gugu
 * installs its own copy without asking ("no one is handed a copy that cannot run").
 * - outdated: runs, but session start would refuse its version (`versionSupported`).
 * - broken: found, but `--version` fails, or its version cannot be read.
 */
export type LocalCopy =
  | { kind: 'usable'; version: string }
  | { kind: 'outdated'; version: string }
  | { kind: 'broken' }
  | { kind: 'missing' }

/**
 * This computer's entry in the shared installation status (the one the agent store and Settings read), in first run's
 * terms: `reading` is the judgement every surface shares (#6101); the version is the copy in use under the person's own
 * selection.
 */
export function localCopyOf(status: AgentInstallationStatus | undefined): LocalCopy {
  if (!status || status.reading === 'not-detected' || status.reading === 'missing') return { kind: 'missing' }
  if (status.reading === 'detected-but-broken' || !status.version || status.versionSupported === null) return { kind: 'broken' }
  return status.versionSupported === false ? { kind: 'outdated', version: status.version } : { kind: 'usable', version: status.version }
}

/** Continue acts on this computer as it is now: probe the harness again, then read the shared status again. */
export async function readLocalCopy(id: FirstRunHarness): Promise<LocalCopy> {
  await rpc.agents.probe(id)
  const statuses = await agentInstallationStatus.reread(null)
  return localCopyOf(statuses.find((status) => status.id === id))
}
