import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Clock, X } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Button } from '@/components/ui/Button'
import { AgentIcon } from '@renderer/lib/components/agent-icon'
import type { MachineChoice } from '@renderer/features/remote-hosts/machine-choice'
import { importProviders, type ImportProvider } from './import-providers'
import { cancelImport, enqueueImport, isActiveImport, type ImportDevice, type ImportJob } from './import-queue'

type Scan = NonNullable<Awaited<ReturnType<ImportProvider['scan']>>>
type DeviceReading = { device: ImportDevice; scan: Scan | null; failed?: boolean }

function useSourceReadings(provider: ImportProvider, devices: readonly ImportDevice[], revision: string) {
  const [readings, setReadings] = useState<DeviceReading[] | null>(null)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setReadings(null)
    async function read(previous?: DeviceReading[]) {
      const results = await Promise.all(devices.map(async (device, index): Promise<DeviceReading> => {
        const existing = previous?.[index]
        if (existing && !existing.scan?.pending) return existing
        try {
          return { device, scan: await provider.scan(device.deviceId) }
        } catch {
          return { device, scan: null, failed: true }
        }
      }))
      if (stopped) return
      setReadings(results)
      if (results.some(({ scan }) => scan?.pending)) timer = setTimeout(() => { void read(results) }, 1200)
    }
    void read()
    return () => { stopped = true; clearTimeout(timer) }
  }, [provider, devices, revision])
  return readings
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

function ImportSourceCard({ devices, provider, ownerId, job, refresh }: {
  devices: readonly ImportDevice[]
  provider: ImportProvider
  ownerId: string
  job: ImportJob | undefined
  refresh: number
}) {
  const { t } = useTranslation('main')
  const [picked, setPicked] = useState(0)
  const [picking, setPicking] = useState(false)
  const [pickFailed, setPickFailed] = useState(false)
  const readings = useSourceReadings(provider, devices, `${refresh}:${picked}:${job?.finishedAt ?? ''}`)
  const pending = !readings || readings.some(({ scan }) => scan?.pending)
  const targets = (readings ?? []).flatMap(({ device, scan }) => scan && scan.count > 0 ? [{ ...device, count: scan.count }] : [])
  const count = targets.reduce((sum, device) => sum + device.count, 0)
  const pickTarget = readings?.find(({ scan }) => scan?.needsSource)?.device
  const failed = readings?.some((reading) => reading.failed) ?? false
  const supported = readings?.some(({ scan }) => scan !== null)
  if (readings && !supported && !failed && !job) return null
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
      setPicked((n) => n + 1)
    } catch {
      setPickFailed(true)
    } finally {
      setPicking(false)
    }
  }

  return (
    <article className="gg-import-card">
      <ImportSourceIcon provider={provider} />
      <div className="gg-import-copy">
        <div className="gg-import-name">{provider.label}
          {targets.map((device) => <span className="gg-import-device" key={device.deviceId ?? 'local'}>{device.deviceName}</span>)}
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

export function ImportSourceRows({ machines, ownerId, jobs, refresh }: {
  machines: readonly MachineChoice[]
  ownerId: string
  jobs: readonly ImportJob[]
  refresh: number
}) {
  const machineKey = JSON.stringify(machines
    .filter((machine) => machine.isOnline && !machine.cloudComputer)
    .map((machine) => ({ deviceId: machine.isLocal ? null : machine.id, deviceName: machine.label, count: 0 })))
  const devices: ImportDevice[] = useMemo(() => JSON.parse(machineKey), [machineKey])
  return (
    <div className="gg-import-stack">
      {importProviders.map((provider) => (
        <ImportSourceCard key={provider.id} provider={provider} devices={devices} ownerId={ownerId} refresh={refresh}
          job={jobs.find((job) => job.provider.id === provider.id)} />
      ))}
    </div>
  )
}
