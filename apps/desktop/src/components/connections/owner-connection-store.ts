import { ConnectionError, type ConnectionClient, type ConnectionSnapshot } from '@gugu/core/cloud/connections'
import type { ConnectionMetadataItem, ConnectionMetadataSnapshot } from './connection-metadata'
import { createConnectionMetadataStore, type ConnectionMetadataCache } from './connection-metadata-store'
import { assertConnectionApplicationAvailable } from './connection-action-guard'

export const ownerConnectionResourceKey = (scopeKey: string, resourceKey: string) => JSON.stringify([scopeKey, resourceKey])

/** A renderer projection only. Mutations retain the service's exact scope/key;
 * the encoded display identity keeps equal keys on two devices separate. */
export function connectionMetadataSnapshot(ownerId: string, snapshot: ConnectionSnapshot): ConnectionMetadataSnapshot {
  if (snapshot.state !== 'ready') throw new ConnectionError('not-ready', 'CONNECTION_NOT_READY')
  const catalog = new Map<string, ConnectionMetadataItem>()
  const items: ConnectionMetadataItem[] = []
  for (const item of snapshot.items) {
    const isCatalog = item.resourceKey.startsWith('catalog:')
    const row: ConnectionMetadataItem = {
      owner_user_id: ownerId, domain: 'integrations', resource_key: isCatalog ? item.resourceKey : ownerConnectionResourceKey(item.scopeKey,item.resourceKey),
      source: { scopeKey: item.scopeKey,resourceKey: item.resourceKey }, device_id: item.deviceId, revision: item.revision,
      data: { ...item.data,...(item.publicMetadata ? { publicMetadata: item.publicMetadata } : {}) },
      body_item_id: null, body_sha256: item.bodySha256, deleted_at: item.deletedAt, stale_at: item.staleAt,
      observed_at: item.observedAt, updated_at: item.updatedAt,
    }
    if (isCatalog) {
      const previous = catalog.get(item.resourceKey)
      if (!previous || BigInt(previous.revision) < BigInt(row.revision)) catalog.set(item.resourceKey,row)
    } else items.push(row)
  }
  return { version: 1, revision: snapshot.revision, items: [...catalog.values(),...items], application: snapshot.application.map(change => ({
    ...change, wireStatus: change.status,status: change.status === 'started' ? 'pending' : change.status,domain: 'integrations', resourceKey: ownerConnectionResourceKey(change.scopeKey,change.resourceKey),
  })) }
}

export function createOwnerConnectionStore(input: {
  ownerId: string; deviceId?: string | null; accountId(): string | null; client: ConnectionClient; cache: ConnectionMetadataCache; reread(): void; changed(): void
  executePlatformOperation?(operationId: string): Promise<void>
}) {
  const assertCurrent = () => { if (input.accountId() !== input.ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED') }
  const store = createConnectionMetadataStore({ ownerId: input.ownerId,accountId: input.accountId,cache: input.cache,reread: input.reread,changed: input.changed,assertCurrent,
    read: async () => connectionMetadataSnapshot(input.ownerId,await input.client.snapshot(input.deviceId ?? null)),
    commit: async change => {
      const source = JSON.parse(change.key) as unknown
      if (!Array.isArray(source) || source.length !== 2 || source.some(value => typeof value !== 'string')) throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
      const { publicMetadata: _publicMetadata,...data } = change.data ?? {}
      return input.client.commit({ operationId: change.operationId,scopeKey: source[0],resourceKey: source[1],expectedRevision: change.expectedRevision,
        operation: change.operation,data,deviceId: source[0] === 'platform' ? null : change.deviceId ?? input.deviceId })
    },
    readBody: async item => {
      if (!item.source) throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
      const result = await input.client.resource(item.source.scopeKey,item.source.resourceKey)
      assertCurrent()
      if (result.state !== 'ready') throw new ConnectionError('not-ready','CONNECTION_NOT_READY')
      if (!result.item || result.item.deletedAt || result.item.revision !== item.revision) throw new ConnectionError('deleted','CONNECTION_RESOURCE_REMOVED')
      if (result.item.document === null) throw new ConnectionError('body-unavailable','CONNECTION_DOCUMENT_UNAVAILABLE')
      return new TextEncoder().encode(result.item.document)
    },
  })
  function assertAvailable(item: ConnectionMetadataItem) {
    if (item.owner_user_id !== input.ownerId) throw new ConnectionError('42501','CONNECTION_RESOURCE_NOT_OWNED')
    if (!item.source) throw new ConnectionError('invalid-resource','CONNECTION_RESOURCE_INVALID')
    return assertConnectionApplicationAvailable({ ...input,provider: String(item.data.providerId),scopeKey: item.source.scopeKey,requireReady: true })
  }
  return { ...store,...(input.deviceId ? { deviceId: input.deviceId } : {}),async change(item: ConnectionMetadataItem,operation: Parameters<typeof store.change>[1]) {
    await assertAvailable(item)
    // The commit itself told the others (the base store's `changed`); executing a platform removal changes it again.
    const receipt = await store.change(item,operation)
    if (item.source?.scopeKey === 'platform' && operation === 'remove' && receipt.status === 'pending') {
      try {
        if (!input.executePlatformOperation) throw new ConnectionError('platform-unavailable','CONNECTION_PLATFORM_UNAVAILABLE')
        await input.executePlatformOperation(receipt.operationId)
        assertCurrent()
      } finally { input.changed() }
    }
    return receipt
  },async save(item: ConnectionMetadataItem,data: Record<string,unknown>) {
    await assertAvailable(item)
    return store.save(item,data)
  } }
}
