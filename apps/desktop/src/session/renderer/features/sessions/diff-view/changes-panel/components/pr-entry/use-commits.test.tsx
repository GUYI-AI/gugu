// @vitest-environment jsdom
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../../../../../../../../../tests/support/testHarness'
import { COMMIT_PAGE_SIZE, useCommits } from './use-commits'

type CommitPages = ReturnType<typeof useCommits>

const git = vi.hoisted(() => ({ getLog: vi.fn() }))
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({ workspaceRpc: () => ({ gitWorktree: { getLog: git.getLog } }) }))

const page = (count: number, from: number) => ({
  success: true,
  data: { aheadCount: 60, commits: Array.from({ length: count }, (_, i) => ({ hash: `c${from + i}` })) },
})

/** A range's commits, a page at a time: each page is its own entry, read once (both ends are oids). */
describe('commits of a range', () => {
  it('reads the first page, then the next one asked for at its offset; a remount reads nothing again', async () => {
    git.getLog.mockImplementation(async (_w, _limit, offset: number) => page(offset === 0 ? COMMIT_PAGE_SIZE : 10, offset))
    const range = { source: 'branch' as const, baseRefOid: 'b1', headRefOid: 'h1' }
    let seen: CommitPages | undefined
    const Probe = () => { seen = useCommits('p', 'w', range); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    expect(seen!.pages).toHaveLength(1)
    expect(seen!.first).toMatchObject({ state: 'value' })
    expect(seen!.more).not.toBeNull()
    await act(async () => { seen!.more!() })
    expect(seen!.pages).toHaveLength(2)
    expect(git.getLog.mock.calls.map((call) => call[2])).toEqual([0, COMMIT_PAGE_SIZE])
    expect(seen!.more).toBeNull()
    harness.cleanup({ keepReads: true })

    const again = createReactHarness()
    await again.render(createElement(Probe))
    expect(seen!.first).toMatchObject({ state: 'value' })
    expect(git.getLog).toHaveBeenCalledTimes(2)
    again.cleanup()
  })

  it('a page the host refused is an error reading (with a retry), ❌ an empty list', async () => {
    git.getLog.mockResolvedValue({ success: false, error: { type: 'git' } })
    let seen: CommitPages | undefined
    const Probe = () => { seen = useCommits('p', 'w', { source: 'branch', baseRefOid: 'b2', headRefOid: 'h2' }); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    expect(seen!.first).toMatchObject({ state: 'error' })
    harness.cleanup()
  })
})
