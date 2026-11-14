import { useRef, useState } from 'react'
import type { IOSOwnerBinding } from '../ios-runtime/iosOwnerClient'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '@/lib/log'
import { iosHostRuntime, useIOSHostRuntimeSnapshot } from '../ios-host/iosHostRuntime'
import { sameIOSBinding } from '../ios-host/iosAgentClient'
import { usePhoneHostIdentity } from './usePhoneHostIdentity'
import { PhoneAgentHostView } from './PhoneAgentHostView'

/** UI projection only: owner publication and the App-root runtime retain custody. */
export function IOSPhoneAgentHostControl({ ownerId, setup, summary }: { ownerId: string; setup?: boolean; summary?: boolean }) {
  const { t } = useTranslation('settings')
  const { binding } = usePhoneHostIdentity(ownerId)
  const snapshot = useIOSHostRuntimeSnapshot()
  const sequence = useRef(0)
  const [operation, setOperation] = useState<{ binding: IOSOwnerBinding; sequence: number; changing: 'stop' | 'restart' | null; failed: boolean } | null>(null)
  const activeOperation = sameIOSBinding(binding, operation?.binding ?? null) ? operation : null
  const changing = activeOperation?.changing ?? null
  const error = activeOperation?.failed ? t('devices.phoneActions.host.operationFailed') : null
  const current = binding && sameIOSBinding(binding, snapshot.binding)
  const host = current ? snapshot.host : null
  const enabled = !!current && snapshot.phase !== 'stopped'
  const ready = !!current && snapshot.phase === 'configured' && host?.status === 'ready' && host.ready
  const failed = !!current && (snapshot.phase === 'failed' || host?.status === 'failed' || host?.status === 'interrupted')
  const status = changing === 'stop' ? 'stopping' : changing === 'restart' ? 'starting' : !current ? 'waiting'
    : error ? 'operationFailed' : snapshot.phase === 'stopped' ? 'stopped' : ready ? 'ready'
      : failed ? 'failed' : 'starting'
  const changeHost = async (kind: 'stop' | 'restart') => {
    if (changing || !binding || !sameIOSBinding(binding, iosHostRuntime.getSnapshot().binding)) return
    const request = ++sequence.current
    setOperation({ binding, sequence: request, changing: kind, failed: false })
    try {
      if (kind === 'stop') await iosHostRuntime.stopHost()
      else await iosHostRuntime.retry()
    } catch (cause) {
      rendererLogger('actions/IOSPhoneAgentHostControl').error({ error: cause }, 'action failed')
      setOperation(previous => previous?.sequence === request ? { ...previous, failed: true } : previous)
    } finally { setOperation(previous => previous?.sequence === request ? { ...previous, changing: null } : previous) }
  }
  return <PhoneAgentHostView setup={setup} summary={summary} enabled={enabled} ready={!!ready} failed={!!failed}
    changing={changing} error={current ? error : null} hostError={failed ? t('devices.phoneActions.host.retryHint') : null}
    statusText={t(`devices.phoneActions.host.${status}`)} changeHost={changeHost} unavailable={!current}
    enable={() => { void changeHost('restart') }} />
}
