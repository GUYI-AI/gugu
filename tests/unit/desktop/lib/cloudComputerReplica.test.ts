// @vitest-environment jsdom
// #7199 渲染层那一份云电脑读数(replica `cloudComputer`):门说「没开放」= 不显示(一个真值),别的没问到 = 读数是错误;
// 几路同时在问时只落最后发出的那一次(replica I2);关掉当场就是「没有」;间隔按值定。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'

const calls: Array<(snapshot: CloudComputerSnapshot) => void> = []
const rejects: Array<(error: unknown) => void> = []
vi.mock('@/lib/cloudComputerClient', () => ({
  rendererCloudComputerClient: () => ({
    state: () => new Promise<CloudComputerSnapshot>((resolve, reject) => {
      calls.push(resolve)
      rejects.push(reject)
    }),
    provision: async () => {},
    wake: async () => {},
    destroy: async () => {},
  }),
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))

const { CLOUD_COMPUTER_FAST_POLL_MS, CLOUD_COMPUTER_WATCH_MS, canSetUpCloudAssistant, cloudComputer, cloudComputerRefreshMs, cloudFailureOf, destroyCloudComputer, readCloudSnapshotNow, useCloudComputer } = await import('@/lib/cloudComputer')
const { createReactHarness } = await import('../../../support/testHarness')
const { createElement } = await import('react')
const { writeCachedDevices } = await import('@/store/devicesCache')
const { publishRendererSession } = await import('@/lib/sessionPublication')
const { CloudComputerError } = await import('@gugu/core/cloud/cloudComputer')

const signIn = (id: string) => publishRendererSession('SIGNED_IN', { user: { id }, access_token: 't' } as never)
const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'dev-cloud', error: null, since: null })
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('cloudComputer read', () => {
  beforeEach(() => {
    calls.length = 0
    rejects.length = 0
    signIn('previous')
    signIn('owner')
  })

  it('那扇门说「这里没开放」(503 not_open):整块不显示、❌ 报读不到;配上以后问到就出现', async () => {
    const closed = readCloudSnapshotNow()
    rejects[0]!(new CloudComputerError(503, 'not_open', '云电脑暂未开放'))
    await expect(closed).resolves.toBeNull()
    expect(cloudComputer.peek()).toMatchObject({ state: 'value', value: { available: false }, error: null })

    const opened = readCloudSnapshotNow()
    calls[1]!({ ...snap('none'), deviceId: null })
    await opened
    expect(cloudComputer.peek()).toMatchObject({ state: 'value', value: { available: true, snapshot: { state: 'none' } } })
  })

  it('连不上管家(502)、云端函数没部署(404)是读数里的错误(还没读到过 = 整份是错误)', async () => {
    const down = readCloudSnapshotNow()
    rejects[0]!(new CloudComputerError(404, 'http_404', 'Function not found'))
    await expect(down).rejects.toThrow()
    expect(cloudComputer.peek().state).toBe('error')
    expect(cloudFailureOf(cloudComputer.peek())).toBe('failed')
  })

  it('a failed read cannot make cloud setup selectable; a real successful state read can', async () => {
    expect(canSetUpCloudAssistant(cloudComputer.peek())).toBe(false) // not read yet
    const closed = readCloudSnapshotNow()
    rejects[0]!(new CloudComputerError(503, 'not_open', 'not open'))
    await closed
    expect(canSetUpCloudAssistant(cloudComputer.peek())).toBe(false)

    const recovered = readCloudSnapshotNow()
    calls[1]!({ ...snap('none'), deviceId: null })
    await recovered
    expect(canSetUpCloudAssistant(cloudComputer.peek())).toBe(true)

    const failed = readCloudSnapshotNow()
    rejects[2]!(new CloudComputerError(0, 'network', 'connection reset'))
    await expect(failed).rejects.toThrow('connection reset')
    // The value stays shown, the failure is said with it; not ready to select.
    expect(cloudFailureOf(cloudComputer.peek())).toBe('network')
    expect(canSetUpCloudAssistant(cloudComputer.peek())).toBe(false)
  })

  it('an account without a cloud computer is asked once: a chat opening one more reader asks again ❌', async () => {
    const harness = createReactHarness()
    function Probe() { useCloudComputer(); return null }
    try {
      await harness.render(createElement('div', null, createElement(Probe, { key: 'shell' })))
      await settle()
      expect(calls).toHaveLength(1)
      calls[0]!({ ...snap('none'), deviceId: null })
      await vi.waitFor(() => expect(cloudComputer.peek()).toMatchObject({ state: 'value' }))
      await harness.render(createElement('div', null, createElement(Probe, { key: 'shell' }), createElement(Probe, { key: 'chat' })))
      await settle()
      expect(calls).toHaveLength(1)
    } finally { harness.cleanup() }
  })

})

describe('destroyCloudComputer', () => {
  beforeEach(() => {
    calls.length = 0
    signIn('previous')
    signIn('owner')
  })

  it('关掉成功当场就是「没有」;之后那次 /state 问到的接着落', async () => {
    const before = readCloudSnapshotNow()
    calls[0]!(snap('awake'))
    await before
    const closing = destroyCloudComputer()
    await vi.waitFor(() => expect(cloudComputer.peek()).toMatchObject({ state: 'value', value: { snapshot: { state: 'none' } } }))
    await closing
    expect(cloudComputer.peek()).toMatchObject({ state: 'value', value: { snapshot: { state: 'none', deviceId: null } } })
  })
})

describe('how often a shown value is read again (refreshEvery by value)', () => {
  it('开通 / 唤醒途中 3 秒;有一台时 30 秒;醒了但那台还没上线 3 秒;没有云电脑或没这项服务不问', () => {
    writeCachedDevices([])
    expect(cloudComputerRefreshMs(undefined)).toBe(false)
    expect(cloudComputerRefreshMs({ available: false })).toBe(false)
    expect(cloudComputerRefreshMs({ available: true, snapshot: snap('provisioning') })).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
    expect(cloudComputerRefreshMs({ available: true, snapshot: snap('asleep') })).toBe(CLOUD_COMPUTER_WATCH_MS)
    expect(cloudComputerRefreshMs({ available: true, snapshot: { ...snap('none'), deviceId: null } })).toBe(false)
    const awake = { ...snap('awake'), since: new Date().toISOString() }
    expect(cloudComputerRefreshMs({ available: true, snapshot: awake })).toBe(CLOUD_COMPUTER_FAST_POLL_MS)
    writeCachedDevices([{ device_id: 'dev-cloud', is_online: true } as Device])
    expect(cloudComputerRefreshMs({ available: true, snapshot: awake })).toBe(CLOUD_COMPUTER_WATCH_MS)
  })
})
