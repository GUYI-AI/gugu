import { useEffect, useState } from 'react'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { PasswordApproval } from '@gugu/core/shared/passwordBetaProtocol'
import { followLink } from './guguLinks'

const listeners = new Set<() => void>()
let reveal: { sessionId: string; requestId: string } | undefined
export function usePasswordNotifications() {
  const [pending, setPending] = useState<PasswordApproval[]>([])
  useEffect(() => {
    if (!PASSWORD_BETA_ENABLED) return
    let live = true
    const refresh = async () => {
      try { const reply = await window.passwordVaultBeta?.invoke({ type: 'snapshot' }); if (live) setPending(reply?.ok ? reply.snapshot.approvals : []) }
      catch { if (live) setPending([]) }
    }
    void refresh()
    const close = window.passwordVaultBeta?.subscribe(() => { void refresh() })
    return () => { live = false; close?.() }
  }, [])
  return pending
}
export function openPasswordRequest(request: PasswordApproval): void {
  reveal = { sessionId: request.sessionId, requestId: request.requestId }
  followLink({ kind: 'session', sessionId: request.sessionId, deviceId: request.deviceId })
  for (const listener of listeners) listener()
}
export function watchPasswordReveal(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
export function pendingPasswordReveal() { return reveal }
export function passwordRevealCompleted(requestId: string): void { if (reveal?.requestId === requestId) reveal = undefined }
