import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useConversationVisibility } from '../chat/useConversationVisibility'
import { showSshStatusInPlace } from '@/lib/sshLinkNotice'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { ChevronRight } from '@/lib/icons'
import { reconnectDevice } from '@/lib/sessionpageNewSessionBridge'
import { disconnectSshDevice, requestSshServerUpgrade, resumeSshDevice, signInSshMachine, startSshService, trustVerifiedIdentity } from '@/lib/sshLinkChannel'
import type { SshLinkOpenResult } from '@/lib/sshLink'
import { CommandBlock } from './addServer/CommandBlock'
import { formatRelativeTime } from '@/lib/relativeTime'
import { AddServerPanel, type AddServerMethod } from './AddServerPanel'
import { SshIdentityDetails } from './addServer/SshHostKeyChanged'
import { useDevicesStore } from '@/store/devicesContext'
import { canRestartServerUpdate } from '@/lib/deviceRowModel'
import { readServerVersionSwitchBusyAgents, restartServerVersionNow, retryServerVersionMatch } from '@/lib/serverVersionRetry'
import { serverSupportsConfirmedRestart } from '@gugu/core/cloud/serverMachineHealth'
import { useReplica } from '@/lib/replica'
import { sshMachineAddresses } from '@/lib/sshMachineAddresses'
import type { RecoveryState } from './DeviceRecoveryStatus'

type Failure = Extract<SshLinkOpenResult, { ok: false }>
export type DeviceRecoveryProps = {
  deviceId: string
  name: string
  state: RecoveryState
  address?: string | null
  version?: string | null
  progress?: number | null
  lastSync?: number
  listFacts?: ReactNode
  inTask?: boolean
  onDone: () => void
}

