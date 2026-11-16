import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { useReplica } from '../../../lib/replica'
import { messageForUser } from '../../../lib/userFacingError'
import { useDevicesStore } from '../../../store/devicesContext'
import { Button } from '../../ui/Button'
import { useDeviceRemoval } from '../useDeviceRemoval'
import { InlineAction } from './InlineAction'
import { machineLimitCheck } from './machineLimitReplicas'

function machineLimitText(t: (key: string, values?: Record<string, unknown>) => string, refusal: MachineLimitRefusal | null): string {
  if (!refusal) return t('devices.addServer.machineLimit.unknown')
  return t(`devices.addServer.machineLimit.${refusal.limit}`, { used: refusal.used, max: refusal.max })
}

export function MachineLimitNotice({
  refusal,
  onUpgrade,
  onRemoveMachine,
  onAvailable,
}: {
  refusal: MachineLimitRefusal | null
  onUpgrade?: () => void
  onRemoveMachine?: () => void
  onAvailable?: () => void
}) {
  const { t } = useTranslation('settings')
  const { devices, phones } = useDevicesStore()
  const machines = useMemo(() => deviceMachines([...devices, ...(phones ?? [])]), [devices, phones])
  // The attempted machine, when the backend names it: then whether the refusal still holds is asked of the enforcement
  // RPC, and asked again after each removal made here (a partial removal of a multi-version machine included).
  const attempt: [string, 'ssh' | 'tunnel'] | null = refusal?.machine_id && refusal.via ? [refusal.machine_id, refusal.via] : null
  const check = useReplica(machineLimitCheck, attempt)
  const recheck = () => { if (attempt) void machineLimitCheck.refresh(...attempt) }
  const { canRemoveDevices, openRemoveDevices, dialogs } = useDeviceRemoval(machines, { onRemoved: recheck })
  // Until the check answers (or without one) the refusal in hand is what is said.
  const current = check.state === 'value' ? check.value : refusal
  const error = check.state === 'error' ? messageForUser(check.error) : check.state === 'value' && check.error ? messageForUser(check.error) : ''
  const available = check.state === 'value' && check.value === null && !error

  return (
    <div data-testid="add-server-machine-limit">
      <div>
        {available ? t('devices.addServer.machineLimit.available') : machineLimitText(t, current)}
        {!available && (onUpgrade || onRemoveMachine) && (
          <>
            {' '}
            {onUpgrade && (
              <InlineAction onClick={onUpgrade} testId="add-server-machine-limit-upgrade">
                {t('devices.addServer.machineLimit.upgrade')}
              </InlineAction>
            )}
            {onUpgrade && onRemoveMachine && t('devices.addServer.machineLimit.or')}
            {onRemoveMachine && (
              <InlineAction onClick={onRemoveMachine} testId="add-server-machine-limit-remove">
                {t('devices.addServer.machineLimit.remove')}
              </InlineAction>
            )}
            {t('devices.addServer.machineLimit.end')}
          </>
        )}
        {available && onAvailable && <>{' '}<InlineAction onClick={onAvailable}>{t('devices.addServer.machineLimit.continue')}</InlineAction></>}
      </div>
      {error ? (
        <div role="alert" className="mt-2 text-[var(--danger-fg)]">
          {error}{' '}<InlineAction onClick={recheck}>{t('devices.retry')}</InlineAction>
        </div>
      ) : current?.machines && current.machines.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" aria-label={t('devices.addServer.machineLimit.occupants')}>
          {current.machines.map((machine) => (
            <li key={machine.machine_id} className="flex items-center justify-between gap-3" data-machine-id={machine.machine_id}>
              <span className="min-w-0 truncate">{machine.label}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canRemoveDevices(machine.device_ids)}
                onClick={() => openRemoveDevices(machine.device_ids)}
                aria-label={t('devices.remove.label', { name: machine.label })}
              >
                {t('devices.remove.confirm')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dialogs}
    </div>
  )
}
