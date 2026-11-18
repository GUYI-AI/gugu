import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Clock, X } from '@/lib/icons'
import { useReplicas } from '@/lib/replica'
import { importSourceCounts } from './import-replicas'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Button } from '@/components/ui/Button'
import { AgentIcon } from '@renderer/lib/components/agent-icon'
import type { MachineChoice } from '@renderer/features/remote-hosts/machine-choice'
import { importProviders, type ImportProvider } from './import-providers'
import { cancelImport, enqueueImport, isActiveImport, type ImportDevice, type ImportJob } from './import-queue'

function useSourceReadings(provider: ImportProvider, devices: readonly ImportDevice[]) {
  const readings = useReplicas(importSourceCounts, devices.map(({ deviceId }) => [provider.id, deviceId]))
  const results = readings.map((reading, index) => ({
    device: devices[index]!,
    scan: reading.state === 'value' ? reading.value : null,
    failed: reading.state === 'error' || (reading.state === 'value' && !!reading.error),
  }))
  const pending = readings.some((reading) => reading.state === 'unknown') ||
    results.some(({ scan }) => scan?.pending)
  const needsIndex = results.some(({ scan }) => scan?.pending)
  useEffect(() => {
    if (!needsIndex) return
    const timer = setInterval(() => { void importSourceCounts.refresh(provider.id) }, 1200)
    return () => clearInterval(timer)
  }, [needsIndex, provider.id])
  return { results, pending }
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

function ImportSourceCard({ devices, provider, ownerId, job }: {
  devices: readonly ImportDevice[]
  provider: ImportProvider
  ownerId: string
  job: ImportJob | undefined
}) {
  const { t } = useTranslation('main')
  const [picking, setPicking] = useState(false)
  const [pickFailed, setPickFailed] = useState(false)
  const { results, pending } = useSourceReadings(provider, devices)
  const targets = results.flatMap(({ device, scan }) => scan && scan.count > 0 ? [{ ...device, count: scan.count }] : [])
  const count = targets.reduce((sum, device) => sum + device.count, 0)
  const pickTarget = results.find(({ scan }) => scan?.needsSource)?.device
  const failed = results.some((reading) => reading.failed)
  const supported = results.some(({ scan }) => scan !== null)
  if (!pending && !supported && !failed && !job) return null
  const status = pickFailed || (failed && !supported) ? t('settings.dataImport.readFailed')
    : pending ? t('settings.dataImport.reading') : t('settings.dataImport.available', { count })
  const showProgress = job && (isActiveImport(job) || (count === 0 && (job.state === 'cancelled' || job.state === 'finished')))
  const canPick = !!provider.pickSource && !!pickTarget
  async function pickSource() {
    if (!provider.pickSource || !pickTarget) return
    setPicking(true)
    setPickFailed(false)
    try {
      await provider.pickSource(pickTarget.deviceId)
      await importSourceCounts.refresh(provider.id)
    } catch {
      setPickFailed(true)
    } finally {
      setPicking(false)
    }
  }

  return (
    <article className="gg-import-card" data-cancellable={job?.state === 'running' || job?.state === 'queued' || undefined}>
      <ImportSourceIcon provider={provider} />
      <div className="gg-import-copy">
        <div className="gg-import-name">{provider.label}
          {targets.map((device) => <span className="gg-import-device" data-remote={device.deviceId !== null || undefined} key={device.deviceId ?? 'local'}>{device.deviceName}</span>)}
        </div>
        <div className="gg-import-meta">{status}</div>
        {failed && supported && <div className="gg-import-meta">{t('settings.dataImport.partialRead')}</div>}
      </div>
      {showProgress ? <ImportProgress job={job} label={provider.label} /> : canPick ? (
        <Button variant="secondary" size="sm" disabled={picking} onClick={() => { void pickSource() }}>
          {t('settings.dataImport.pickSource')}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" disabled={pending || count === 0}
          aria-label={t('settings.dataImport.importSource', { source: provider.label })}
          onClick={() => enqueueImport(ownerId, { devices: targets, provider }, t)}>
          {t('settings.dataImport.action')}
        </Button>
      )}
    </article>
  )
}

export function ImportSourceRows({ machines, ownerId, jobs }: {
  machines: readonly MachineChoice[]
  ownerId: string
  jobs: readonly ImportJob[]
}) {
  const devices = machines
    .filter((machine) => machine.isOnline && !machine.cloudComputer)
    .map((machine) => ({ deviceId: machine.isLocal ? null : machine.id, deviceName: machine.label, count: 0 }))
  return (
    <div className="gg-import-stack">
      {importProviders.map((provider) => (
        <ImportSourceCard key={provider.id} provider={provider} devices={devices} ownerId={ownerId}
          job={jobs.find((job) => job.provider.id === provider.id)} />
      ))}
    </div>
  )
}
