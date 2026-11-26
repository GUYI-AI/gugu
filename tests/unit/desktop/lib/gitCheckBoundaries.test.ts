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
