// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { refreshGitHubAccountState } from '../../../../apps/desktop/src/session/renderer/lib/hooks/useGithubAccounts'
import { integrationAccounts, integrationStatuses } from '../../../../apps/desktop/src/components/connections/connection-replicas'

// A GitHub account connected, imported, defaulted or removed: the connections' statuses and accounts are read again
// (the parent invalidated the issue-connection-status key; after the replicas that key reached nothing).
describe('refreshGitHubAccountState', () => {
  it('reads the connection statuses and accounts again', () => {
    const statuses = vi.spyOn(integrationStatuses, 'refresh').mockResolvedValue()
    const accounts = vi.spyOn(integrationAccounts, 'refresh').mockResolvedValue()
    refreshGitHubAccountState()
    expect(statuses).toHaveBeenCalledTimes(1)
    expect(accounts).toHaveBeenCalledTimes(1)
  })
})
