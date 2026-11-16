import { parseAssistantPanelSnapshot, type AssistantPanelItem, type AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { getAgentWatchStore, type AgentWatchLocalStore, type LocalRow } from '@/session/shared/remote-sessions/local-store'
import { getRendererSession } from './sessionPublication'

/**
 * @@@client-state-model — the assistant panel's on-device copies (IndexedDB `meta`, the rows the former panel cache wrote, so
 * nothing is lost on upgrade):
 * - **bodies**: a content cache. A body is immutable and addressed by `body_item_id:body_sha256`, so a kept copy is always
 *   right for the item that names it; least recently saved leave past 32 MB. ❌ a replica (no freshness, nothing to refresh).
 * - **the snapshot's copy**: the `assistantPanel` replica's async `local` (one row per owner and assistant), written when a
 *   read lands. It paints a cold start without a synchronous mirror (the 1 MB localStorage mirror is gone).
 * Rows are bound to their owner: another account never peeks them.
 */
const PREFIX = 'assistant-panel.v1:'
const MAX_BYTES = 32 * 1024 * 1024
/** Bodies kept on the device: the connection catalog's (the others are read when opened). */
const CACHED_DOMAINS = new Set(['integrations'])

type BodyRow = LocalRow & { scope: string; owner: string; assistant: string; kind: 'body'; value: string; bytes: number }
type SnapshotRow = LocalRow & { scope: string; owner: string; assistant: string; kind: 'snapshot'; value: unknown; bytes: number }

const encode = (bytes: Uint8Array) => { let value = ''; for (let start = 0; start < bytes.length; start += 8192) value += String.fromCharCode(...bytes.subarray(start, start + 8192)); return btoa(value) }
const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const scopeOf = (owner: string, assistant: string) => JSON.stringify([owner, assistant])
const bodyKey = (owner: string, assistant: string, item: Pick<AssistantPanelItem, 'domain' | 'resource_key' | 'body_item_id' | 'body_sha256'>) =>
  `${PREFIX}${scopeOf(owner, assistant)}:body:${JSON.stringify([item.domain, item.resource_key, item.body_item_id, item.body_sha256])}`
const snapshotKey = (owner: string, assistant: string) => `${PREFIX}${scopeOf(owner, assistant)}:snapshot`
const active = (owner: string) => getRendererSession()?.user.id === owner

function isBodyRow(value: unknown): value is BodyRow {
  const row = value as BodyRow | null
  return !!row && row.kind === 'body' && typeof row.key === 'string' && row.key.startsWith(PREFIX) && typeof row.owner === 'string'
    && typeof row.assistant === 'string' && typeof row.value === 'string' && Number.isFinite(row.savedAt) && Number.isFinite(row.bytes)
}

export function createAssistantPanelBodies(input: { store: () => Promise<AgentWatchLocalStore>; active: (owner: string) => boolean }) {
  const rows = new Map<string, BodyRow>()
  let stamp = 0
  let tail = Promise.resolve()
  const persist = (run: (store: AgentWatchLocalStore) => Promise<void>) => { tail = tail.then(async () => run(await input.store())).catch(() => undefined) }
  const remove = (key: string) => { rows.delete(key); persist((store) => store.delete('meta', key)) }
  /**
   * The kept bodies are loaded once, on first use (❌ when the module loads: opening IndexedDB is the app's choice of
   * moment). A peek before this answers finds none and the body is read.
   */
  let loading: Promise<void> | null = null
  const load = () => loading ??= input.store().then((store) => store.readAll('meta')).then((saved) => {
    for (const row of saved) if (isBodyRow(row) && !rows.has(row.key)) { rows.set(row.key, row); stamp = Math.max(stamp, row.savedAt) }
  }).catch(() => undefined)
  return {
    get ready() { return load() },
    peek(owner: string, assistant: string, item: AssistantPanelItem): Uint8Array | undefined {
      void load()
      if (!input.active(owner)) return undefined
      const row = rows.get(bodyKey(owner, assistant, item))
      if (!row) return undefined
      try { return decode(row.value) } catch { remove(row.key); return undefined }
    },
    save(owner: string, assistant: string, item: AssistantPanelItem, bytes: Uint8Array): void {
      void load()
      if (!input.active(owner) || !CACHED_DOMAINS.has(item.domain)) return
      const value = encode(bytes)
      const row: BodyRow = { key: bodyKey(owner, assistant, item), savedAt: stamp = Math.max(Date.now(), stamp + 1), scope: scopeOf(owner, assistant),
        owner, assistant, kind: 'body', value, bytes: value.length * 2 }
      if (row.bytes > MAX_BYTES) return
      rows.set(row.key, row)
      persist((store) => store.put('meta', row))
      let total = [...rows.values()].reduce((sum, kept) => sum + kept.bytes, 0)
      for (const old of [...rows.values()].sort((a, b) => a.savedAt - b.savedAt)) {
        if (total <= MAX_BYTES) break
        if (old.key === row.key) continue
        total -= old.bytes
        remove(old.key)
      }
    },
    /** Bodies of items no longer listed (a newer snapshot dropped or replaced them) leave. */
    forgetUnlisted(owner: string, assistant: string, snapshot: AssistantPanelSnapshot): void {
      const listed = new Set(snapshot.items.filter((item) => item.body_item_id).map((item) => bodyKey(owner, assistant, item)))
      const scope = scopeOf(owner, assistant)
      for (const row of [...rows.values()]) if (row.scope === scope && !listed.has(row.key)) remove(row.key)
    },
    async flush(): Promise<void> { await load(); await tail },
  }
}

export const assistantPanelBodies = createAssistantPanelBodies({ store: () => getAgentWatchStore(), active })

/** The snapshot's on-device copy (the replica's `local`): undefined when there is none, or it is not this account's. */
export async function readAssistantPanelSnapshotCopy(owner: string, assistant: string): Promise<AssistantPanelSnapshot | undefined> {
  const row = await (await getAgentWatchStore()).read('meta', snapshotKey(owner, assistant)) as SnapshotRow | null
  if (!row || row.kind !== 'snapshot' || row.owner !== owner || row.assistant !== assistant || !active(owner)) return undefined
  try { return parseAssistantPanelSnapshot(row.value, owner, assistant) } catch { return undefined }
}

export async function writeAssistantPanelSnapshotCopy(owner: string, assistant: string, snapshot: AssistantPanelSnapshot): Promise<void> {
  if (!active(owner)) return
  const row: SnapshotRow = { key: snapshotKey(owner, assistant), savedAt: Date.now(), scope: scopeOf(owner, assistant), owner, assistant,
    kind: 'snapshot', value: snapshot, bytes: JSON.stringify(snapshot).length * 2 }
  await (await getAgentWatchStore()).put('meta', row)
}