export function DeviceRecoveryPanel({ deviceId, state, name, address, version, progress, lastSync, listFacts, inTask, onDone }: DeviceRecoveryProps) {
  const { t, i18n } = useTranslation('settings')
  const [setup, setSetup] = useState<AddServerMethod | null>(null)
  const promptTarget = useRef<HTMLDivElement>(null)
  const { ref: panelRef, shown } = useConversationVisibility<HTMLElement>(!setup && typeof IntersectionObserver !== 'undefined')
  useEffect(() => {
    if (shown && promptTarget.current) return showSshStatusInPlace(deviceId, null, promptTarget.current)
  }, [deviceId, shown])
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [error, setError] = useState('')
  const [verified, setVerified] = useState(false)
  const [restart, setRestart] = useState<{ busy?: number } | null>(null)
  const { devices } = useDevicesStore()
  const machine = devices.find(row => row.device_id === deviceId)
  const addresses = useReplica(sshMachineAddresses, [])
  const entry = addresses.state === 'value' ? addresses.value.find(([id]) => id === deviceId) : undefined
  const endpoint = address ?? entry?.[1]
  const update = machine?.capabilities?.server_update
  const bootFailed = state === 'updateFailed' && update?.state === 'failed' && update.reason === 'boot-failed'
  const reviewingUpdate = state === 'waitingIdle' || state === 'confirmationRequired' || bootFailed
  const reportedRestart = !!machine && !!update && canRestartServerUpdate(update, machine.capabilities) &&
    (update.state === 'ready' || bootFailed)
  const hostKey = failure?.reason === 'hostKeyChanged' ? failure.hostKey : null
  const prefix = `devices.recovery.${state}`
  const key = (suffix: string) => t(`devices.recovery.${suffix}`)
  const requestReconnect = () => { if (!reconnectDevice(deviceId)) setError('failed') }
  const showResult = (result: SshLinkOpenResult) => {
    if (!result.ok && !result.cancelled) {
      setFailure(result)
      if (!result.hostKey) setError(result.reason === 'notRunning' ? 'startFailed' : 'failed')
    }
  }

  async function act() {
    if (pending) return
    setPending(true)
    setError('')
    try {
      if (reviewingUpdate) {
        if (!restart) {
          setRestart({ busy: await readServerVersionSwitchBusyAgents(deviceId) })
          return
        }
        const requested = reportedRestart && machine && update
          ? (await restartServerVersionNow(deviceId, update.version, serverSupportsConfirmedRestart(machine.capabilities))).requested
          : await requestSshServerUpgrade(deviceId, { force: true, now: true })
        if (!requested) setError('failed')
        setRestart(null)
        return
      }
      switch (state) {
        case 'connected': onDone(); break
        case 'notRunning': showResult(await startSshService(deviceId)); break
        case 'signInRequired':
        case 'hostKeyChanged':
          if (hostKey?.fingerprint && verified && !await trustVerifiedIdentity(deviceId, hostKey.fingerprint)) {
            setError('manualTrust')
            setVerified(false)
            break
          }
          setVerified(false)
          showResult(await signInSshMachine(deviceId))
          break
        case 'disconnected': await resumeSshDevice(deviceId); requestReconnect(); break
        case 'outdated':
        case 'updateFailed': {
          const fromHeartbeat = state === 'updateFailed' && machine?.status === 'online' && update?.state === 'failed'
          const accepted = fromHeartbeat ? await retryServerVersionMatch(deviceId) : await requestSshServerUpgrade(deviceId, { force: true })
          if (!accepted) setError('failed')
          break
        }
        case 'notInstalled':
        case 'notSignedIn':
        case 'unmapped': setSetup('ssh'); break
        default: requestReconnect()
      }
    } catch {
      setError(state === 'notRunning' ? 'startFailed' : 'failed')
    } finally {
      setPending(false)
    }
  }

  function cancelVerification() { setVerified(false); setFailure(null); setError('') }
  const primary = state === 'connected' ? (inTask ? key('backToTask') : null)
    : reviewingUpdate ? restart ? t('devices.update.confirmRestart') : key('seeUpdate')
    : state === 'updating' || state === 'checking' ? null
    : hostKey?.fingerprint ? key('trust') : t(prefix + '.action')
  const manual = state === 'notRunning' ? entry?.[2] : null
  const lastSeen = machine?.last_seen_at ? formatRelativeTime(machine.last_seen_at, { mode: 'elapsed', dateAfterDays: 30 }) : null
  const updateReport = update?.state === 'ready' ? t('devices.update.ready')
    : update?.state === 'downloading' ? t('devices.update.downloading', { version: update.version })
    : update?.state === 'switching' ? t('devices.update.restarting')
    : update?.state === 'failed' ? t('devices.loginState.matchFailed') : null
  const seen = lastSync ? new Date(lastSync).toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
  if (setup) return <AddServerPanel method={setup} onMethodChange={setSetup} onClose={() => setSetup(null)}
    onAdded={() => { setSetup(null); requestReconnect() }}
    relogin={endpoint && state === 'notSignedIn' ? { deviceId, address: endpoint } : undefined} />
  const details = <>
    <dl className="gg-device-facts">
      {listFacts ?? <>
        {endpoint && <><dt>{key('address')}</dt><dd>{endpoint}</dd></>}
        {version && <><dt>{key('version')}</dt><dd>{t('devices.serverVersion', { version })}</dd></>}
        {lastSeen && <><dt>{key('heartbeat')}</dt><dd>{t('devices.lastSeen', { time: lastSeen })}</dd></>}
      </>}
      {updateReport && <><dt>{key('reportedUpdate')}</dt><dd>{updateReport}{update?.version && ' · ' + update.version}</dd></>}
      {seen && <><dt>{key('lastSync')}</dt><dd>{seen}</dd></>}
      {manual && <><dt>{key('manual')}</dt><dd><CommandBlock command={manual} inline={!inTask} /></dd></>}
      {hostKey?.location && <><dt>{inTask ? key('fingerprint') : t('devices.facts.trustRecord')}</dt><dd><SshIdentityDetails hostKey={hostKey} /></dd></>}
    </dl>
    {error === 'manualTrust' && <Button size="sm" variant="secondary" onClick={() => { cancelVerification(); void signInSshMachine(deviceId).then(showResult) }}>{key('manualReconnect')}</Button>}
  </>
  return <section ref={panelRef} className="gg-device-recovery" aria-label={key('title')}>
    {inTask && <h3>{t(prefix + '.title')}</h3>}
    {(inTask || state !== 'connected') && <p>{restart ? typeof restart.busy === 'number'
      ? t('devices.update.updateNowConfirmCount', { name, count: restart.busy }) : key('restartHint') : t(prefix + '.body')}</p>}
    {state === 'updating' && typeof progress === 'number' && <p role="status">{t('devices.loginState.updatingPercent', { percent: progress })}</p>}
    {hostKey && <div className="gg-recovery-fingerprint">
      <span>{key('fingerprint')}</span><code>{hostKey.fingerprint ?? t('devices.versionUnknown')}</code>
      {hostKey.fingerprint && <label><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />{key('verified')}</label>}
    </div>}
    <div ref={promptTarget} />
    {error && <p role="alert">{!inTask && (error === 'manualTrust' || error === 'failed') ? t('devices.facts.' + error) : key(error)}</p>}
    {primary && <div className="gg-recovery-actions">
      <Button size="sm" variant={state === 'connected' ? 'secondary' : 'primary'} disabled={pending || (!!hostKey && (!hostKey.fingerprint || !verified))}
        onClick={() => void act()} data-testid="device-recovery-primary">{pending ? key('busy') : primary}</Button>
      {state === 'connected' && <Button size="sm" variant="ghost" onClick={() => void disconnectSshDevice(deviceId).catch(() => setError('failed'))}>{key('pause')}</Button>}
      {(hostKey || restart) && <Button size="sm" variant="ghost" onClick={() => { cancelVerification(); setRestart(null) }}>{t('devices.cancel')}</Button>}
    </div>}
    {inTask ? <details className="gg-recovery-details">
      <summary><ChevronRight size={13} />{key('details')}</summary>
      {details}
    </details> : details}
  </section>
}
