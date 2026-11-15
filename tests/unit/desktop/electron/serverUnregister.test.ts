import { describe, expect, it, vi } from 'vitest'
import { runUnregister, UNREGISTERED_MARK, type UnregisterDeps } from '../../../../apps/desktop/electron/server/server-unregister'

// #6264 卸载时注销这台机器上的账号:从账号里移除这台机器 + 续期令牌作废 + 删本地登录态;连不上云端时留着本地登录态。
function deps(over: Partial<UnregisterDeps> = {}) {
  const lines: string[] = []
  const d: UnregisterDeps = {
    readSession: () => ({ accessToken: 'a', refreshToken: 'r' }),
    refresh: vi.fn(async () => 'fresh'),
    deviceId: vi.fn(async () => 'dev-1'),
    removeDevice: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    clearLocal: vi.fn(),
    out: (line) => void lines.push(line),
    ...over,
  }
  return { d, lines }
}

describe('gugu-server unregister', () => {
  it('换到新令牌 → 移除这台机器 → 注销 → 删本地', async () => {
    const { d, lines } = deps()
    expect(await runUnregister(d)).toBe('removed')
    expect(d.removeDevice).toHaveBeenCalledWith('fresh', 'dev-1')
    expect(d.revoke).toHaveBeenCalledWith('fresh')
    expect(d.clearLocal).toHaveBeenCalledOnce()
    expect(lines).toEqual([`${UNREGISTERED_MARK} removed`])
  })

  it('库拒了移除(绑着智能体)⇒ 只注销;换不到令牌(已失效 / 没网)⇒ 只删本地', async () => {
    const refused = deps({ removeDevice: vi.fn(async () => { throw new Error('DEVICE_HAS_AGENTS') }) })
    expect(await runUnregister(refused.d)).toBe('revoked')
    const rejected = deps({ refresh: vi.fn(async () => null) })
    expect(await runUnregister(rejected.d)).toBe('local')
    expect(rejected.d.clearLocal).toHaveBeenCalledOnce()
  })

  it('连不上云端 ⇒ unreachable,本地登录态留着(卸载据此中止,网络好了重卸能补上)', async () => {
    for (const [over, cause] of [
      [{ refresh: vi.fn(async () => { throw new Error('ENOTFOUND') }) }, 'ENOTFOUND'],
      [{ deviceId: vi.fn(async () => { throw new Error('fetch\nfailed') }) }, 'fetch failed'],
    ] as const) {
      const { d, lines } = deps(over)
      expect(await runUnregister(d)).toBe('unreachable')
      expect(d.clearLocal).not.toHaveBeenCalled()
      expect(d.revoke).not.toHaveBeenCalled()
      expect(lines).toEqual([`${UNREGISTERED_MARK} unreachable ${cause}`])
    }
  })

  it('没登录态:什么都不做', async () => {
    const { d, lines } = deps({ readSession: () => null })
    expect(await runUnregister(d)).toBe('none')
    expect(lines).toEqual([])
  })
})
