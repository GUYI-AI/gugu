import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ getOwners: vi.fn() }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: { github: { getOwners: ipc.getOwners } }, rpcOn: () => ({}), events: { on: () => () => {} }, onMachineEvent: () => () => {} }))

const { queryClient } = await import('@/lib/replica')
const { githubOwners } = await import('./useGithubRepositoryOwners')

beforeEach(() => { notifyManager.setScheduler((callback) => { callback() }) })
afterEach(() => { queryClient.clear(); vi.clearAllMocks() })

describe('GitHub reads say when they fail', () => {
  it('an owners read the host refused is an error, ❌ an empty list of owners', async () => {
    ipc.getOwners.mockResolvedValueOnce({ success: false, error: 'token expired' })
    await expect(githubOwners.fetch('acct')).rejects.toThrow('token expired')
    expect(githubOwners.peek('acct')).toMatchObject({ state: 'error' })
  })

  it('owners read are the choices, by login', async () => {
    ipc.getOwners.mockResolvedValueOnce({ success: true, owners: [{ login: 'octo' }, { login: 'acme' }] })
    expect(await githubOwners.fetch('acct2')).toEqual([{ value: 'octo', label: 'octo' }, { value: 'acme', label: 'acme' }])
    expect(ipc.getOwners).toHaveBeenCalledWith('acct2')
  })
})
