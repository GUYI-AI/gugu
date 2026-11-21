import type { FirstRunHarness } from '@gugu/core/shared/firstRun'
import { rpc } from '@renderer/lib/ipc'

/**
 * What first run finds for a harness on this computer. Only `usable` is used as it is; for the other three Gugu
 * installs its own copy without asking ("no one is handed a copy that cannot run").
 * - outdated: runs, but older than the floor this client enforces at session start.
 * - broken: found, but `--version` fails (probe status `error`) or reports no readable version.
 */
export type LocalCopy =
  | { kind: 'usable'; version: string }
  | { kind: 'outdated'; version: string }
  | { kind: 'broken' }
  | { kind: 'missing' }

export async function readLocalCopy(id: FirstRunHarness): Promise<LocalCopy> {
  await rpc.agents.probe(id)
  const status = await rpc.agents.getAgentInstallationStatus(id)
  if (!status || status.status === 'missing') return { kind: 'missing' }
  if (status.status !== 'available' || !status.version) return { kind: 'broken' }
  const met = status.supportedFloor ? status.supportedFloor.met : true
  if (met === true) return { kind: 'usable', version: status.version }
  return met === false ? { kind: 'outdated', version: status.version } : { kind: 'broken' }
}
