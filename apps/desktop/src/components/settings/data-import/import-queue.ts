import type { TFunction } from 'i18next'
import { importSourceCounts, importedSourceHistory } from './import-replicas'
import { updateImportSettings } from './import-sync-preferences'
import { notify } from '@/lib/notices'
import { sessionCoordinator } from '@/lib/sessionCoordinator'
import type { ImportPreparation, ImportOutcome, ImportedEntity, ImportedSession, ImportProvider } from './import-providers'

export type ImportDevice = { deviceId: string | null; deviceName: string; count: number }
export type ImportedEntry = ImportedSession & { deviceId: string | null; deviceName?: string }
export type ImportTarget = { devices: readonly ImportDevice[]; provider: ImportProvider; automatic?: boolean; seen?: Readonly<Record<string, string>> }
type JobResult = { imported: ImportedEntry[]; entities: ImportedEntity[]; details: ImportOutcome[]; attempts: Record<string, string>; existing: number; failed: number }
export type ImportJob = ImportTarget & {
  id: string
  ownerId: string
  state: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'finished' | 'failed'
  done: number
  total: number
  preparation?: ImportPreparation | null
  finishedAt?: number
  result?: JobResult
}

type QueueEntry = { job: ImportJob; controller: AbortController; t: TFunction<'main'> }
const listeners = new Set<() => void>()
let jobs: readonly ImportJob[] = []
let sequence = 0
const waiting: QueueEntry[] = []
let current: QueueEntry | undefined

export const importJobs = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot: () => jobs,
}

export function isActiveImport(job: ImportJob): boolean {
  return job.state === 'queued' || job.state === 'running' || job.state === 'cancelling'
}

function publish(entry: QueueEntry, change: Partial<ImportJob>): void {
  entry.job = { ...entry.job, ...change }
  jobs = [entry.job, ...jobs.filter(({ id }) => id !== entry.job.id)]
  for (const listener of listeners) listener()
}

export function enqueueImport(ownerId: string, target: ImportTarget, t: TFunction<'main'>): void {
  if (jobs.some((job) => job.ownerId === ownerId && job.provider.id === target.provider.id && isActiveImport(job) &&
    job.devices.some(({ deviceId }) => target.devices.some((device) => device.deviceId === deviceId)))) return
  const entry: QueueEntry = {
    job: { ...target, provider: target.provider.capture?.(target.automatic ? target.seen : undefined) ?? target.provider, id: String(++sequence), ownerId, state: 'queued', done: 0, total: 0 },
    controller: new AbortController(),
    t,
  }
  waiting.push(entry)
  publish(entry, {})
  void runNext()
}

export function cancelImport(id: string): void {
  if (current?.job.id === id) {
    current.controller.abort()
    publish(current, { state: 'cancelling' })
    return
  }
  const index = waiting.findIndex(({ job }) => job.id === id)
  if (index < 0) return
  const [entry] = waiting.splice(index, 1)
  publish(entry!, { state: 'cancelled', finishedAt: Date.now() })
}

export function cancelAutomaticImports(ownerId: string): void {
  for (const job of jobs) if (job.ownerId === ownerId && job.automatic && isActiveImport(job)) cancelImport(job.id)
}

async function runNext(): Promise<void> {
  if (current) return
  const entry = waiting.shift()
  if (!entry) return
  current = entry
  const { job, controller, t } = entry
  const ownsImport = () => sessionCoordinator.getSnapshot().user?.id === job.ownerId
  const unsubscribe = sessionCoordinator.subscribe(() => {
    if (!ownsImport()) controller.abort()
  })
  const key = `settings-data-import-${job.id}`
  try {
    if (!ownsImport()) {
      publish(entry, { state: 'cancelled', finishedAt: Date.now() })
      return
    }
    publish(entry, { state: 'running' })
    if (!job.automatic) notify({ key, tier: 'info', title: t('settings.dataImport.started', { source: job.provider.label }) })
    const result: JobResult = { imported: [], entities: [], details: [], attempts: {}, existing: 0, failed: 0 }
    let processed = 0
    let total = job.devices.reduce((sum, device) => sum + device.count, 0)
    for (const device of job.devices) {
      if (controller.signal.aborted) break
      let deviceDone = 0
      let deviceTotal = device.count
      try {
        const read = await job.provider.importAll(device.deviceId, (done, actualTotal, preparation) => {
          total += actualTotal - deviceTotal
          deviceTotal = actualTotal
          deviceDone = done
          publish(entry, { done: processed + done, total, preparation })
        }, controller.signal)
        result.imported.push(...read.imported.map((session) => ({
          ...session, deviceId: device.deviceId, deviceName: device.deviceName,
        })))
        result.entities.push(...(read.entities ?? []))
        result.details.push(...(read.details ?? []))
        Object.assign(result.attempts, read.attempts)
        result.existing += read.existing
        result.failed += read.failed
      } catch {
        result.failed += deviceTotal - deviceDone
        deviceDone = deviceTotal
      }
      processed += deviceDone
      publish(entry, { done: processed, total })
    }
    const cancelled = controller.signal.aborted
    const count = result.imported.length + result.entities.length
    const failed = result.failed
    publish(entry, { state: cancelled ? 'cancelled' : 'finished', result, finishedAt: Date.now() })
    if (ownsImport() && (result.details.length > 0 || Object.keys(result.attempts).length > 0 || result.entities.length > 0 || result.existing > 0 || result.imported.some(({ deviceId }) => deviceId === null))) {
      void updateImportSettings(job.ownerId, (before) => ({
        ...before,
        sources: [...new Set([...before.sources, job.provider.id])],
        categoryAttempts: { ...before.categoryAttempts, [job.provider.id]: { ...before.categoryAttempts?.[job.provider.id], ...result.attempts } },
        categoryResults: result.details.length ? [{ providerId: job.provider.id, finishedAt: Date.now(), items: result.details }, ...(before.categoryResults ?? [])].slice(0, 50) : before.categoryResults,
      })).catch(() => notify({ tier: 'error', title: t('settings.dataImport.syncSaveFailed') }))
    }
    if (ownsImport() && (!job.automatic || count > 0 || failed > 0)) {
      notify({
        key,
        tier: failed > 0 ? 'warning' : 'success',
        title: cancelled ? t('settings.dataImport.cancelledSummary', { count }) :
          failed > 0 ? t('settings.dataImport.partialSummary', { count, failed }) :
            count === 0 && result.existing > 0 ? t('settings.dataImport.alreadyImported', { count: result.existing }) :
            t(job.automatic ? 'settings.dataImport.synced' : 'settings.dataImport.result', { count }),
      })
    }
  } catch {
    publish(entry, { state: 'failed', finishedAt: Date.now() })
    if (ownsImport()) notify({ key, tier: 'error', title: t('settings.dataImport.failed') })
  } finally {
    unsubscribe()
    if (ownsImport()) {
      void importSourceCounts.refresh(job.provider.id)
      void importedSourceHistory.refresh(job.provider.id)
    }
    current = undefined
    void runNext()
  }
}
