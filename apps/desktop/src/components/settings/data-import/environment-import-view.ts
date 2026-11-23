import type { AppSettings } from '@shared/core/app-settings'
import type { EnvironmentImportCategory } from '@shared/core/session-import/environment-import'
import type { ImportProvider } from './import-providers'

export const categoryLabelKey = (category: EnvironmentImportCategory) => ({
  tasks: 'settings.dataImport.tasks', projects: 'settings.dataImport.projects',
  memories: 'settings.dataImport.memories', skills: 'settings.dataImport.skills',
  connectors: 'settings.dataImport.connectors',
} as const)[category]

export function groupImportProviders(providers: readonly ImportProvider[]) {
  const groups = new Map<string, { id: string; label: string; providers: ImportProvider[] }>()
  for (const provider of providers) {
    const id = provider.sourceId ?? provider.id
    let group = groups.get(id)
    if (!group) { group = { id, label: provider.sourceLabel ?? provider.label, providers: [] }; groups.set(id, group) }
    group.providers.push(provider)
  }
  return [...groups.values()]
}

export function outcomeLabelKey(status?: string, reason?: string) {
  if (status === 'imported') return 'settings.dataImport.outcomeImported' as const
  if (status === 'existing') return 'settings.dataImport.outcomeExists' as const
  if (reason === 'source-changed') return 'settings.dataImport.outcomeChanged' as const
  if (reason?.startsWith('missing-') || reason === 'source-missing') return 'settings.dataImport.outcomeMissing' as const
  if (status === 'conflict') return 'settings.dataImport.outcomeConflict' as const
  return status === 'failed' ? 'settings.dataImport.outcomeFailed' as const : 'settings.dataImport.outcomeUnsupported' as const
}

/** Old persisted preferences only covered sessions, and must not silently opt in to new categories. */
export function syncCategoryEnabled(categories: readonly EnvironmentImportCategory[] | undefined, category: EnvironmentImportCategory = 'tasks') {
  return (categories ?? ['tasks']).includes(category)
}


type StoredCategoryGroup = NonNullable<AppSettings['dataImport']['owners'][string]['categoryResults']>[number]
type CategoryGroup = Omit<StoredCategoryGroup, 'items'> & { items: readonly StoredCategoryGroup['items'][number][] }
type CategorySettingsReading = { state: 'unknown' | 'error' } | { state: 'value'; value: AppSettings['dataImport'] }

/**
 * Each category's current result, not a log of runs: per category the latest run that changed something. A run that
 * found every item already here imported nothing, so it is no result. Used where results are kept and where they are shown.
 */
export function currentCategoryResults<T extends CategoryGroup>(groups: readonly T[]): T[] {
  const latest = new Map<string, T>()
  for (const group of groups) {
    if (!group.items.some(item => item.status !== 'existing')) continue
    const kept = latest.get(group.providerId)
    if (!kept || group.finishedAt > kept.finishedAt) latest.set(group.providerId, group)
  }
  return [...latest.values()].sort((a, b) => b.finishedAt - a.finishedAt)
}

/** Keep the unread history state while showing this interaction's already completed results. */
export function categoryHistoryReading(completed: readonly CategoryGroup[], reading: CategorySettingsReading, ownerId?: string) {
  const stored = reading.state === 'value' && ownerId ? reading.value.owners[ownerId]?.categoryResults ?? [] : []
  return { state: reading.state, items: currentCategoryResults([...completed, ...stored]) }
}
