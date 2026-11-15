import { expect, it } from 'vitest'
import { getPrNumber } from '@/session/shared/core/pull-requests/pull-requests'
import { parseRepositoryRef } from '@/session/shared/repository-ref'
import { extensionOf, mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs'
import { renderAssistantRule } from '@gugu/core/shared/assistantRulesFormat'
import { isTransientNetworkError } from '@gugu/core/shared/networkError'
import { LifecycleMap } from '@gugu/session-shared'
import { ok } from '@gugu/session-shared/result'

it('does not parse partial or invalid PR numbers', () => {
  for (const identifier of ['#12oops', '#0', '-1', '##7', '#9007199254740993'])
    expect(getPrNumber({ identifier })).toBeNull()
  expect(getPrNumber({ identifier: '#12' })).toBe(12)
})

it('reads HTTP and SSH repository schemes regardless of case', () => {
  expect(parseRepositoryRef('HTTPS://github.com/team/repo.git')?.nameWithOwner).toBe('team/repo')
  expect(parseRepositoryRef('SSH://git@github.com/team/repo.git')?.nameWithOwner).toBe('team/repo')
})

it('does not read a directory dot as a file extension', () => {
  expect(extensionOf('folder.md/README')).toBe('')
  expect(extensionOf('folder.png\\README')).toBe('')
  expect(mimeTypeFromName('folder.md/README')).toBeNull()
  expect(extensionOf('folder.md/note.PNG')).toBe('png')
})

it('does not fill rule templates from inherited properties', () => {
  expect(() => renderAssistantRule('{{constructor}}', {})).toThrow()
  expect(
    renderAssistantRule('{{constructor}}', Object.fromEntries([['constructor', 'value']]))
  ).toBe('value')
})

it('classifies structured transient errors with string messages', () => {
  expect(isTransientNetworkError({ message: 'fetch failed' })).toBe(true)
  expect(isTransientNetworkError({ message: 'Permission denied' })).toBe(false)
})

it('reuses and tears down a provisioned undefined resource', async () => {
  const map = new LifecycleMap<undefined, string, string>()
  let calls = 0
  await map.provision('x', async () => {
    calls++
    return ok(undefined)
  })
  await map.provision('x', async () => {
    calls++
    return ok(undefined)
  })
  expect(calls).toBe(1)
  expect(map.teardown('x', async () => ok())).not.toBeNull()
})
