import { useEffect, useSyncExternalStore } from 'react'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { PasswordRequestView, PasswordSnapshot } from '@gugu/core/shared/passwordBetaProtocol'
import { followLink } from './guguLinks'

/** One snapshot of the password vault for every always-mounted surface (notifications, the device prompt), read once
 * per change instead of once per surface. */
let snapshot: PasswordSnapshot | undefined
const snapshotListeners = new Set<() => void>()
let close: (() => void) | undefined
const publish = (next: PasswordSnapshot | undefined) => { snapshot = next; for (const listener of snapshotListeners) listener() }
async function read() {
  try { const reply = await window.passwordVaultBeta?.invoke({ type: 'snapshot' }); publish(reply?.ok ? reply.snapshot : undefined) }
  catch { publish(undefined) }
}
function subscribe(listener: () => void) {
  snapshotListeners.add(listener)
  if (snapshotListeners.size === 1) { void read(); close = window.passwordVaultBeta?.subscribe(() => { void read() }) }
  return () => { snapshotListeners.delete(listener); if (!snapshotListeners.size) { close?.(); close = undefined } }
}
export function usePasswordSnapshot(): PasswordSnapshot | undefined {
  return useSyncExternalStore(PASSWORD_BETA_ENABLED ? subscribe : noSubscribe, () => snapshot)
}
const noSubscribe = () => () => {}
/** A command's reply carries the next snapshot; surfaces that read the shared one see it at once. */
export function publishPasswordSnapshot(next: PasswordSnapshot): void { publish(next) }

export function usePasswordNotifications(): PasswordRequestView[] {
  const value = usePasswordSnapshot()
  return value ? [...value.approvals, ...value.saves] : []
}

/** The device prompt can be put aside; the notification list brings it back. */
const promptListeners = new Set<(deviceId: string | null) => void>()
export function openPasswordDevicePrompt(deviceId: string | null): void { for (const listener of promptListeners) listener(deviceId) }
export function useOpenPasswordDevicePrompt(listener: (deviceId: string | null) => void): void {
  useEffect(() => { promptListeners.add(listener); return () => { promptListeners.delete(listener) } }, [listener])
}

const listeners = new Set<() => void>()
let reveal: { sessionId: string; requestId: string } | undefined
export function openPasswordRequest(request: PasswordRequestView): void {
  reveal = { sessionId: request.sessionId, requestId: request.requestId }
  followLink({ kind: 'session', sessionId: request.sessionId, deviceId: request.deviceId })
  for (const listener of listeners) listener()
}
export function watchPasswordReveal(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
export function pendingPasswordReveal() { return reveal }
export function passwordRevealCompleted(requestId: string): void { if (reveal?.requestId === requestId) reveal = undefined }
