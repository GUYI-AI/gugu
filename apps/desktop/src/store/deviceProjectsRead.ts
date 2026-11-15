import type { Device } from '@gugu/core/shared/types/chat'

type Row = Pick<Device, 'device_id' | 'projects_error'>

/**
 * 这一次读各台机器项目的结果记在设备行上:读到了 = 去掉 `projects_error`;没读到(`error`)= 记下原因,那台的
 * `projects` 还是更早的那份,画它的地方标「上次的」(❌ 当成此刻的事实)。
 * `readFor` = 这一次只读了这几台;其余各台照 `previous` 里它的那一格。
 */
export function withProjectsRead<T extends Row>(
  rows: readonly T[],
  error: string | null,
  previous: readonly Row[],
  readFor?: ReadonlySet<string>,
): T[] {
  return rows.map((row) => {
    const projectsError = !readFor || readFor.has(row.device_id)
      ? error
      : previous.find((one) => one.device_id === row.device_id)?.projects_error ?? null
    const { projects_error: _last, ...rest } = row
    return (projectsError ? { ...rest, projects_error: projectsError } : rest) as T
  })
}
