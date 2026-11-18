import type { AppSettings } from '@shared/core/app-settings'
import { fetchAppSettingValue, setAppSettingsValueInCache, updateAppSettingsRequest } from '@renderer/features/settings/app-settings-client'

type OwnerImportSettings = AppSettings['dataImport']['owners'][string]
export const EMPTY_IMPORT_SETTINGS: OwnerImportSettings = { automatic: false, sources: [] }

let writes: Promise<void> = Promise.resolve()

export function updateImportSettings(ownerId: string, change: (before: OwnerImportSettings) => OwnerImportSettings): Promise<void> {
  const operation = writes.then(async () => {
    const before = await fetchAppSettingValue('dataImport')
    const after = { owners: {
      ...before.owners,
      [ownerId]: change(before.owners[ownerId] ?? EMPTY_IMPORT_SETTINGS),
    } }
    await updateAppSettingsRequest('dataImport', after)
    setAppSettingsValueInCache('dataImport', after)
  })
  writes = operation.catch(() => {})
  return operation
}
