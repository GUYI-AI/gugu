import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { ChevronRight, Copy } from '@/lib/icons'
import { reconnectDevice } from '@/lib/sessionpageNewSessionBridge'
import { requestSshServerUpgrade, resumeSshDevice, signInSshMachine, startSshService, trustVerifiedIdentity } from '@/lib/sshLinkChannel'
import type { SshLinkFailure, SshLinkOpenResult } from '@/lib/sshLink'
import { platform } from '@/platform'
import { AddServerPanel, type AddServerMethod } from './AddServerPanel'
import { SshIdentityDetails } from './addServer/SshHostKeyChanged'
import { useDevicesStore } from '@/store/devicesContext'
import { canRestartServerUpdate } from '@/lib/deviceRowModel'
import { readServerVersionSwitchBusyAgents, restartServerVersionNow } from '@/lib/serverVersionRetry'
import { serverSupportsConfirmedRestart } from '@gugu/core/cloud/serverMachineHealth'
import { useReplica } from '@/lib/replica'
import { sshMachineAddresses } from '@/lib/sshMachineAddresses'
import './device-recovery.css'

type RecoveryState = SshLinkFailure | 'connected' | 'checking' | 'offline'
type Failure = Extract<SshLinkOpenResult, { ok: false }>
export type DeviceRecoveryProps = {
  deviceId: string
  name: string
  state: RecoveryState
  address?: string | null
  version?: string | null
  progress?: number | null
  lastSync?: number
  onDone: () => void
}

export function DeviceRecoveryStatus({ state }: { state: RecoveryState }) {
  const { t } = useTranslation('settings')
  return <span role="status" className="gg-recovery-status" data-state={state}>
    <i aria-hidden="true" />{t(`devices.recovery.${state}.status`)}
  </span>
}

export function DeviceRecoveryPanel({ deviceId, state, name, address, version, progress, lastSync, onDone }: DeviceRecoveryProps) {
  const { t, i18n } = useTranslation('settings')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [error, setError] = useState('')
  const [verified, setVerified] = useState(false)
  const [setup, setSetup] = useState<AddServerMethod | null>(null)
  const [restart, setRestart] = useState<{ busy?: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const { devices } = useDevicesStore()
  const machine = devices.find(row => row.device_id === deviceId)
  const addresses = useReplica(sshMachineAddresses, address === undefined ? [] : null)
  const endpoint = address ?? (addresses.state === 'value' ? addresses.value.find(([id]) => id === deviceId)?.[1] : null)
  const update = machine?.capabilities?.server_update
  const canRestart = !!machine && !!update && canRestartServerUpdate(update, machine.capabilities)
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
        case 'updateFailed':
          if (!await requestSshServerUpgrade(deviceId, { force: true })) setError('failed')
          break
        case 'notInstalled':
        case 'notSignedIn':
        case 'unmapped': setSetup('ssh'); break
        case 'waitingIdle':
        case 'confirmationRequired':
          if (restart && machine && update) {
            const result = await restartServerVersionNow(deviceId, update.version, serverSupportsConfirmedRestart(machine.capabilities))
            if (!result.requested) setError('failed')
            setRestart(null)
          } else {
            setRestart({ busy: await readServerVersionSwitchBusyAgents(deviceId) })
          }
          break
        default: requestReconnect()
      }
    } catch {
      setError(state === 'notRunning' ? 'startFailed' : 'failed')
    } finally {
      setPending(false)
    }
  }

  function cancelVerification() { setVerified(false); setFailure(null); setError('') }
  async function copy(text: string) {
    try { await platform.writeClipboardText(text); setCopied(true) }
    catch { setError('copyFailed') }
  }
  const reviewingUpdate = state === 'waitingIdle' || state === 'confirmationRequired'
  const primary = state === 'connected' ? key('close')
    : reviewingUpdate ? canRestart ? restart ? t('devices.update.confirmRestart') : key('seeUpdate') : null
    : state === 'updating' || state === 'checking' ? null
    : hostKey?.fingerprint ? key('trust') : t(prefix + '.action')
  const manual = failure?.reason === 'notRunning' && failure.detail?.match(/^~\/\.local\/bin\/gugu-server(?:-beta)? start$/) ? failure.detail : null
  const seen = lastSync ? new Date(lastSync).toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
  if (setup) return <AddServerPanel method={setup} onMethodChange={setSetup} onClose={() => setSetup(null)}
    onAdded={() => { setSetup(null); requestReconnect() }}
    relogin={endpoint && state === 'notSignedIn' ? { deviceId, address: endpoint } : undefined} />
  return <section className="gg-device-recovery" aria-label={key('title')}>
    <h3>{t(prefix + '.title')}</h3>
    <p>{restart ? typeof restart.busy === 'number'
      ? t('devices.update.updateNowConfirmCount', { name, count: restart.busy }) : key('restartHint') : t(prefix + '.body')}</p>
    {state === 'updating' && typeof progress === 'number' && <p role="status">{t('devices.loginState.updatingPercent', { percent: progress })}</p>}
    {hostKey && <div className="gg-recovery-fingerprint">
      <span>{key('fingerprint')}</span><code>{hostKey.fingerprint ?? t('devices.versionUnknown')}</code>
      {hostKey.fingerprint && <label><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />{key('verified')}</label>}
    </div>}
    {error && <p role="alert">{error === 'copyFailed' ? t('actions.copyFailed', { ns: 'common' }) : key(error)}</p>}
    {primary && <div className="gg-recovery-actions">
      <Button size="sm" variant={state === 'connected' ? 'secondary' : 'primary'} disabled={pending || (!!hostKey && (!hostKey.fingerprint || !verified))}
        onClick={() => void act()} data-testid="device-recovery-primary">{pending ? key('busy') : primary}</Button>
      {(hostKey || restart) && <Button size="sm" variant="ghost" onClick={() => { cancelVerification(); setRestart(null) }}>{t('devices.cancel')}</Button>}
    </div>}
    <details className="gg-recovery-details">
      <summary><ChevronRight size={13} />{key('details')}</summary>
      <dl>
        {endpoint && <><dt>{key('address')}</dt><dd>{endpoint}</dd></>}
        {version && <><dt>{key('version')}</dt><dd>{version}</dd></>}
        {seen && <><dt>{key('lastSync')}</dt><dd>{seen}</dd></>}
        {manual && <><dt>{key('manual')}</dt><dd><code>{manual}</code> <Button size="sm" variant="ghost" aria-label={t('devices.addServer.copy')} onClick={() => void copy(manual)}><Copy size={13} />{copied && t('devices.addServer.copied')}</Button></dd></>}
        {hostKey?.location && <><dt>{key('fingerprint')}</dt><dd><SshIdentityDetails hostKey={hostKey} /></dd></>}
      </dl>
      {error === 'manualTrust' && <Button size="sm" variant="secondary" onClick={() => { cancelVerification(); void signInSshMachine(deviceId).then(showResult) }}>{key('manualReconnect')}</Button>}
    </details>
  </section>
}
