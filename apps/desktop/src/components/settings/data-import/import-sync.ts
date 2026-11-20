import { syncCategoryEnabled } from './environment-import-view'
import { i18n } from '@/i18n'
import { sessionCoordinator } from '@/lib/sessionCoordinator'
import { fetchAppSettingValue } from '@renderer/features/settings/app-settings-client'
import { rendererLogger } from '@/lib/log'
import { importProviders } from './import-providers'
import { enqueueImport } from './import-queue'

const INTERVAL = 10 * 60_000
const log = rendererLogger('data-import-sync')
const activeScans = new Set<string>()

export async function syncImports(ownerId: string, signal?: AbortSignal): Promise<void> {
  const stillSignedIn = () => !signal?.aborted && sessionCoordinator.getSnapshot().user?.id === ownerId
  if (!stillSignedIn() || activeScans.has(ownerId)) return
  activeScans.add(ownerId)
  try {
    const settings = await fetchAppSettingValue('dataImport')
    const preferences = settings.owners[ownerId]
    if (!preferences?.automatic || !stillSignedIn()) return
    const t = i18n.getFixedT(null, 'main')
    for (const provider of importProviders) {
      if (!stillSignedIn()) break
      const connected = preferences.sources.includes(provider.id) || !!provider.sourceId && preferences.sources.includes(provider.sourceId)
      const selected = syncCategoryEnabled(preferences.categories, provider.category)
      if (!provider.supportsAutomaticSync || !connected || !selected) continue
      try {
        let reading = await provider.scan(null)
        while (reading?.pending && stillSignedIn()) {
          await new Promise((resolve) => setTimeout(resolve, 1200))
          if (!stillSignedIn()) break
          reading = await provider.scan(null)
        }
        const latest = await fetchAppSettingValue('dataImport')
        const latestPreferences = latest.owners[ownerId]
        if (!latestPreferences?.automatic || !stillSignedIn()) break
        if (!syncCategoryEnabled(latestPreferences.categories, provider.category)) continue
        if (reading?.count) enqueueImport(ownerId, {
          provider, automatic: true, seen: latestPreferences.categoryAttempts?.[provider.id],
          devices: [{ deviceId: null, deviceName: t('settings.dataImport.thisComputer'), count: reading.count }],
        }, t)
      } catch (error) {
        log.warn({ error, provider: provider.id }, 'Could not scan an import source')
      }
    }
  } catch (error) {
    log.warn({ error }, 'Could not read automatic import settings')
  } finally {
    activeScans.delete(ownerId)
  }
}

export function startImportSync(ownerId: string, signal: AbortSignal): void {
  if (signal.aborted) return
  const run = () => { void syncImports(ownerId, signal) }
  const timer = setInterval(run, INTERVAL)
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  run()
}
