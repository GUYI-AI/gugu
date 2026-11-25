import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'
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
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg-primary)] p-6 text-[length:var(--font-body)] text-[var(--text-primary)]">
      <section className="flex w-full max-w-sm flex-col items-start gap-4" aria-busy={busy}>
        <p role="alert">{t(authStorageRecoveryCopy(current))}</p>
        <Button size="lg" variant="primary" disabled={busy || (current === 'relogin' && !revision)} onClick={() => { void run() }}>
          {t(current === 'relogin' ? 'shell.authStorage.relogin' : 'shell.authStorage.retry')}
        </Button>
      </section>
    </main>
  )
}
