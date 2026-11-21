/**
 * #6264 渲染层这一侧:主进程替远程 SSH 的机器升级时报来的每一步,落成这台机器设备连接的状况 ——
 * 在升 → 「正在更新」(带进度);升好 → 清掉问题并当场重连(与刚登上同一条路);没升成 → 「版本太旧」。
 */
import { describe, expect, it } from 'vitest'
import {
  applyUpgradeEvent,
  onSshMachineSignedIn,
  sshLinkProblems,
  sshUpgrades,
  subscribeSshUpgradeEvents,
} from '../../../../apps/desktop/src/lib/sshLinkChannel'

describe('替它升级的每一步 → 设备连接的状况', () => {
  it('updating(带进度)→ done:问题清掉、当场重连;failed:停在「版本太旧」', () => {
    const reopened: string[] = []
    const offSignedIn = onSshMachineSignedIn((deviceId) => reopened.push(deviceId))

    applyUpgradeEvent({ deviceId: 'd22', phase: 'updating', percent: null })
    expect(sshLinkProblems.get().get('d22')).toBe('updating')
    expect(sshUpgrades.get().get('d22')).toBeNull()
    applyUpgradeEvent({ deviceId: 'd22', phase: 'updating', percent: 40 })
    expect(sshUpgrades.get().get('d22')).toBe(40)

    applyUpgradeEvent({ deviceId: 'd22', phase: 'done' })
    expect(sshLinkProblems.get().has('d22')).toBe(false)
    expect(sshUpgrades.get().has('d22')).toBe(false)
    expect(reopened).toEqual(['d22'])

    applyUpgradeEvent({ deviceId: 'd23', phase: 'updating', percent: 10 })
    applyUpgradeEvent({ deviceId: 'd23', phase: 'failed' })
    expect(sshLinkProblems.get().get('d23')).toBe('outdated')
    expect(sshUpgrades.get().has('d23')).toBe(false)
    expect(reopened).toEqual(['d22'])

    offSignedIn()
  })

  it('an unconfirmed observation stops local progress without claiming a switch or reconnecting', () => {
    const events: string[] = []
    const offEvents = subscribeSshUpgradeEvents(event => events.push(event.phase))
    const offSignedIn = onSshMachineSignedIn(() => events.push('reconnected'))
    applyUpgradeEvent({ deviceId: 'pending', phase: 'updating' })
    applyUpgradeEvent({ deviceId: 'pending', phase: 'unconfirmed', request: 42, reportedVersion: '1.0.0' })
    expect(sshUpgrades.get().has('pending')).toBe(false)
    expect(events).toEqual(['updating', 'unconfirmed'])
    offEvents(); offSignedIn()
  })
})
