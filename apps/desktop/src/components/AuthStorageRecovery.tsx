import { useTranslation } from 'react-i18next'
import type { AuthStorageRecoveryAction } from '../lib/authStorageFailure'

/** Storage failure is unresolved login, never a successful anonymous result. */
export function AuthStorageRecovery({ action }: { action: AuthStorageRecoveryAction }) {
  const { t } = useTranslation('main')
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg-primary)] p-6 text-[length:var(--font-body)] text-[var(--text-primary)]">
      <p role="alert">{t(action)}</p>
    </main>
  )
}
