import { replica } from '@/lib/replica'
import { importProviders } from './import-providers'

export const importSourceCounts = replica({
  name: 'settingsImportSourceCounts',
  scope: 'account',
  keep: 5 * 60_000,
  refreshJoinsRead: true,
  read: async (_owner, sourceId: string, deviceId: string | null) => {
    const provider = importProviders.find(({ id }) => id === sourceId)
    return provider ? await provider.scan(deviceId) : null
  },
})
