import { AgentHomePreparationStatus } from './AgentHomePreparationStatus'
import { ENVIRONMENT_IMPORT_CATEGORIES } from '@shared/core/session-import/environment-import'
import { categoryLabelKey, groupImportProviders } from './environment-import-view'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Clock, FileText, X } from '@/lib/icons'
import { useReplicas } from '@/lib/replica'
import { importSourceCounts } from './import-replicas'
import { notify } from '@/lib/notices'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Button } from '@/components/ui/Button'
import { MachineList } from '@/components/ui/MachineList'
import { Collapse } from '@/components/ui/Collapse'
import { AppIcon } from '@renderer/lib/components/app-icon'
import { AgentIcon } from '@renderer/lib/components/agent-icon'
import type { MachineChoice } from '@renderer/features/remote-hosts/machine-choice'
import type { ImportProvider } from './import-providers'
import { cancelImport, enqueueImport, isActiveImport, type ImportJob } from './import-queue'

type SourceReading = ReturnType<typeof useReplicas<[string, string | null], Awaited<ReturnType<ImportProvider['scan']>>>>[number]

function useSources(providers: readonly ImportProvider[], deviceId: string | null, enabled: boolean) {
  const readings = useReplicas(importSourceCounts, enabled ? providers.map(({ id }) => [id, deviceId]) : [])
  const indexing = readings.some((reading) => reading.state === 'value' && reading.value?.pending)
  useEffect(() => {
    if (!indexing || !enabled) return
    const timer = setInterval(() => { void importSourceCounts.refresh(undefined, deviceId) }, 1200)
    return () => clearInterval(timer)
  }, [indexing, enabled, deviceId])
  return providers.map((provider, index) => ({ provider, reading: readings[index] }))
}

export function ImportSourceIcon({ provider }: { provider: ImportProvider }) {
  return (
    <span aria-hidden="true" className="gg-import-icon">
      {provider.historyOnly && provider.pickSource ? <FileText size={24} /> : <AppIcon id={provider.iconId} size={24} />}
    </span>
  )
}

function ImportProgress({ job, label }: { job: ImportJob; label: string }) {
  const { t } = useTranslation('main')
  const { state } = job
  const pendingCancel = state === 'cancelling'
  const canCancel = state === 'queued' || state === 'running'
  const stateLabel = state === 'running' && job.preparation?.phase === 'history'
    ? <AgentHomePreparationStatus preparation={{ phase: 'history', startedAt: job.preparation.startedAt, attempt: 1 }} />
    : state === 'running' && job.total > 0 ? `${job.done}/${job.total}`
    : state === 'running' ? t('settings.dataImport.reading')
    : state === 'queued' ? t('settings.dataImport.queued')
    : pendingCancel ? t('settings.dataImport.cancelling')
    : state === 'cancelled' ? t('settings.dataImport.cancelled')
    : t('settings.dataImport.imported')
  return (
    <div className={canCancel ? 'gg-import-action' : undefined}>
      <span className="gg-import-progress" role="status">
        {stateLabel}
        {state === 'running' || pendingCancel ? <LoadingIndicator size="inline" /> :
          state === 'queued' ? <Clock size={16} /> : state === 'cancelled' ? <X size={16} /> : <Check size={16} />}
      </span>
      {canCancel && (
        <Button className="gg-import-cancel" variant="secondary" size="sm" onClick={() => cancelImport(job.id)} aria-label={t('settings.dataImport.cancelSource', { source: label })}>
          {t('settings.dataImport.cancel')}
        </Button>
      )}
    </div>
  )
}

function findJob(jobs: readonly ImportJob[], providerId: string, deviceId: string | null) {
  return jobs.find((job) => job.provider.id === providerId && job.devices.some((device) => device.deviceId === deviceId))
}

