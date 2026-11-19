// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openedImRepository, openImRepository } from '../../../../apps/desktop/src/lib/imRepository'

/**
 * The repository the chat provider opened is handed to readers outside the provider (replicas): they wait while it
 * opens, get the open one, learn when the open failed (❌ wait forever showing nothing), and a closed one is gone.
 */
describe('openedImRepository', () => {
  it('hands out the open repository to a reader that asked before it opened', async () => {
    const waiting = openedImRepository('acct-open')
    const repository = await openImRepository('acct-open', { adapter: createMemoryLocalSyncDb() })
    await expect(waiting).resolves.toBe(repository)
    repository.close()
  })

  it('a closed repository is not handed out; the next open is', async () => {
    const first = await openImRepository('acct-reopen', { adapter: createMemoryLocalSyncDb() })
    first.close()
    const asked = openedImRepository('acct-reopen')
    const second = await openImRepository('acct-reopen', { adapter: createMemoryLocalSyncDb() })
    await expect(asked).resolves.toBe(second)
    second.close()
  })

  it('a failed open fails the readers waiting for it, and a later open replaces that answer', async () => {
    const waiting = openedImRepository('acct-broken')
    const broken = { ...createMemoryLocalSyncDb(), loadAccount: async () => { throw new Error('store unreadable') } }
    await expect(openImRepository('acct-broken', { adapter: broken })).rejects.toThrow('store unreadable')
    await expect(waiting).rejects.toThrow('store unreadable')
    const repository = await openImRepository('acct-broken', { adapter: createMemoryLocalSyncDb() })
    await expect(openedImRepository('acct-broken')).resolves.toBe(repository)
    repository.close()
  })
})
