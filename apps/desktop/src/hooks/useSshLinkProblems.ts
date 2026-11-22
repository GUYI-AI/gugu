import type { SshLinkFailure } from '../lib/sshLink'
import { sshLinkProblems, sshUpgrades } from '../lib/sshLinkChannel'
import { useSelect } from '../lib/selectStore'

export { useSshMachineIds } from './useSshMachines'

/** 每台远程 SSH 机器的设备连接此刻的问题(没有 = 连着或还没连过)。 */
export function useSshLinkProblems(): ReadonlyMap<string, SshLinkFailure> {
  return useSelect(sshLinkProblems, (problems) => problems, Object.is)
}

/** 正在替它升级的远程 SSH 机器:deviceId → 进度百分比(不知道总量 = null)。 */
export function useSshUpgrades(): ReadonlyMap<string, number | null> {
  return useSelect(sshUpgrades, (upgrades) => upgrades, Object.is)
}
