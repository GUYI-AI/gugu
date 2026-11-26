import type { SshLinkFailure } from '../lib/sshLink'
import { sshLinkProblems, sshUpgrades } from '../lib/sshLinkChannel'
import { useSelect } from '../lib/selectStore'

export { useSshMachineIds } from './useSshMachines'

/** 每台 SSH 机器的观测：未观测时没有记录，已连接为 null，其余为最后收到的原因。 */
export function useSshLinkProblems(): ReadonlyMap<string, SshLinkFailure | null> {
  return useSelect(sshLinkProblems, (problems) => problems, Object.is)
}

/** 正在替它升级的远程 SSH 机器:deviceId → 进度百分比(不知道总量 = null)。 */
export function useSshUpgrades(): ReadonlyMap<string, number | null> {
  return useSelect(sshUpgrades, (upgrades) => upgrades, Object.is)
}
