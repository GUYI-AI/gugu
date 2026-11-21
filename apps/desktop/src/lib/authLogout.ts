import { platform } from '../platform'
import { sessionCoordinator } from './sessionCoordinator'
import { forgetCachedAccountProjects } from '@/session/renderer/features/projects/stores/account-projects-cache'

/** Desktop sign-out also restarts the process: module state and native library connections
 * belong to the old account and cannot safely be reused by the next sign-in. */
export async function logoutAndRelaunch(onSignedOut?: () => void): Promise<{ success: boolean }> {
  const result = await sessionCoordinator.logout()
  if (result.success) await finishSignedOut(onSignedOut)
  return result
}

/** The one tail after an account has left this renderer: ordinary sign-out above, and account
 * closure, whose native side already retired Auth (it never calls logout() again). */
export async function finishSignedOut(onSignedOut?: () => void): Promise<void> {
  forgetCachedAccountProjects()
  onSignedOut?.()
  if (platform.capabilities.appRelaunch) await platform.relaunchApp()
}
