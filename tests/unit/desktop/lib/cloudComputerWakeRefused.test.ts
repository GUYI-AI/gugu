// #7199 叫醒被管家拒了(积分用完 / 会员到期 / 没有权益):管家的 /state 仍是 asleep,渲染层记下是哪台、为什么,
// 那台的设备行不再带 cloud_computer —— 它上面的 agent 照读数说不在线(❌ 当「收回着、有事自己醒」什么都不画)。
// 记的地方是一个属于账号的 ④ store(wakeRefusals):换号 / 登出清空。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'

let snapshot: CloudComputerSnapshot
let wakeOutcome: () => Promise<void>
vi.mock('@/lib/cloudComputerClient', () => ({
  rendererCloudComputerClient: () => ({
    state: async () => snapshot,
    provision: async () => {},
    wake: () => wakeOutcome(),
    destroy: async () => {},
  }),
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))

const { cloudComputer, cloudSnapshotOf, readCloudSnapshotNow, refusedDeviceIdOf, wakeCloudComputer, wakeRefusals, withCloudComputerPresence } =
  await import('@/lib/cloudComputer')
const { publishRendererSession } = await import('@/lib/sessionPublication')
const { CloudComputerError } = await import('@gugu/core/cloud/cloudComputer')

const signIn = (id: string) => publishRendererSession('SIGNED_IN', { user: { id }, access_token: 't' } as never)
const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'dev-cloud', error: null, since: null })
const cloudRow = { device_id: 'dev-cloud', is_online: false } as Device
const refusedNow = () => refusedDeviceIdOf(wakeRefusals.get(), cloudSnapshotOf(cloudComputer.peek()))
const presenceNow = () => withCloudComputerPresence([cloudRow], cloudSnapshotOf(cloudComputer.peek()), Date.now(), refusedNow())[0]!.cloud_computer
const refuse = (code: string) => { wakeOutcome = async () => { throw new CloudComputerError(403, code, code) } }

describe('wakeCloudComputer refusal', () => {
  beforeEach(async () => {
    // Every case starts on a fresh account (a switch clears what the last one recorded).
    signIn('previous')
    signIn('owner')
    snapshot = snap('asleep')
    wakeOutcome = async () => {}
    await readCloudSnapshotNow()
  })

  it('收回着、没被拒:设备行说 asleep(画状态前那道映射据此不画)', () => {
    expect(refusedNow()).toBeNull()
    expect(presenceNow()).toBe('asleep')
  })

  it('积分用完被拒:记下哪台、为什么;那台的设备行不再带 cloud_computer', async () => {
    refuse('credits_exhausted')
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(wakeRefusals.get()).toEqual({ 'dev-cloud': 'credits_exhausted' })
    expect(refusedNow()).toBe('dev-cloud')
    expect(presenceNow()).toBeUndefined()
  })

  it('会员到期同样记下', async () => {
    refuse('membership_expired')
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(wakeRefusals.get()['dev-cloud']).toBe('membership_expired')
  })

  it('不是被拒的失败(管家连不上)不记:仍算收回着', async () => {
    wakeOutcome = async () => { throw new CloudComputerError(502, 'unavailable', '云电脑管家暂时连不上') }
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(refusedNow()).toBeNull()
    expect(presenceNow()).toBe('asleep')
  })

  it('之后叫醒成功就去掉;管家说它离开了 asleep 就不再算数', async () => {
    refuse('credits_exhausted')
    await expect(wakeCloudComputer()).rejects.toThrow()
    wakeOutcome = async () => {}
    await wakeCloudComputer()
    expect(wakeRefusals.get()['dev-cloud']).toBeUndefined()

    refuse('credits_exhausted')
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(refusedNow()).toBe('dev-cloud')
    snapshot = snap('waking')
    await readCloudSnapshotNow()
    expect(refusedNow()).toBeNull()
  })

  it('属于账号:换了一个人登录、或退出登录,上一个人的「被拒」不留', async () => {
    refuse('credits_exhausted')
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(wakeRefusals.get()).toEqual({ 'dev-cloud': 'credits_exhausted' })
    signIn('someone-else')
    expect(wakeRefusals.get()).toEqual({})

    await readCloudSnapshotNow()
    await expect(wakeCloudComputer()).rejects.toThrow()
    expect(wakeRefusals.get()).not.toEqual({})
    publishRendererSession('SIGNED_OUT', null)
    expect(wakeRefusals.get()).toEqual({})
  })

  it('会话只是短暂缺席(刷新令牌、冷启动)不清', async () => {
    refuse('credits_exhausted')
    await expect(wakeCloudComputer()).rejects.toThrow()
    publishRendererSession('TOKEN_REFRESHING', null)
    expect(wakeRefusals.get()).toEqual({ 'dev-cloud': 'credits_exhausted' })
    signIn('owner')
    expect(wakeRefusals.get()).toEqual({ 'dev-cloud': 'credits_exhausted' })
  })
})
