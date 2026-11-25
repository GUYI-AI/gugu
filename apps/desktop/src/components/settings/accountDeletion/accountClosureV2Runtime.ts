import { platform } from '../../../platform'
import { desktopIpc } from '../../../platform/desktopIpc'
import { finishSignedOut } from '../../../lib/authLogout'
import { sessionCoordinator } from '../../../lib/sessionCoordinator'
import { observeRendererSession } from '../../../lib/sessionPublication'
import { forgetCachedAccountProjectsForOwner } from '../../../session/renderer/features/projects/stores/account-projects-cache'
import { createAccountClosureV2Controller } from './accountClosureV2Controller'

const notifyClosed = () => {
  void Promise.all([import('../../../lib/notices'), import('../../../i18n'), import('../../../i18n/registerSettingsCatalog')])
    .then(([{ notify }, { i18n }]) => {
      if (!sessionCoordinator.getSnapshot().session) notify({ key: 'account-closed', tier: 'success', title: i18n.t('accountDeletion.deleted', { ns: 'settings' }) })
    }).catch(() => undefined)
}
/** Runs only after native finalize returned `finalized` (receipt removed, record terminal), so
 * no local closure work is left to interrupt. Leaves through the ordinary sign-out tail, in place.
 * A new login keeps its renderer. */
function finishClosedAccount(): void {
  if (sessionCoordinator.getSnapshot().session) return
  finishSignedOut(notifyClosed)
}

let controller: ReturnType<typeof createAccountClosureV2Controller> | null | undefined
export function accountClosureV2Controller() {
  if (controller === undefined) controller = platform.accountClosureV2
    ? createAccountClosureV2Controller(platform.accountClosureV2, async owner => {
      await sessionCoordinator.finalizeClosedOwner(owner)
      if (sessionCoordinator.getSnapshot().session?.user.id) {
        throw Object.assign(new Error('A new login owns the renderer'), { code: 'wrong_local_owner' })
      }
      forgetCachedAccountProjectsForOwner(owner)
    }, finishClosedAccount) : null
  return controller
}

/** Subscribe first, then discover: an event is merely a refresh hint, never
 * proof of deletion/cancellation. The root mounts this even while signed out.
 */
export function observeAccountClosureV2Recovery(onError: (error: unknown) => void): () => void {
  const current = accountClosureV2Controller()
  if (!current) return () => undefined
  let disposed = false
  const refresh = () => { if (!disposed) void current.recoverOriginal().catch(error => { if (!disposed) onError(error) }) }
  const changed = desktopIpc()?.eventOn('account-closure:v2-changed', refresh)
  const auth = observeRendererSession(refresh)
  const foreground = platform.subscribeAppForeground(refresh, onError)
  refresh()
  return () => { disposed = true; changed?.(); auth(); foreground() }
}
