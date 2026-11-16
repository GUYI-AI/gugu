import { useCallback, useMemo } from 'react'
import { rendererLogger } from './log'
import { replica, useReplicas } from './replica'
import { platform } from '../platform'
import type { SystemPermission, SystemPermissionState } from '../platform/types'

/**
 * 手机「我的 → 权限」页的模型(product spec)。参照 rsend 的权限面板取三条:
 * 状态以系统为准、每一行都点得动、按「缺了的后果」分开处理 —— 前两条落在这里,第三条落在各自的动作上。
 */

/**
 * 每一项权限长什么样(标题 + 一句「用来……」)。**这里不决定列哪几行** ——
 * 列哪几行是 `platform.systemPermissions` 说的(product spec),
 * 这份只是目录:宿主报了哪一项,就到这儿取它的文案。
 */
export const SYSTEM_PERMISSION_ROWS: ReadonlyArray<{
  permission: SystemPermission
  labelKey: string
  /** 一句「用来……」:说用户认得出的功能,不说权限名。 */
  purposeKey: string
}> = [
  {
    permission: 'notifications',
    labelKey: 'settings.permissions.notifications',
    purposeKey: 'settings.permissions.notificationsPurpose',
  },
  {
    // 它不是安卓意义上的「运行时权限」,但在这一页上是同一件事:系统让不让咕咕做这件事,
    // 用户点一下就能改。少了它,部分厂商的系统在息屏后照样掐掉连接,提醒还是收不到。
    permission: 'batteryOptimization',
    labelKey: 'settings.permissions.batteryOptimization',
    purposeKey: 'settings.permissions.batteryOptimizationPurpose',
  },
  {
    permission: 'camera',
    labelKey: 'settings.permissions.camera',
    purposeKey: 'settings.permissions.cameraPurpose',
  },
  {
    permission: 'microphone',
    labelKey: 'settings.permissions.microphone',
    purposeKey: 'settings.permissions.microphonePurpose',
  },
  {
    permission: 'fileAccess',
    labelKey: 'settings.permissions.fileAccess',
    purposeKey: 'settings.permissions.fileAccessPurpose',
  },
]

/** 宿主报的清单,已按目录顺序取好文案。页面直接渲染它。 */
export function systemPermissionRows(): typeof SYSTEM_PERMISSION_ROWS {
  return SYSTEM_PERMISSION_ROWS.filter((row) => platform.systemPermissions.includes(row.permission))
}

/**
 * 点一行该做什么:系统还肯弹框就弹;不肯弹了(blocked),或者已经开着(想关的人只能去系统设置关),
 * 就直达系统设置。❌ 第三种「什么也不做」—— 那就是 rsend 被拒两次后变成死按钮的那一格。
 */
export function systemPermissionAction(state: SystemPermissionState): 'request' | 'open-settings' {
  return state === 'prompt' ? 'request' : 'open-settings'
}

/** One action for the permissions page and the phone installation guide; false means no settings destination. */
export async function changeSystemPermission(permission: SystemPermission, state: SystemPermissionState): Promise<boolean> {
  if (systemPermissionAction(state) === 'request') {
    await platform.requestSystemPermission(permission)
    return true
  }
  return platform.openSystemPermissionSettings(permission)
}

export type SystemPermissionStates = Partial<Record<SystemPermission, SystemPermissionState>>

const permissionLog = rendererLogger('system-permissions')

/** 一项系统权限此刻的真值(device):挂上时读,回到前台再读;❌ 缓存 / 持久化,读不到就明说。 */
export const systemPermission = replica({
  name: 'systemPermission',
  scope: 'device',
  read: (_device: string, permission: SystemPermission): Promise<SystemPermissionState> => platform.checkSystemPermission(permission),
  // The foreground watch is shared: on while any surface shows a permission.
  watch: {
    start: () => platform.subscribeAppForeground(() => { void systemPermission.refresh() }, (error) => {
      permissionLog.error({ error: String(error) }, 'could not watch the app coming back to the foreground; permissions are read on open only')
    }),
  },
})

/** 读系统真值;没有 `systemPermissions` 能力位的宿主什么都不读。`states` 只有读到了的那几项(没读到的由调用方画占位)。 */
export function useSystemPermissionStates(permissions: readonly SystemPermission[]): { states: SystemPermissionStates; refresh: () => Promise<void>; failed: boolean } {
  // 只读宿主报得出的那几项(❌ 试一把再吞掉异常)。
  const key = permissions.filter((permission) => platform.systemPermissions.includes(permission)).join(',')
  const wanted = useMemo(() => (key ? key.split(',') as SystemPermission[] : []), [key])
  const readings = useReplicas(systemPermission, wanted.map((permission) => [permission] as [SystemPermission]))
  const refresh = useCallback(async () => {
    await Promise.all(wanted.map((permission) => systemPermission.refresh(permission)))
  }, [wanted])
  // 读不到就明说读不到(调用方渲染提示):一次重读失败也是读不到,这时不交上一次的值。
  const failed = readings.some((reading) => reading.state === 'error' || (reading.state === 'value' && !!reading.error))
  const states: SystemPermissionStates = {}
  if (!failed) {
    wanted.forEach((permission, index) => {
      const reading = readings[index]!
      if (reading.state === 'value') states[permission] = reading.value
    })
  }
  return { states, refresh, failed }
}
