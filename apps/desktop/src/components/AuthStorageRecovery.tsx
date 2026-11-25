import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import '../pages/login/login.css'
import { authStorageRecoveryAction, authStorageRecoveryCopy, type AuthStorageRecoveryAction } from '../lib/authStorageFailure'
import { nativeAuthRecoveryState } from '../lib/nativeAuthRecoveryState'
import { useReplica } from '../lib/replica'
import { sessionCoordinator } from '../lib/sessionCoordinator'

/** Only explicit consent can discard unreadable login data. Closure custody stays native. */
export function AuthStorageRecovery({ action }: { action: AuthStorageRecoveryAction }) {
  const { t } = useTranslation('main')
  const reading = useReplica(nativeAuthRecoveryState, action === 'relogin' ? [] : null)
  const [failure, setFailure] = useState<AuthStorageRecoveryAction | null>(null)
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const current = failure ?? (action !== 'relogin' ? action : reading.state === 'error' ? 'retry'
    : reading.state === 'value' && !reading.value.canReset ? 'closure-pending' : 'relogin')
  const revision = reading.state === 'value' && reading.value.canReset && !reading.error ? reading.value.revision : null
  const run = async () => {
    if (flight.current) return
    flight.current = true; setBusy(true)
    try {
      if (current === 'relogin' && revision) {
        await sessionCoordinator.resetUnreadableAuthStorage(revision)
        // Recreate auth-js after its failed initialization; do not sign out or issue auth requests.
        window.location.reload()
      } else {
        await sessionCoordinator.retryAuthStorage()
        await nativeAuthRecoveryState.refresh()
        setFailure(null)
      }
    } catch (error) { setFailure(authStorageRecoveryAction(error) ?? 'retry') }
    finally { flight.current = false; setBusy(false) }
  }
  const title = current === 'relogin' ? 'shell.authStorage.titleUnreadable' : current === 'closure-pending'
    ? 'shell.authStorage.titleClosure' : 'shell.authStorage.titleUnavailable'
  return (
    <main className="gugu-auth-page">
      <section className="gugu-auth-shell gugu-auth-recovery-shell" aria-labelledby="gugu-auth-recovery-title" aria-busy={busy}>
        <div className="gugu-auth-pane">
          <div className="gugu-auth-login">
            <header className="gugu-auth-heading">
              <img className="gugu-auth-logo" src={publicAssetPath('/assets/app/gugu-icon-512.png')} alt={t('brand.name')} draggable={false} />
              <h1 id="gugu-auth-recovery-title">{t(title)}</h1>
              <p role="alert">{t(authStorageRecoveryCopy(current))}</p>
            </header>
            <Button size="xl" variant="primary" className="gugu-auth-submit" disabled={busy || (current === 'relogin' && !revision)} onClick={() => { void run() }}>
              {t(current === 'relogin' ? 'shell.authStorage.relogin' : 'shell.authStorage.retry')}
            </Button>
            {current === 'relogin' && <p className="gugu-auth-legal">{t('shell.authStorage.localOnly')}</p>}
          </div>
        </div>
      </section>
    </main>
  )
}
