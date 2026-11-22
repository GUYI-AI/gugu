// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { refreshGitHubAccountState } from '../../../../apps/desktop/src/session/renderer/lib/hooks/useGithubAccounts'
import { integrationAccounts, integrationStatuses } from '../../../../apps/desktop/src/components/connections/connection-replicas'
import { queryClient } from '../../../../apps/desktop/src/lib/replica'

// A GitHub account connected, imported, defaulted or removed: the connections' statuses and accounts are read again
// (the parent invalidated the issue-connection-status key; after the replicas that key reached nothing).
describe('refreshGitHubAccountState', () => {
  it('reads the connection statuses and accounts again', async () => {
    integrationStatuses.set(['local'], {} as never)
    integrationAccounts.set(['local', 'github'], {} as never)
    const stale = () => [integrationStatuses.key('local'), integrationAccounts.key('local', 'github')]
      .map((key) => queryClient.getQueryState(key!)?.isInvalidated)
    expect(stale()).toEqual([false, false])
    refreshGitHubAccountState()
    await Promise.resolve()
    expect(stale()).toEqual([true, true])
  })
})
