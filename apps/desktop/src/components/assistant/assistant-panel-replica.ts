import { assistantPanelCollection, type AssistantPanelDomain, type AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import type { AssistantPanelReadCache } from '@gugu/core/cloud/assistantPanelCache'
import { withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import { replica, useReplica, type Reading } from '@/lib/replica'
import { assistantPanelBodies, readAssistantPanelSnapshotCopy, writeAssistantPanelSnapshotCopy } from '@/lib/assistantPanelBodies'
import { rendererLogger } from '@/lib/log'
import { requireAssistantPanelBridge } from '@/lib/assistantPanelBridge'

const log = rendererLogger('assistant/panel')

const newer = (shown: AssistantPanelSnapshot, next: AssistantPanelSnapshot) => (BigInt(shown.revision) > BigInt(next.revision) ? shown : next)

/**
 * The assistant's panel (@@@client-state-model, signal tier): the cloud snapshot of its collections, versioned by the server
 * head `revision`; a landing read or write never replaces a newer one (`merge` keeps the higher revision, I3). Read again
 * on `assistant_panel_changed` and each resubscription of the private bus (its `watch`), on focus, after local
 * commits (the panel files read through `fetch`). Its first value on this device is the IndexedDB copy (`local`, async:
 * a cold start is one frame late only when it opens straight on the panel; otherwise the session restore prefetches it,
 * below). Not in the localStorage snapshot: it grows (the 1 MB synchronous mirror it once needed is gone).
 */
export const assistantPanel = replica({
  name: 'assistantPanel',
  scope: 'account',
  read: async (owner: string, assistantId: string): Promise<AssistantPanelSnapshot> => {
    // The shell's cloud client, through the panel bridge (this module also loads with the session page, which holds no credentials).
    const snapshot = await withAssistantPanelReadDeadline(() => requireAssistantPanelBridge().panelSnapshot(owner, assistantId))
    assistantPanelBodies.forgetUnlisted(owner, assistantId, snapshot)
    void writeAssistantPanelSnapshotCopy(owner, assistantId, snapshot).catch((error: unknown) => log.warn({ error: String(error) }, 'panel copy not kept on this device'))
    return snapshot
  },
  local: (owner: string, assistantId: string) => readAssistantPanelSnapshotCopy(owner, assistantId),
  merge: newer,
  retry: 2,
  refreshOnFocus: true,
  watch: { group: (assistantId) => assistantId, start: (owner, assistantId) => watchPanel(owner, assistantId) },
})

export function useAssistantPanel(ownerId: string | null, assistantId: string | null): Reading<AssistantPanelSnapshot> {
  return useReplica(assistantPanel, ownerId && assistantId ? [assistantId] : null)
}

/**
 * A panel changed: its revision moved (a newer snapshot read or written) or it left (an account switch). ❌ every cache
 * event: a read starting or landing with the same revision is no change, and readers that read the panel again on a
 * change would otherwise feed themselves (review DE-1). `assistantId` undefined = any assistant's panel.
 */
export function onAssistantPanelChanged(assistantId: string | undefined, listener: () => void): () => void {
  const seen = new Map<string, string | null>()
  for (const entry of assistantPanel.entries(...(assistantId ? [assistantId] as [string] : []))) {
    if (entry.reading.state === 'value') seen.set(entry.args[0], entry.reading.value.revision)
  }
  return assistantPanel.subscribe(assistantId ? [assistantId] : [], (entry) => {
    const revision = entry.reading.state === 'value' ? entry.reading.value.revision : null
    if (entry.reading.state === 'unknown' && !seen.has(entry.args[0])) return
    if (seen.get(entry.args[0]) === revision && seen.has(entry.args[0])) return
    seen.set(entry.args[0], revision)
    listener()
  })
}

/** A collection the home has not prepared yet is announced as a burst of changes while it fills: read once it settles. */
const SETTLE_MS = 1_000
const preparing = (value: AssistantPanelSnapshot | null) =>
  !!value && (['memory', 'integrations', 'voice-notes', 'files', 'skills'] as AssistantPanelDomain[]).some((domain) => {
    // Being filled: rows already published, the collection not marked ready yet.
    try { const collection = assistantPanelCollection(value, domain); return collection.state === 'unprepared' && collection.items.length > 0 } catch { return false }
  })

// One bus listener per (owner, assistant) while shown or held (`hold`, the panel files).
function watchPanel(ownerId: string, assistantId: string): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined
  // Read again now even where only the panel files hold it (no surface subscribed): their readers peek the entry. A read
  // the refresh started for a shown entry is shared, ❌ a second one.
  const readAgain = () => { void assistantPanel.refresh(assistantId); void assistantPanel.prefetch(assistantId) }
  const refresh = () => {
    clearTimeout(settle)
    const shown = assistantPanel.peek(assistantId)
    if (preparing(shown.state === 'value' ? shown.value : null)) settle = setTimeout(readAgain, SETTLE_MS)
    else readAgain()
  }
  // The shell's private-bus subscription (`assistant_panel_changed`, and each resubscription with no payload).
  const stopBus = requireAssistantPanelBridge().subscribeChanges(ownerId, (payload) => {
    const about = (payload as { assistantId?: string } | null | undefined)?.assistantId
    if (!about || about === assistantId) refresh()
  }, 'panel')
  return () => { clearTimeout(settle); stopBus() }
}

/**
 * The panel files' local copies (core `AssistantPanelReadCache`): the snapshot is this replica's entry (a newer one is
 * never replaced), the bodies are the content cache. Bound to the account that opened the files.
 */
export function assistantPanelReadCache(ownerId: string, assistantId: string): AssistantPanelReadCache {
  const mine = () => assistantPanel.key(assistantId)?.[1] === ownerId
  const entry = () => assistantPanel.at(assistantId)
  return {
    peekSnapshot: () => {
      if (!mine()) return undefined
      const reading = assistantPanel.peek(assistantId)
      return reading.state === 'value' ? reading.value : undefined
    },
    saveSnapshot: (snapshot) => {
      if (!mine()) return
      // Only a newer revision is a write (the panel files save what every read returned, the shown one included).
      const shown = assistantPanel.peek(assistantId)
      if (shown.state === 'value' && BigInt(shown.value.revision) >= BigInt(snapshot.revision)) return
      entry().set((shown) => (shown ? newer(shown, snapshot) : snapshot))
      assistantPanelBodies.forgetUnlisted(ownerId, assistantId, snapshot)
    },
    peekBody: (item) => assistantPanelBodies.peek(ownerId, assistantId, item),
    saveBody: (item, bytes) => assistantPanelBodies.save(ownerId, assistantId, item, bytes),
    forget: (domain, key, revision) => {
      if (!mine()) return
      entry().set((shown) => (shown && BigInt(revision) >= BigInt(shown.revision)
        ? { ...shown, revision, items: shown.items.filter((item) => item.domain !== domain || item.resource_key !== key) }
        : shown))
    },
  }
}
