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

/** The machine that keeps a version, while it is off: its name (`''` when it has none), and the version that is waiting on it. */
export type OfflineHolder = { machine: string; deviceId: string; itemId: string; version?: number }

/**
 * After a read failed: whether it is because the machine that keeps this version is offline right now, read afresh from
 * the resolver (never a state remembered from earlier). That machine, or null.
 */
export async function offlineHolder(itemId: string, version?: number): Promise<OfflineHolder | null> {
  const file = await fileMetadata(itemId, version).catch(() => null)
  if (file?.status !== 'ready' || file.revision.source !== 'local' || file.revision.host_online !== false || !file.revision.host_device_id) return null
  return { machine: file.revision.host_label?.trim() ?? '', deviceId: file.revision.host_device_id, itemId, ...(version === undefined ? {} : { version }) }
}

/** What a reader is told about that machine, wherever the file was opened from. */
export const holderOfflineText = ({ machine }: { machine: string }) =>
  i18n.t('attachmentView.holderOffline', { ns: 'messaging', machine: machine || i18n.t('attachmentView.holderMachine', { ns: 'messaging' }) })

/** A teammate's machine is in no device list of this account: the resolver, which answers any reader, is asked again this often. */
export const HOLDER_ASK_MS = 15_000
type Waiter = { itemId: string; version?: number; back: () => void }
/** One question per machine, however many files wait on it. */
const asking = new Map<string, Set<Waiter>>()
function askUntilBack(deviceId: string, waiter: Waiter): () => void {
  let waiters = asking.get(deviceId)
  if (!waiters) {
    const all = waiters = new Set()
    asking.set(deviceId, all)
    const timer = setInterval(() => {
      const [first] = all
      if (!first) return clearInterval(timer)
      if (document.visibilityState === 'hidden') return
      fileMetadata(first.itemId, first.version).then((file) => {
        if (file.status === 'ready' && file.revision.source === 'local' && file.revision.host_online === true) [...all].forEach((w) => w.back())
      }, (error: unknown) => log.warn({ deviceId, error: String(error) }, 'whether the machine is back is unknown'))
    }, HOLDER_ASK_MS)
  }
  waiters.add(waiter)
  return () => { waiters.delete(waiter); if (!waiters.size) asking.delete(deviceId) }
}

/**
 * When the machine a read waits on is back, what waits reads again by itself. One of this account's machines: its device
 * list sees it go from off to on. A teammate's: the resolver is asked again, for the version that waits on it.
 */
export function useHolderBack(holder: { deviceId: string; itemId?: string; version?: number } | null, onBack: () => void) {
  const { devices } = useDevicesStore()
  const back = useRef(onBack)
  useEffect(() => { back.current = onBack })
  const seenOff = useRef(false)
  const deviceId = holder?.deviceId ?? null, itemId = holder?.itemId, version = holder?.version
  const mine = devices.some((device) => device.device_id === deviceId)
  useEffect(() => {
    if (!deviceId || !mine) { seenOff.current = false; return }
    const online = devices.some((device) => device.device_id === deviceId && isDeviceOnline(device.status))
    if (!online) { seenOff.current = true; return }
    if (seenOff.current) { seenOff.current = false; back.current() }
  }, [devices, deviceId, mine])
  useEffect(() => deviceId && itemId && !mine ? askUntilBack(deviceId, { itemId, version, back: () => back.current() }) : undefined, [deviceId, itemId, version, mine])
}

export const openFileStorageSettings = () => window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'files' } }))
