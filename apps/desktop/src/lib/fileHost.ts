import { useEffect, useRef, useState } from 'react'
import { isDeviceOnline } from '@gugu/core/shared/enums/deviceModels'
import { useDevicesStore } from '../store/devicesContext'
import { i18n } from '../i18n'
import { UI_EVENTS } from './uiEvents'
import { fileMetadata } from './fileAccess'
import { rendererLogger } from './log'

const log = rendererLogger('file-host')

export type FileHost = { device: string; account: string }

/**
 * A project chat's file kept on the machine that sent this version (uploaded only when someone opens it): which machine
 * and whose account.
 * Null for every other file, and while unknown: it only says where the file is, so a failed read draws nothing.
 */
export function useFileHost(itemId: string | null): FileHost | null {
  const [host, setHost] = useState<FileHost | null>(null)
  useEffect(() => {
    setHost(null)
    if (!itemId) return undefined
    let live = true
    Promise.resolve().then(() => fileMetadata(itemId)).then((file) => {
      if (live && file.status === 'ready' && file.revision.source === 'local' && file.revision.host_device_id && file.revision.host_account_id) {
        setHost({ device: file.revision.host_device_id, account: file.revision.host_account_id })
      }
    }).catch((error: unknown) => log.warn({ itemId, error: String(error) }, 'where the file is kept is unknown'))
    return () => { live = false }
  }, [itemId])
  return host
}

/**
 * After a read failed: whether it is because the machine that keeps this version is offline right now, read afresh from
 * the resolver (never a state remembered from earlier). That machine — its name (`''` when it has none) — or null.
 */
export async function offlineHolder(itemId: string, version?: number): Promise<{ machine: string; deviceId: string } | null> {
  const file = await fileMetadata(itemId, version).catch(() => null)
  if (file?.status !== 'ready' || file.revision.source !== 'local' || file.revision.host_online !== false || !file.revision.host_device_id) return null
  return { machine: file.revision.host_label?.trim() ?? '', deviceId: file.revision.host_device_id }
}

/** What a reader is told about that machine, wherever the file was opened from. */
export const holderOfflineText = ({ machine }: { machine: string }) =>
  i18n.t('attachmentView.holderOffline', { ns: 'messaging', machine: machine || i18n.t('attachmentView.holderMachine', { ns: 'messaging' }) })

/** When the device list sees that machine go from off to on, what waits on it reads again by itself. */
export function useHolderBack(deviceId: string | null, onBack: () => void) {
  const { devices } = useDevicesStore()
  const seenOff = useRef(false)
  useEffect(() => {
    if (!deviceId) { seenOff.current = false; return }
    const online = devices.some((device) => device.device_id === deviceId && isDeviceOnline(device.status))
    if (!online) { seenOff.current = true; return }
    if (seenOff.current) { seenOff.current = false; onBack() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, deviceId])
}

export const openFileStorageSettings = () => window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'files' } }))
