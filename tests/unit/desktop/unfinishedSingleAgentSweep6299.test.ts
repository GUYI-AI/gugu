// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  sweepUnfinishedSingleAgents,
  continueUnfinishedSingleAgent,
  deleteUnfinishedSingleAgent,
  type UnfinishedSingleAgentSweepDeps,
} from '../../../apps/desktop/src/lib/unfinishedSingleAgentSweep'
import type { ProvisionResumeRecord, ProvisionResumeStore } from '../../../apps/desktop/src/lib/agentProvision'
import type { AgentProvision } from '@gugu/core/shared/types/agentProvision'
import type { CancelTeamProvisionResult } from '../../../apps/desktop/src/lib/teamProvisionSaga'

// #3160: startup preserves unfinished intent; Continue/Delete are explicit actions.
const OWNER = 'owner-1'
const record = (operationId: string, kind: 'single' | 'team' = 'single'): ProvisionResumeRecord => ({
  version: 2,
  ownerUserId: OWNER,
  operationId,
  deviceId: 'device-1',
  blueprint: { kind, members: [{ provision_id: `prov-${operationId}`, member_key: 'single', display_name: 'Codex 3', agent_type: 'codex', inherit_memory: false, history_import_required: false }] } as ProvisionResumeRecord['blueprint'],
  members: [{ provisionId: `prov-${operationId}`, memberKey: 'single' }] as ProvisionResumeRecord['members'],
})
const storeOf = (records: ProvisionResumeRecord[]) => {
  const live = [...records]
  const store = {
    list: vi.fn(() => [...live]),
    forget: vi.fn((_owner: string, operationId: string) => {
      const index = live.findIndex((entry) => entry.operationId === operationId)
      if (index >= 0) live.splice(index, 1)
    }),
    remember: vi.fn(),
  } as unknown as ProvisionResumeStore & { forget: ReturnType<typeof vi.fn> }
  return { store, live }
}
const completedRow = (name: string): AgentProvision => ({
  phase: 'completed',
  agent_user_id: 'agent-1',
  dm_chat_id: 'dm-1',
  create_command_id: 'cmd-1',
  display_name: name,
  avatar: null,
  created_at: '2026-09-23T00:00:00Z',
} as unknown as AgentProvision)
const cancelResult = (phase: string, fullyCancelled: boolean, stages: Array<'stop' | 'remove'> = []): CancelTeamProvisionResult => ({
  operation: { phase } as CancelTeamProvisionResult['operation'],
  fullyCancelled,
  cleanupErrors: stages.map((stage) => ({ provisionId: 'prov', agentUserId: 'agent', stage, error: 'x' })),
})
const baseDeps = (overrides: Partial<UnfinishedSingleAgentSweepDeps>): UnfinishedSingleAgentSweepDeps => ({
  getOwnerUserId: vi.fn(async () => OWNER),
  clearStarter: vi.fn(async () => undefined),
  resume: vi.fn(async () => { throw new Error('resume must be explicit') }),
  getOperation: vi.fn(async () => ({ phase: 'running' }) as never),
  cancel: vi.fn(async () => cancelResult('cancelled', true)),
  getMember: vi.fn(async () => completedRow('Codex 3')),
  ...overrides,
})

