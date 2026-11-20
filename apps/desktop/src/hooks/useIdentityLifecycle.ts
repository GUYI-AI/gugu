import { useEffect, useRef } from 'react'
import { pruneUnreferencedIdentities, referencedIdentityIds, type AccountImRepository } from '../lib/imRepository'
import { readDisplayIdentities } from '../lib/identityReadAdapter'
import { refreshObservedAgentPresenceFromRevision } from '../lib/agentPresenceStore'
import { dataClient } from '../lib/supabase'
import { subscribeAuthenticatedRealtimeChannel, unsubscribeAuthenticatedRealtimeChannel } from '../lib/realtimeChannel'
import { UI_EVENTS } from '../lib/uiEvents'
import { rendererLogger } from '../lib/log'

/**
 * Broadcasts only invalidate known caches. Reconnect always reads authoritative snapshots first; afterwards the
 * identity cache keeps only what the conversation list and the contacts still name, so the re-read that follows asks
 * for live identities only (an archived or departed agent's cached row is not read again on every reconnect).
 * `contactIds` returns the current contact ids, or null while they are unknown (then nothing is dropped).
 */
export function useIdentityLifecycle(userId: string | null | undefined, getRepository: () => Promise<AccountImRepository>, reload: () => Promise<unknown>, contactIds: () => readonly string[] | null): void {
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const contactIdsRef = useRef(contactIds)
  contactIdsRef.current = contactIds
  useEffect(() => {
    if (!userId) return
    let active = true
    const invalidate = async (id: string | null) => {
      const repository = await getRepository()
      if (!active) return
      if (id === null) {
        await reloadRef.current()
        if (!active) return
        const contacts = contactIdsRef.current()
        if (contacts) await pruneUnreferencedIdentities(repository, referencedIdentityIds(repository, contacts))
        if (!active) return
      }
      const snapshot = repository.snapshot()
      const listed = new Set(snapshot.chat.map(row => row.id))
      const known = new Set([...snapshot.identity.map(row => row.id), ...snapshot.membership.filter(row => listed.has(row.chatId)).map(row => row.identityId)])
      if (id !== null && !known.has(id)) return
      const ids = id === null ? [...known] : [id]
      await Promise.all([
        readDisplayIdentities(ids).then(rows => { if (active) return repository.putIdentities(rows) }),
        refreshObservedAgentPresenceFromRevision(ids.map(agent_user_id => ({ agent_user_id }))),
        ...(id === null ? [] : [reloadRef.current()]),
      ])
      if (active) window.dispatchEvent(new CustomEvent(UI_EVENTS.identityInvalidated, { detail: { id } }))
    }
    const refresh = (id: string | null) => { void invalidate(id).catch(error => rendererLogger('identity/lifecycle').error({ error }, 'Identity snapshot refresh failed')) }
    const channel = subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('gugu:identity:lifecycle', {
      config: { private: true, broadcast: { self: false } },
    }).on('broadcast', { event: 'identity_removed' }, ({ payload }) => {
      if (typeof payload?.id !== 'string' || typeof payload.removed_at !== 'string' || !Number.isFinite(Date.parse(payload.removed_at))) {
        rendererLogger('identity/lifecycle').error({}, 'Malformed identity removal invalidation')
        return
      }
      refresh(payload.id)
    }), 'identity lifecycle', { onSubscribed: () => refresh(null), reconnectWhenIdle: false })
    return () => { active = false; void unsubscribeAuthenticatedRealtimeChannel(channel) }
  }, [userId, getRepository])
}
