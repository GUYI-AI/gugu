import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `gugu.github` (60): main adds the connected account's token and talks to api.github.com only; GitHub's 4xx goes back
 * to the App as its answer, and no connected account is `unavailable` (the App says where to connect).
 */
const accounts = vi.hoisted(() => ({ list: [] as Array<{ accountId: string; host: string; isDefault: boolean }>, token: { success: true, data: 'tok-1' } as unknown }))
vi.mock('../../../../apps/desktop/electron/session/main/core/github/accounts/github-account-service-instance', () => ({
  githubAccountService: { listAccounts: async () => accounts.list },
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/github/services/github-api-auth-service-instance', () => ({
  githubApiAuthService: { getToken: async () => accounts.token },
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/github/accounts/github-account-reconciliation-instance', () => ({
  githubAccountReconciliationService: { reconcileOnce: async () => ({ importedCliAccountIds: [] }) },
}))
const { githubForApp } = await import('../../../../apps/desktop/electron/session/main/core/extensions/app-github')

const fetchMock = vi.fn()
beforeEach(() => {
  accounts.list = [{ accountId: 'a1', host: 'github.com', isDefault: true }]
  accounts.token = { success: true, data: 'tok-1' }
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

describe('gugu.github in main', () => {
  it('reads with the account token and hands back status and parsed JSON', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { number: 7, head: { sha: 'abc' } }))
    await expect(githubForApp('githubRead', { path: '/repos/GUYI-AI/gugu/pulls/7' })).resolves.toEqual({ status: 200, data: { number: 7, head: { sha: 'abc' } } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.github.com/repos/GUYI-AI/gugu/pulls/7')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer tok-1')
    expect(init.body).toBeUndefined()
  })

  it('writes the body as JSON and returns GitHub\'s refusal instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { message: 'Head branch was modified. Review and try the merge again.' }))
    const answer = await githubForApp('githubWrite', { method: 'put', path: '/repos/GUYI-AI/gugu/pulls/7/merge', body: { sha: 'abc', merge_method: 'merge' } })
    expect(answer).toEqual({ status: 409, data: { message: 'Head branch was modified. Review and try the merge again.' } })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ sha: 'abc', merge_method: 'merge' })
  })

  it('never leaves api.github.com and refuses a GET dressed as a write', async () => {
    for (const path of ['https://evil.example/x', '//evil.example/x', 'repos/x', 42]) {
      await expect(githubForApp('githubRead', { path })).rejects.toMatchObject({ code: 'invalid' })
    }
    await expect(githubForApp('githubWrite', { method: 'GET', path: '/user' })).rejects.toMatchObject({ code: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is unavailable without a connected account, and says where to connect', async () => {
    accounts.list = []
    await expect(githubForApp('githubRead', { path: '/user' })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('Connectors') })
    accounts.list = [{ accountId: 'a1', host: 'github.com', isDefault: true }]
    accounts.token = { success: false, error: { message: 'token revoked' } }
    await expect(githubForApp('githubRead', { path: '/user' })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('token revoked') })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('not reaching GitHub is a failure with the reason', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('getaddrinfo ENOTFOUND api.github.com'))
    await expect(githubForApp('githubRead', { path: '/user' })).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('ENOTFOUND') })
  })
})
