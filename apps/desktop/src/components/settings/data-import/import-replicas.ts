import { replica } from '@/lib/replica'
import { rendererLogger } from '@/lib/log'

import { locateImportProvider } from './import-providers'

const log = rendererLogger('settings/data-import')

export const importSourceCounts = replica({
  name: 'settingsImportSourceCounts',
  scope: 'account',
  keep: 5 * 60_000,
  refreshJoinsRead: true,
  read: async (_owner, sourceId: string, deviceId: string | null) => {
    const provider = locateImportProvider(sourceId)
    try {
      return provider ? await provider.scan(deviceId) : null
    } catch (error) {
      log.warn({ sourceId, deviceId, error }, 'Import source scan failed')
      throw error
    }
  },
})

export const importedSourceHistory = replica({
  name: 'settingsImportedSourceHistory',
  scope: 'account',
  keep: 5 * 60_000,
  read: async (_owner, sourceId: string) => await locateImportProvider(sourceId)?.listHistory?.(null) ?? [],
})
