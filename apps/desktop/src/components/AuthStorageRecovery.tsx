/** Storage failure is unresolved login, never a successful anonymous result. */
export function AuthStorageRecovery({ action }: { action: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg-primary)] p-6 text-[length:var(--font-body)] text-[var(--text-primary)]">
      <p role="alert">{action}</p>
    </main>
  )
}
