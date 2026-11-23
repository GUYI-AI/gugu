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
  if (result.success) {
    forgetCachedAccountProjects()
    onSignedOut?.()
  }
  return result
}
