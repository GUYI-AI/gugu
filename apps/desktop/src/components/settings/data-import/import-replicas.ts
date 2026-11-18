import { replica } from '@/lib/replica'
import { locateImportProvider } from './import-providers'

export const importSourceCounts = replica({
  name: 'settingsImportSourceCounts',
  scope: 'account',
  keep: 5 * 60_000,
  refreshJoinsRead: true,
  read: async (_owner, sourceId: string, deviceId: string | null) => {
    const provider = locateImportProvider(sourceId)
    return provider ? await provider.scan(deviceId) : null
  },
})

export const importedSourceHistory = replica({
  name: 'settingsImportedSourceHistory',
  scope: 'account',
  keep: 5 * 60_000,
  read: async (_owner, sourceId: string) => await locateImportProvider(sourceId)?.listHistory?.(null) ?? [],
})
