import { useEffect } from 'react'
import type { PasswordRequestView, PasswordSaveDraft, PasswordSnapshot, PasswordUiCommand, PasswordUiReply } from '@gugu/core/shared/passwordBetaProtocol'
import { passwordErrorText } from '@/components/password/passwordModel'
import { followLink } from './guguLinks'
import { replica, useReplica, type Retry } from './replica'

/** One vault command answered by this device's vault; a refusal is an error carrying the line the person reads. */
async function ask(command: PasswordUiCommand): Promise<Extract<PasswordUiReply, { ok: true }>> {
  const vault = window.passwordVaultBeta
  if (!vault) throw new Error(passwordErrorText(''))
  const reply = await vault.invoke(command)
  if (!reply.ok) throw new Error(passwordErrorText(reply.code))
  return reply
}

/** The vault's state as this device's vault answers it, fed by its push (`watch`). Holds no secret values; ❌ kept across restarts. */
export const passwordVault = replica({
  name: 'passwordVault',
  scope: 'account',
  fresh: Infinity,
  // The vault is on this device: a read never waits for the network.
  networkMode: 'always',
  read: async (): Promise<PasswordSnapshot> => (await ask({ type: 'snapshot' })).snapshot,
  watch: { start: () => window.passwordVaultBeta?.subscribe(() => { void passwordVault.refresh() }) ?? (() => undefined) },
})

/** What an Agent proposed to save for one request (secrets included): held only while its form is shown (`keep: 0`), ❌ kept. */
export const passwordSaveDraft = replica({
  name: 'passwordSaveDraft',
  scope: 'account',
  keep: 0,
  fresh: Infinity,
  networkMode: 'always',
  read: async (_owner: string, requestId: string): Promise<PasswordSaveDraft | null> => (await ask({ type: 'save-draft', requestId })).draft ?? null,
})

/**
 * The vault as the surfaces that show part of it read it (notifications, the device prompt, the recovery row): `snapshot`
 * undefined until it is read; `failure` a refresh that failed over the snapshot still shown, which they say beside it
 * (❌ a kept snapshot drawn as current). With nothing read they draw nothing; Settings → 密码 says a vault that cannot be read.
 */
export function usePasswordVault(): { snapshot: PasswordSnapshot | undefined; failure: Error | null; retry?: Retry } {
  const reading = useReplica(passwordVault, [])
  return reading.state === 'value' ? { snapshot: reading.value, failure: reading.error, retry: reading.retry } : { snapshot: undefined, failure: null }
}

export const passwordNotifications = (snapshot: PasswordSnapshot | undefined): PasswordRequestView[] =>
  snapshot ? [...snapshot.approvals, ...snapshot.saves] : []

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
