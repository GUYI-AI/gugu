import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listAgents } from '@gugu/core/local/state/agents'
import { agentOwnerUserId } from '@gugu/core/local/state/agentOwner'
import { enginePidDir, parseEnginePidfile, type EnginePidRecord } from '../enginePidReap'
import { ClosureFailure } from './receipts'

export interface ClosureRuntimeProof {
  currentMainPid: number
  ownerAgentIds(owner: string): Promise<ReadonlySet<string>>
  foreignAgentIds?(owner: string): Promise<ReadonlySet<string>>
  records(): Promise<readonly EnginePidRecord[]>
  pidAlive(pid: number): boolean
  groupAlive(pid: number): boolean
}
export async function requireClosureRuntimeProof(owner: string, proof: ClosureRuntimeProof): Promise<void> {
  const ids = await proof.ownerAgentIds(owner)
  const foreignIds = await proof.foreignAgentIds?.(owner) ?? new Set<string>()
  for (const record of await proof.records()) {
    // A different live (or unverified) main owns its process and ledger. Do not
    // stop it, delete its row or erase a shared runtime home's credentials
    // underneath it, including a B main which can write that home's auth.json.
    const foreign = record.ownerMainPid !== proof.currentMainPid
    if (foreign && (record.ownerMainPid <= 0 || proof.pidAlive(record.ownerMainPid))) throw new ClosureFailure('closure_not_prepared')
    if (!ids.has(record.agentUserId) && foreignIds.has(record.agentUserId)) continue
    if (proof.groupAlive(record.pgid)) {
      throw new ClosureFailure('closure_not_prepared')
    }
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
/** Read-only. Ownership uncertainty keeps cleanup pending; this path never
 * invokes the startup reaper and never sends a terminating signal. */
export const assertNoLiveAccountEngines = (owner: string) => requireClosureRuntimeProof(owner, {
  currentMainPid: process.pid,
  ownerAgentIds: async id => new Set((await listAgents(process.env, { includeGuests: true }))
    .filter(agent => agentOwnerUserId(agent) === id).map(agent => agent.gugu_user_id).filter(Boolean)),
  foreignAgentIds: async id => new Set((await listAgents(process.env, { includeGuests: true }))
    .filter(agent => agentOwnerUserId(agent) && agentOwnerUserId(agent) !== id).map(agent => agent.gugu_user_id).filter(Boolean)),
  async records() {
    const root = enginePidDir()
    let files: string[]
    try { files = await readdir(root) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records: EnginePidRecord[] = []
    for (const file of files.filter(file => file.endsWith('.json'))) {
      let raw: string
      try { raw = await readFile(join(root, file), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      const record = parseEnginePidfile(raw)
      if (!record) throw new ClosureFailure('closure_not_prepared')
      records.push(record)
    }
    return records
  },
  pidAlive: alive,
  // A remaining Windows tree ledger cannot be cleared by checking only its
  // root PID: children may have outlived it. Its owning stop must retire the
  // record first. POSIX can check the entire recorded process group directly.
  groupAlive: pid => process.platform === 'win32' ? true : alive(-pid),
})
