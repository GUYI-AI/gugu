/** Storage failure is unresolved login, never a successful anonymous result. */
export function AuthStorageRecovery({ action }: { action: string }) {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 'var(--font-body)' }}>
      <p role="alert">{action}</p>
    </main>
  )
}
