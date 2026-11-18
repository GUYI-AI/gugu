import { platform } from '../platform'
import { sessionCoordinator } from './sessionCoordinator'
import { forgetCachedAccountProjects } from '@/session/renderer/features/projects/stores/account-projects-cache'

/** Desktop sign-out also restarts the process: module state and native library connections
 * belong to the old account and cannot safely be reused by the next sign-in. */
export async function logoutAndRelaunch(onSignedOut?: () => void): Promise<{ success: boolean }> {
  const result = await sessionCoordinator.logout()
  if (result.success) {
    forgetCachedAccountProjects()
    onSignedOut?.()
    if (platform.capabilities.appRelaunch) await platform.relaunchApp()
  }
  return result
}
