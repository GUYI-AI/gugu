import { sessionCoordinator } from './sessionCoordinator'
import { forgetCachedAccountProjects } from '@/session/renderer/features/projects/stores/account-projects-cache'

/**
 * Sign-out returns to the login page in place. What belonged to the account is dropped by the account's own lifetime,
 * the same way for a sign-out and for a session that was lost: the renderer's account-scoped stores and replicas
 * (`onAccountChange`), the signed-in product tree and the session page inside it (unmounted with it), and in main the
 * session lifecycle and device runtime (`human-auth-session:clear`).
 */
export async function logout(onSignedOut?: () => void): Promise<{ success: boolean }> {
  const result = await sessionCoordinator.logout()
  if (result.success) finishSignedOut(onSignedOut)
  return result
}

/** The one tail after an account has left this renderer: ordinary sign-out above, and account
 * closure, whose native side already retired Auth (it never calls logout() again). */
export function finishSignedOut(onSignedOut?: () => void): void {
  forgetCachedAccountProjects()
  onSignedOut?.()
}
