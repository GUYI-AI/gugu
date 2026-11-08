// 性能读数(perf.* 3 个):读的是资源监视器那份记录。验:清单与确认策略、监视器关着说清楚(不回空读数)、参数检查、录制每次问。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createPerfFamily } from '../../../../apps/desktop/electron/device-actions/families/perf'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-perf-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

class ResourceMonitorOffError extends Error { name = 'ResourceMonitorOffError' }

function setup(perf: FamilyDeps['perf']) {
  const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
  const deps = { platform: 'linux', nativeDir: null, now: () => new Date(), homedir: () => dir, perf } as unknown as FamilyDeps
  const da = createDeviceActionsProvider({ store, families: [createPerfFamily()], deps })
  store.setGroup('perf', true)
  return da
}
const ctx = () => ({ callId: 'c', signal: new AbortController().signal, note: () => undefined })
const readings = () => ({ snapshot: vi.fn(() => ({ cpuPercent: 3 })), history: vi.fn(() => ({ points: [], count: 0 })), capture: vi.fn(async () => ({ seconds: 5, mainThreadBusyMs: 0, longTasks: 0, longTaskMs: 0, tasks: [] })) })

describe('性能读数 perf.*', () => {
  it('登记 3 个工具;读数不问,录制每次问', () => {
    const actions = setup(readings()).capability()!.actions
    expect(Object.fromEntries(actions.map((a) => [a.name, a.confirm]))).toEqual({ 'perf.snapshot': 'never', 'perf.history': 'never', 'perf.capture': 'always' })
    // An agent that follows the schema must be able to send the confirmation.
    expect(actions.find((a) => a.name === 'perf.capture')!.input_schema).toMatchObject({ properties: { confirmed: { type: 'boolean' } } })
  })

  it('读数与历史原样转出;历史默认最近一小时', async () => {
    const perf = readings()
    const da = setup(perf)
    expect(await da.provider.run('perf.snapshot', {}, ctx())).toMatchObject({ ok: true, data: { cpuPercent: 3 } })
    vi.useFakeTimers(); vi.setSystemTime(10_000_000)
    await da.provider.run('perf.history', {}, ctx())
    vi.useRealTimers()
    expect(perf.history).toHaveBeenCalledWith(10_000_000 - 3_600_000, 10_000_000)
    expect(await da.provider.preflight!('perf.history', { since: 'yesterday' })).toMatchObject({ code: 'invalid_args' })
  })

  it('监视器关着:报错说怎么打开,不回空读数', async () => {
    const perf = readings()
    perf.snapshot.mockImplementation(() => { throw new ResourceMonitorOffError('off') })
    expect(await setup(perf).provider.run('perf.snapshot', {}, ctx())).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('turn it on') })
  })

  it('录制:先问几秒,确认了才放行;秒数 1–15', async () => {
    const perf = readings()
    const da = setup(perf)
    expect(await da.provider.preflight!('perf.capture', { seconds: 5 })).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining('5 秒') } })
    expect(await da.provider.preflight!('perf.capture', { seconds: 5, confirmed: true })).toBeNull()
    expect(await da.provider.run('perf.capture', { seconds: 5, confirmed: true }, ctx())).toMatchObject({ ok: true, data: { seconds: 5 } })
    expect(perf.capture).toHaveBeenCalledWith(5)
    expect(await da.provider.preflight!('perf.capture', { seconds: 60 })).toMatchObject({ code: 'invalid_args' })
  })
})
