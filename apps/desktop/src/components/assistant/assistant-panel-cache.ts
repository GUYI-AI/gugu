/**
 * ⚠️ TRANSITIONAL — deleted by the apps commit (read-model PR 3, commit 9: `ownerConnections` / `chatChannels` replicas in
 * components/connections/connection-replicas.ts). What is left of the former assistant panel cache: only its two
 * account-state row kinds, `owner-connections.v1:<epoch>:<device|all>` (connection-host.ts) and
 * `application-connections:wechat` (settings/channels/useChatChannels.ts). The panel snapshot is the `assistantPanel`
 * replica and the bodies are lib/assistantPanelBodies (the 1 MB localStorage mirror is gone): these two rows now live in
 * IndexedDB only, so their first frame after a restart waits for it (`subscribeAccountState` says when it is there).
 * Exports kept: `assistantPanelCacheStore` (its `accountState(owner, key, isValue)` → `{peek, save}`, `flush`),
 * `subscribeAccountState`, and `createAccountStateStore` (tests). ❌ add anything here.
 */
import { getAgentWatchStore, type AgentWatchLocalStore, type LocalRow } from '@/session/shared/remote-sessions/local-store'
import { getRendererSession } from '@/lib/sessionPublication'

const PREFIX = 'assistant-panel.v1:'
type AccountStateRow = LocalRow & { scope: string; owner: string; assistant: ''; kind: 'account-state'; value: unknown; bytes: number }

export function createAccountStateStore(input: { store: () => Promise<AgentWatchLocalStore>; accountId: () => string | null }) {
  const rows = new Map<string, AccountStateRow>()
  const listeners = new Set<() => void>()
  let tail = Promise.resolve()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const ready = input.store().then((store) => store.readAll('meta')).then((saved) => {
    for (const raw of saved) {
      const row = raw as AccountStateRow
      if (row.kind === 'account-state' && typeof row.key === 'string' && row.key.startsWith(PREFIX) && typeof row.owner === 'string' && !rows.has(row.key)) rows.set(row.key, row)
    }
    notify()
  }).catch(() => undefined)
  function accountState<T>(owner: string, key: string, isValue: (value: unknown) => value is T) {
    const id = `${PREFIX}${JSON.stringify([owner, ''])}:account:${key}`
    const active = () => !!owner && input.accountId() === owner
    return {
      peek(): T | undefined { const value = active() ? rows.get(id)?.value : undefined; return isValue(value) ? value : undefined },
      save(value: T): void {
        if (!active() || !isValue(value) || JSON.stringify(rows.get(id)?.value) === JSON.stringify(value)) return
        const row: AccountStateRow = { key: id, savedAt: Date.now(), scope: JSON.stringify([owner, '']), owner, assistant: '', kind: 'account-state', value, bytes: JSON.stringify(value).length * 2 }
        rows.set(id, row)
        tail = tail.then(async () => (await input.store()).put('meta', row)).catch(() => undefined)
        notify()
      },
    }
  }
  return { accountState, ready, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async flush(): Promise<void> { await ready; await tail } }
}

let shared: ReturnType<typeof createAccountStateStore> | undefined
export function assistantPanelCacheStore() {
  return shared ??= createAccountStateStore({ store: getAgentWatchStore, accountId: () => getRendererSession()?.user.id ?? null })
}

/** The kept rows arrived from IndexedDB, or one was saved. */
export function subscribeAccountState(listener: () => void): () => void {
  return assistantPanelCacheStore().subscribe(listener)
}
