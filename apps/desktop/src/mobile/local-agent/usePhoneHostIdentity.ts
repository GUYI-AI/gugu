import { useSyncExternalStore } from 'react'
import { Capacitor } from '@capacitor/core'
import { platform } from '@/platform'
import type { IOSOwnerPublicationState } from '../ios-runtime/iosOwnerPublication'
import { getIOSOwnerPublicationSnapshot, subscribeIOSOwnerPublication } from '../ios-runtime/startIOSOwnerPublication'
import { thisPhoneDeviceId } from '../phone-device/phoneDeviceSettings'

const empty: IOSOwnerPublicationState = { status: 'waiting', binding: null, error: null }
const noSubscribe = () => () => undefined
const noSnapshot = () => empty

/** A withdrawn publication must remove the local label in the same render. */
export function verifiedPhoneHostBinding(ownerId: string | null, publication: IOSOwnerPublicationState) {
  if (!ownerId || publication.status !== 'ready' || publication.binding.ownerId !== ownerId) return null
  const binding = publication.binding
  return binding.deviceId === `phone-${binding.installationId}-${ownerId}` ? binding : null
}

export function usePhoneHostIdentity(ownerId: string | null) {
  const ios = platform.kind === 'capacitor' && Capacitor.getPlatform() === 'ios'
  const publication = useSyncExternalStore(ios ? subscribeIOSOwnerPublication : noSubscribe,
    ios ? getIOSOwnerPublicationSnapshot : noSnapshot, noSnapshot)
  const binding = ios ? verifiedPhoneHostBinding(ownerId, publication) : null
  const deviceId = ios ? binding?.deviceId ?? null
    : platform.kind === 'capacitor' && platform.capabilities.phoneDevice && ownerId ? thisPhoneDeviceId(ownerId) : null
  return { ios, binding, deviceId, publication }
}