describe('#3160 未完成创建由用户继续或删除', () => {
  it('云端没有操作 → 启动保留预确认记录，不续建也不取消', async () => {
    const { store, live } = storeOf([record('op-none')])
    const deps = baseDeps({ store, getOperation: vi.fn(async () => null) })
    await expect(sweepUnfinishedSingleAgents(OWNER, deps)).resolves.toEqual([{ operationId: 'op-none', kind: 'pending', stages: [] }])
    expect(live).toHaveLength(1)
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('云端其实已建好 → 用云端成员行收尾并清记录,❌ 不重读本机源(源被改过也收得掉)', async () => {
    const { store, live } = storeOf([record('op-done')])
    const deps = baseDeps({ store, getOperation: vi.fn(async () => ({ phase: 'completed' }) as never) })
    const [outcome] = await sweepUnfinishedSingleAgents(OWNER, deps)
    expect(outcome).toMatchObject({ operationId: 'op-done', kind: 'completed', session: { agent: { display_name: 'Codex 3' }, chatId: 'dm-1' } })
    expect(deps.getMember).toHaveBeenCalledWith('prov-op-done')
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(live).toEqual([])
  })

  it('云端说已完成但成员行缺绑定 → pending,记录保留', async () => {
    const { store, live } = storeOf([record('op-half')])
    const deps = baseDeps({
      store,
      getOperation: vi.fn(async () => ({ phase: 'completed' }) as never),
      getMember: vi.fn(async () => ({ ...completedRow('x'), dm_chat_id: null }) as unknown as AgentProvision),
    })
    const [outcome] = await sweepUnfinishedSingleAgents(OWNER, deps)
    expect(outcome).toMatchObject({ operationId: 'op-half', kind: 'pending' })
    expect(live.map((entry) => entry.operationId)).toEqual(['op-half'])
  })

  it('没建完 → 取消;取消途中发现其实已完成 → 照常收尾', async () => {
    const { store } = storeOf([record('op-race')])
    const deps = baseDeps({ store, cancel: vi.fn(async () => cancelResult('completed', false)) })
    const outcome = await deleteUnfinishedSingleAgent(OWNER, 'op-race', deps)
    expect(outcome).toMatchObject({ kind: 'completed' })
  })

  it('取消全部收干净 → cancelled;清理有告警时带上是哪一步', async () => {
    const { store } = storeOf([record('op-a'), record('op-b')])
    const cancel = vi.fn()
      .mockResolvedValueOnce(cancelResult('cancelled', true))
      .mockResolvedValueOnce(cancelResult('cancelled', true, ['stop']))
    const deps = baseDeps({ store, cancel })
    const outcomes = [await deleteUnfinishedSingleAgent(OWNER, 'op-a', deps), await deleteUnfinishedSingleAgent(OWNER, 'op-b', deps)]
    expect(outcomes).toEqual([
      { operationId: 'op-a', kind: 'cancelled', warningStages: [] },
      { operationId: 'op-b', kind: 'cancelled', warningStages: ['stop'] },
    ])
  })

  it('显式删除没收干净 → pending,记录保留，等用户再次处理', async () => {
    const { store, live } = storeOf([record('op-stuck')])
    const deps = baseDeps({ store, cancel: vi.fn(async () => cancelResult('cleaning_up', false, ['remove'])) })
    await expect(deleteUnfinishedSingleAgent(OWNER, 'op-stuck', deps)).resolves.toEqual(
      { operationId: 'op-stuck', kind: 'pending', stages: ['remove'] },
    )
    expect(live.map((entry) => entry.operationId)).toEqual(['op-stuck'])
  })

  it('一条出错不拦其余几条;出错那条记录原样保留', async () => {
    const { store, live } = storeOf([record('op-err'), record('op-ok')])
    const getOperation = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(null)
    const outcomes = await sweepUnfinishedSingleAgents(OWNER, baseDeps({ store, getOperation }))
    expect(outcomes).toEqual([
      { operationId: 'op-err', kind: 'pending', stages: [], error: 'network down' },
      { operationId: 'op-ok', kind: 'pending', stages: [] },
    ])
    expect(live.map((entry) => entry.operationId)).toEqual(['op-err', 'op-ok'])
  })

  it('团队记录归 team saga,❌ 不碰', async () => {
    const { store, live } = storeOf([record('op-team', 'team')])
    const deps = baseDeps({ store })
    await expect(sweepUnfinishedSingleAgents(OWNER, deps)).resolves.toEqual([])
    expect(deps.getOperation).not.toHaveBeenCalled()
    expect(live).toHaveLength(1)
  })
})


describe('explicit recovery boundaries', () => {
  it.each(['queued', 'running', 'failed', 'cleaning_up', 'cancelled'])('startup retains %s without automatic work', async phase => {
    const { store, live } = storeOf([record('op')])
    const deps = baseDeps({ store, getOperation: vi.fn(async () => ({ phase }) as never) })
    expect(await sweepUnfinishedSingleAgents(OWNER, deps)).toEqual([{ operationId: 'op', kind: 'pending', stages: [] }])
    expect(live).toHaveLength(1)
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('explicit deletion of a pre-ack request clears its starter and local intent only', async () => {
    const { store, live } = storeOf([record('op')])
    const deps = baseDeps({ store, getOperation: vi.fn(async () => null) })
    expect(await deleteUnfinishedSingleAgent(OWNER, 'op', deps)).toEqual({ operationId: 'op', kind: 'discarded' })
    expect(live).toEqual([])
    expect(deps.clearStarter).toHaveBeenCalledWith('op', deps.getOwnerUserId)
    expect(deps.cancel).not.toHaveBeenCalled()
  })

  it('explicit Continue passes the original owner-scoped record to the existing resume flow', async () => {
    const original = record('op')
    const { store, live } = storeOf([original])
    const resume = vi.fn(async () => ({ operation: { phase: 'completed' } }) as never)
    const deps = baseDeps({ store, resume })
    expect(await continueUnfinishedSingleAgent(OWNER, 'op', deps)).toMatchObject({ kind: 'completed', session: { chatId: 'dm-1' } })
    expect(resume).toHaveBeenCalledWith(original, { resumeStore: store, getOwnerUserId: deps.getOwnerUserId })
    expect(live).toEqual([])
    expect(deps.cancel).not.toHaveBeenCalled()
  })

  it('Continue source verification failure preserves intent and never cancels it', async () => {
    const { store, live } = storeOf([record('op')])
    const deps = baseDeps({ store, resume: vi.fn(async () => { throw new Error('source fingerprint changed') }) })
    await expect(continueUnfinishedSingleAgent(OWNER, 'op', deps)).rejects.toThrow('fingerprint')
    expect(live).toHaveLength(1)
    expect(deps.cancel).not.toHaveBeenCalled()
  })

  it('deleting an already completed creation finishes it without cancelling the agent', async () => {
    const { store } = storeOf([record('op')])
    const deps = baseDeps({ store, getOperation: vi.fn(async () => ({ phase: 'completed' }) as never) })
    expect(await deleteUnfinishedSingleAgent(OWNER, 'op', deps)).toMatchObject({ kind: 'completed' })
    expect(deps.cancel).not.toHaveBeenCalled()
  })

  it('account switching during the read denies deletion before the cancel RPC', async () => {
    const { store, live } = storeOf([record('op')])
    let owner = OWNER
    const deps = baseDeps({ store, getOwnerUserId: async () => owner, getOperation: vi.fn(async () => { owner = 'another'; return { phase: 'running' } as never }) })
    await expect(deleteUnfinishedSingleAgent(OWNER, 'op', deps)).rejects.toThrow('owner')
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(live).toHaveLength(1)
  })
})
