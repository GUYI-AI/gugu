import { expect, it, vi } from 'vitest'
import { computeCheckBucket, computeCheckRunsSummary, formatCheckDuration } from '../../../../apps/desktop/src/session/renderer/utils/github/utils'
import { classifyPushError, classifyPullError } from '../../../../packages/session-core/src/git/errors'
import { GitRepository, type GitRepositoryOptions } from '../../../../packages/session-core/src/git/git-repository'
import { parseNumstat } from '../../../../packages/session-core/src/git/parsers/numstat-parser'

vi.mock('@/i18n/format', () => ({ formatRelativeTime: () => '' }))

it('keeps requested GitHub checks pending', () => {
  const check = { status: 'requested', conclusion: null } as Parameters<typeof computeCheckBucket>[0]
  expect(computeCheckBucket(check)).toBe('pending')
  expect(computeCheckRunsSummary([check])).toMatchObject({ completed: 0, pending: 1, skipped: 0 })
})

it('shows seconds for completed sub-minute checks', () => {
  expect(formatCheckDuration('2026-11-26T00:00:00Z', '2026-11-26T00:00:42Z')).toBe('42s')
  expect(formatCheckDuration('2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z')).toBe('0s')
  expect(formatCheckDuration('2026-11-26T00:00:00Z', '2026-11-26T00:01:02Z')).toBe('1m 2s')
})

it('reads every remote in CRLF output', async () => {
  const repository = new GitRepository({
    gitCommonDir: '/repo/.git', objectStoreDir: '/repo/.git/objects',
    exec: { exec: async () => ({ stdout: 'origin\thttps://example.test/origin.git (fetch)\r\norigin\thttps://example.test/origin.git (push)\r\nupstream\thttps://example.test/upstream.git (fetch)\r\n', stderr: '' }) },
    watcher: { watch: () => ({ ready: async () => {}, release: async () => {} }) },
    objectStoreMutex: {},
  } as unknown as GitRepositoryOptions)
  try {
    expect(await repository.getRemotes()).toEqual({ remotes: [
      { name: 'origin', url: 'https://example.test/origin.git' },
      { name: 'upstream', url: 'https://example.test/upstream.git' },
    ] })
  } finally { await repository.dispose() }
})

it('does not trim significant whitespace from numstat filenames', () => {
  expect([...parseNumstat('1\t2\tfile with space \n')]).toEqual([['file with space ', { additions: 1, deletions: 2 }]])
  expect([...parseNumstat('1\t2\tfirst\n3\t4\tlast \t\n')]).toEqual([
    ['first', { additions: 1, deletions: 2 }], ['last \t', { additions: 3, deletions: 4 }],
  ])
})
