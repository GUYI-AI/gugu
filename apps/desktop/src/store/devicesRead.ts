import type { Device } from '@gugu/core/shared/types/chat'
import { withDeviceProjects } from '@gugu/core/cloud/deviceProjects'
import { chatService } from '../lib/chat'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { isLocalDeviceUnidentified } from '../lib/localDeviceIdentity'
import { listMyDeviceProjects } from '../lib/deviceProjects'
import { rendererLogger } from '../lib/log'
import { SERVER_SSH_MACHINES_CHANNELS } from '../lib/serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'
import { devicesModel, readCachedDevices } from './devicesCache'
import { withProjectsRead } from './deviceProjectsRead'

const devicesLog = rendererLogger('devices')

/** One full read of the account's machines and the projects each carries (the devices read model's reader). */
export async function readDevices(owner: string): Promise<Device[]> {
  // 上一份读到的(设备行上带着各台机器记在账号上的项目):这一次项目没读到,就沿用这一份。
  const previous = readCachedDevices()
  // #7199 一次读全(含手机):设置 → 设备要列出手机;「在哪跑」等只读拆出来的 devices(没有手机)。
  // #113 同时读账号上记着的各台机器的项目:那份读不到不拖垮设备列表 —— 各台沿用上一份,但记下没读到(projects_error),
  // 画项目文件夹的地方把它们标成「上次的」。
  let projectsError: string | null = null
  try {
    const [listed, projects] = await Promise.all([
      chatService.listDevices({ includePhones: true }),
      listMyDeviceProjects().catch((err: unknown) => {
        if (isLifecycleCancellation(err)) throw err
        projectsError = String((err as Error)?.message ?? err)
        devicesLog.warn({ err: projectsError }, 'list device projects failed')
        return null
      }),
    ])
    const rows = withProjectsRead(withDeviceProjects(listed, projects, previous), projectsError, previous)
    // #6264 在别的电脑上被移除的远程 SSH 机器,这台电脑也忘掉它(只凭刚成功读到的完整名单对账)。
    void desktopIpc()?.invoke(SERVER_SSH_MACHINES_CHANNELS.reconcile, { owner, present: rows.map((row) => row.device_id) }).catch(() => undefined)
    return rows
  } catch (err) {
    // Not a failure: this computer is not identified yet, so no row of this read can be told apart as its own.
    // The list on screen (its own row marked) stays; the read is repeated the moment it is identified.
    if (isLocalDeviceUnidentified(err) && devicesModel.peek().state === 'value') {
      devicesLog.info({}, 'device list kept until this computer is identified among the account devices')
      return previous
    }
    // fail-loud:原因只进日志,不拼进用户那句话(#4891)——用户拿到的是「怎么办」,排查的人拿到的是「为什么」。
    if (!isLifecycleCancellation(err)) devicesLog.error({ err: String((err as Error)?.message ?? err) }, 'list devices failed')
    throw err
  }
}