function sourceCount(reading?: SourceReading): number | undefined {
  const count = reading?.state === 'value' && reading.value && !reading.value.pending && !reading.value.needsSource ? reading.value.count : undefined
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

function sourceDescription(t: ReturnType<typeof useTranslation<'main'>>['t'], reading?: SourceReading) {
  if (reading?.state === 'error') return t('settings.dataImport.readFailed')
  if (reading?.state === 'value' && reading.value?.needsSource) return t('settings.dataImport.chooseHint')
  const count = sourceCount(reading)
  return count === undefined ? t('settings.dataImport.reading') : t('settings.dataImport.available', { count })
}

type RowsProps = { providers: readonly ImportProvider[]; ownerId: string; jobs: readonly ImportJob[] }

function SourceAction({ provider, reading, ownerId, deviceId, deviceName, job }: {
  provider: ImportProvider; reading?: SourceReading; ownerId: string
  deviceId: string | null; deviceName: string; job?: ImportJob
}) {
  const { t } = useTranslation('main')
  const [picking, setPicking] = useState(false)
  const count = sourceCount(reading)
  const pick = provider.pickSource
  const needsFile = !!pick && ((reading?.state === 'value' && reading.value?.needsSource) || count === 0)
  async function selectFile() {
    if (!pick) return
    setPicking(true)
    try {
      await pick(deviceId)
      await importSourceCounts.refresh(provider.id, deviceId)
    } catch {
      notify({ tier: 'error', title: t('settings.dataImport.readFailed') })
    } finally {
      setPicking(false)
    }
  }
  if (job && isActiveImport(job)) return <ImportProgress job={job} label={provider.label} />
  if (job?.state === 'finished' && count === 0 && !needsFile) return <ImportProgress job={job} label={provider.label} />
  return needsFile ? (
    <Button variant="secondary" size="sm" disabled={picking} onClick={() => { void selectFile() }}>
      {t('settings.dataImport.pickSource')}
    </Button>
  ) : (
    <Button variant="secondary" size="sm" disabled={!count} aria-label={t('settings.dataImport.importSource', { source: provider.label })}
      onClick={() => count && enqueueImport(ownerId, { devices: [{ deviceId, deviceName, count }], provider }, t)}>
      {t('settings.dataImport.action')}
    </Button>
  )
}

function ImportCard({ icon, name, description, open, onToggle, children }: {
  icon: ReactNode; name: string; description: ReactNode; open: boolean
  onToggle: () => void; children: ReactNode
}) {
  const id = useId()
  return (
    <article className="gg-import-card">
      <Button variant="ghost" className="gg-import-card-trigger" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        {icon}
        <span className="gg-import-copy">
          <span className="gg-import-name">{name}</span>
          <span className="gg-import-meta">{description}</span>
        </span>
        <ChevronRight size={16} className="gg-import-chevron" />
      </Button>
      <Collapse id={id} open={open} className="gg-import-collapse">
        <div className="gg-import-details">{children}</div>
      </Collapse>
    </article>
  )
}

function ImportRow({ label, job, children, summary }: { label: ReactNode; job?: ImportJob; children: ReactNode; summary?: boolean }) {
  return (
    <div className="gg-import-row" data-summary={summary || undefined} data-cancellable={job?.state === 'running' || job?.state === 'queued' || undefined}>
      <div className="gg-import-row-label">{label}</div>
      {children}
    </div>
  )
}

export function LocalImportSources({ providers, ownerId, jobs }: RowsProps) {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState<string | null>('codex')
  const sources = useSources(providers, null, true)
  const groups = groupImportProviders(providers)
  return (
    <div className="gg-import-stack">
      {groups.map(group => {
        const rows = group.providers.map(provider => sources.find(source => source.provider.id === provider.id)!)
        if (rows.every(({ reading }) => reading?.state === 'value' && reading.value === null)) return null
        const failed = rows.some(({ reading }) => reading?.state === 'error')
        const choosingFile = rows.some(({ reading }) => reading?.state === 'value' && reading.value?.needsSource)
        const settled = rows.every(({ reading }) => reading?.state === 'error'
          || (reading?.state === 'value' && (reading.value === null || reading.value.needsSource || sourceCount(reading) !== undefined)))
        const ready = rows.every(({ reading }) => sourceCount(reading) !== undefined)
        const total = ready ? rows.reduce((sum, { reading }) => sum + sourceCount(reading)!, 0) : undefined
        const active = jobs.some(job => isActiveImport(job) && group.providers.some(provider => provider.id === job.provider.id))
        const first = group.providers[0]!
        return (
          <ImportCard key={group.id} name={group.label}
            description={choosingFile ? t('settings.dataImport.pickSource') : !settled ? t('settings.dataImport.reading')
              : failed ? t('settings.dataImport.sourceIncomplete') : total === undefined ? t('settings.dataImport.categoryUnavailable') : t(first.historyOnly ? 'settings.dataImport.readOnlyHistory' : 'settings.dataImport.environmentAvailable', { count: total })}
            icon={<ImportSourceIcon provider={first} />} open={open === group.id}
            onToggle={() => setOpen(open === group.id ? null : group.id)}>
            <ImportRow summary label={total === undefined ? t('settings.dataImport.scopeAll') : t('settings.dataImport.allCount', { count: total })}>
              <Button variant="secondary" size="sm" disabled={!ready || !total || active}
                onClick={() => rows.forEach(({ provider, reading }) => {
                  const count = sourceCount(reading)
                  if (count) enqueueImport(ownerId, { devices: [{ deviceId: null, deviceName: t('settings.dataImport.thisComputer'), count }], provider }, t)
                })}>{t('settings.dataImport.importAll')}</Button>
            </ImportRow>
            {(first.historyOnly ? ['tasks'] as const : ENVIRONMENT_IMPORT_CATEGORIES).map(category => {
              const source = rows.find(({ provider }) => (provider.category ?? 'tasks') === category)
              const job = source ? findJob(jobs, source.provider.id, null) : undefined
              const count = sourceCount(source?.reading)
              return (
                <ImportRow key={category} label={<>{t(first.historyOnly ? 'settings.dataImport.sessions' : categoryLabelKey(category))} {count === undefined ? '' : `(${count})`}</>} job={job}>
                  {source ? source.reading?.state === 'error' ? (
                    <Button variant="secondary" size="sm" title={t('settings.dataImport.readFailed')} onClick={() => { void importSourceCounts.refresh(source.provider.id, null) }}>
                      {t('settings.dataImport.refresh')}
                    </Button>
                  ) : <SourceAction provider={source.provider} reading={source.reading} ownerId={ownerId} deviceId={null}
                    deviceName={t('settings.dataImport.thisComputer')} job={job} />
                    : <span className="gg-import-meta">{t('settings.dataImport.categoryUnavailable')}</span>}
                </ImportRow>
              )
            })}
          </ImportCard>
        )
      })}
    </div>
  )
}

function RemoteImportDevice({ machine, providers, ownerId, jobs }: RowsProps & { machine: MachineChoice }) {
  const { t } = useTranslation('main')
  const online = machine.isOnline && !machine.cloudComputer
  const sources = useSources(providers, machine.id, online)
  const visible = sources.filter(({ reading }) => reading?.state !== 'value' || reading.value !== null)
  const targets = visible.flatMap(({ provider, reading }) => {
    const count = sourceCount(reading)
    return count ? [{ provider, device: { deviceId: machine.id, deviceName: machine.label, count } }] : []
  })
  const active = jobs.filter((job) => isActiveImport(job) && job.devices.some((device) => device.deviceId === machine.id))
  const total = targets.reduce((sum, { device }) => sum + device.count, 0)
  const activeProgress = active.reduce((progress, job) => ({
    done: progress.done + job.done,
    total: progress.total + (job.total || job.devices.find((device) => device.deviceId === machine.id)?.count || 0),
  }), { done: 0, total: 0 })

  const scanning = visible.some(({ reading }) => !reading || reading.state === 'unknown' || (reading.state === 'value' && reading.value?.pending))
  return (
    <div className="gg-import-remote-content" data-offline={!online || undefined}>
      {!online ? <p className="gg-import-unavailable">{t('settings.dataImport.deviceUnavailable')}</p> : (
        <>
          <ImportRow summary label={t('settings.dataImport.allCount', { count: total })}>
            {active.length > 0 ? <span className="gg-import-progress" role="status">
              {activeProgress.total > 0 ? `${activeProgress.done}/${activeProgress.total}` : t('settings.dataImport.remoteRunning')}
              <LoadingIndicator size="inline" />
            </span> : (
              <Button variant="secondary" size="sm" disabled={scanning || total === 0}
                onClick={() => targets.forEach(({ provider, device }) => enqueueImport(ownerId, { provider, devices: [device] }, t))}>
                {t('settings.dataImport.importAll')}
              </Button>
            )}
          </ImportRow>
          {visible.map(({ provider, reading }) => {
            const count = sourceCount(reading)
            const job = findJob(jobs, provider.id, machine.id)
            return (
              <ImportRow key={provider.id} job={job} label={<><span className="gg-import-remote-icon"><AgentIcon id={provider.iconId} size={18} /></span>{provider.label} {count === undefined ? sourceDescription(t, reading) : `(${count})`}</>}>
                <SourceAction provider={provider} reading={reading} ownerId={ownerId} deviceId={machine.id} deviceName={machine.label} job={job} />
              </ImportRow>
            )
          })}
        </>
      )}
    </div>
  )
}

export function RemoteImportSources({ machines, ...props }: RowsProps & { machines: readonly MachineChoice[] }) {
  const { t } = useTranslation('main')
  const [selected, setSelected] = useState<string | null>(null)
  const machine = machines.find(({ id }) => id === selected) ?? machines[0]
  if (!machine) return <p className="gg-import-empty">{t('settings.dataImport.noDevices')}</p>
  return (
    <div className="gg-import-remote-panel">
      <MachineList compact label={t('settings.dataImport.machineList')} machines={machines} selected={machine.id}
        onlineLabel={t('settings.dataImport.onlineStatus')} offlineLabel={t('settings.dataImport.offlineStatus')} onSelect={setSelected} />
      <RemoteImportDevice key={machine.id} {...props} machine={machine} />
    </div>
  )
}
