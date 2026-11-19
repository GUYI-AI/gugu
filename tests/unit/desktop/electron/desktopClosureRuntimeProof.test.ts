import { describe, expect, it } from 'vitest'
import { requireClosureRuntimeProof, type ClosureRuntimeProof } from '../../../../apps/desktop/electron/account-closure/foreign-runtimes'
import type { EnginePidRecord } from '../../../../apps/desktop/electron/enginePidReap'

const record = (ownerMainPid: number, agentUserId = 'agent-A'): EnginePidRecord => ({ ownerMainPid, agentUserId, pgid: 200,
  engineId: 'codex-app-server', conversationId: 'session', threadRootId: null, cwd: '/controlled', command: 'node', args: [], startedAt: 1 })
function proof(rows: EnginePidRecord[], alive: number[]): ClosureRuntimeProof {
  return { currentMainPid: 100, ownerAgentIds: async owner => new Set([`agent-${owner}`]), records: async () => rows,
    foreignAgentIds: async () => new Set(['agent-B']),
    pidAlive: pid => alive.includes(pid), groupAlive: pid => alive.includes(pid) }
}
describe('closure preserves another live main and its runtime ledger', () => {
  it.each([300, 0])('refuses a foreign or unverified main %i even when the recorded group leader is gone', async pid => {
    await expect(requireClosureRuntimeProof('A', proof([record(pid)], [300]))).rejects.toMatchObject({ code: 'closure_not_prepared' })
  })
  it('refuses an unreleased own group and an orphan still alive, without treating either as safely stopped', async () => {
    for (const pid of [100, 300]) await expect(requireClosureRuntimeProof('A', proof([record(pid)], [200]))).rejects.toMatchObject({ code: 'closure_not_prepared' })
  })
  it('permits confirmed exited A records and leaves a known B lease in this main untouched', async () => {
    const b = { ...record(100, 'agent-B'), pgid: 2000 }
    await expect(requireClosureRuntimeProof('A', proof([record(300), b], [2000]))).resolves.toBeUndefined()
  })
  it('refuses cleanup when a live B main shares the runtime home instead of changing its credentials or ledger', async () => {
    await expect(requireClosureRuntimeProof('A', proof([record(400, 'agent-B')], [400]))).rejects.toMatchObject({ code: 'closure_not_prepared' })
  })
  it('keeps an active unattributed engine unconfirmed rather than erasing underneath an unknown owner', async () => {
    await expect(requireClosureRuntimeProof('A', proof([record(300, 'unattributed')], [300]))).rejects.toMatchObject({ code: 'closure_not_prepared' })
  })
})
