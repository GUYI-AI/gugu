import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Clock, X } from '@/lib/icons'
import { useReplicas } from '@/lib/replica'
import { importSourceCounts } from './import-replicas'
import { notify } from '@/lib/notices'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Button } from '@/components/ui/Button'
import { MachineList } from '@/components/ui/MachineList'
import { Collapse } from '@/components/ui/Collapse'
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
      <AgentIcon id={provider.iconId} size={24} />
    </span>
  )
}

function ImportProgress({ job, label }: { job: ImportJob; label: string }) {
  const { t } = useTranslation('main')
  const { state } = job
  const pendingCancel = state === 'cancelling'
  const canCancel = state === 'queued' || state === 'running'
  const stateLabel = state === 'running' && job.total > 0 ? `${job.done}/${job.total}`
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
  return reading?.state === 'value' && reading.value && !reading.value.pending ? reading.value.count : undefined
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
  const needsFile = !!pick && reading?.state === 'value' && reading.value?.needsSource
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

function ImportRow({ label, job, children }: { label: ReactNode; job?: ImportJob; children: ReactNode }) {
  return (
    <div className="gg-import-row" data-cancellable={job?.state === 'running' || job?.state === 'queued' || undefined}>
      <div className="gg-import-row-label">{label}</div>
      {children}
    </div>
  )
}

export function LocalImportSources({ providers, ownerId, jobs }: RowsProps) {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState<string | null>(null)
  const sources = useSources(providers, null, true)
  return (
    <div className="gg-import-stack">
      {sources.map(({ provider, reading }) => {
        if (reading?.state === 'value' && reading.value === null) return null
        const job = findJob(jobs, provider.id, null)
        const count = sourceCount(reading)
        return (
          <ImportCard key={provider.id} name={provider.label} description={sourceDescription(t, reading)}
            icon={<ImportSourceIcon provider={provider} />}
            open={open === provider.id} onToggle={() => setOpen(open === provider.id ? null : provider.id)}>
            <ImportRow label={count === undefined ? t('settings.dataImport.sessions') : t('settings.dataImport.sessionCount', { count })} job={job}>
              <SourceAction provider={provider} reading={reading} ownerId={ownerId} deviceId={null}
                deviceName={t('settings.dataImport.thisComputer')} job={job} />
            </ImportRow>
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
  const scanning = visible.some(({ reading }) => !reading || reading.state === 'unknown' || (reading.state === 'value' && reading.value?.pending))
  return (
    <div className="gg-import-remote-content">
      {!online ? <p className="gg-import-unavailable">{t('settings.dataImport.deviceUnavailable')}</p> : (
        <>
          <ImportRow label={t('settings.dataImport.allCount', { count: total })}>
            {active.length > 0 ? <span className="gg-import-progress" role="status">{t('settings.dataImport.remoteRunning')}<LoadingIndicator size="inline" /></span> : (
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
              <ImportRow key={provider.id} job={job} label={<><AgentIcon id={provider.iconId} size={22} />{provider.label} {count === undefined ? sourceDescription(t, reading) : `(${count})`}</>}>
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
      <MachineList label={t('settings.dataImport.machineList')} machines={machines} selected={machine.id}
        onlineLabel={t('settings.dataImport.onlineStatus')} offlineLabel={t('settings.dataImport.offlineStatus')} onSelect={setSelected} />
      <RemoteImportDevice key={machine.id} {...props} machine={machine} />
    </div>
  )
}
