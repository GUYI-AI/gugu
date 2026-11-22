// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../../../../../../../../../tests/support/testHarness'
import { SectionHeader } from '../section-header'
import { CommentsList } from './comments-list'

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: {} }, events: { on: () => () => {} }, onMachineEvent: () => () => {} }))

/** A pull request's comments and the branch's commits are read: until they are, nothing says "none" or "0". */
describe('the changes panel while its git reads are on their way', () => {
  it('comments not read yet hold their place, ❌ "no comments"', async () => {
    const harness = createReactHarness()
    await harness.render(createElement(CommentsList, { comments: { state: 'unknown' } }))
    expect(harness.container.querySelector('[data-unknown]')).not.toBeNull()
    expect(harness.container.textContent).not.toContain('pr.noComments')
    harness.cleanup()
  })

  it('comments that could not be read say so, with a retry', async () => {
    const harness = createReactHarness()
    const onRetry = vi.fn()
    await harness.render(createElement(CommentsList, { comments: { state: 'error', error: new Error('rate limited'), retry: async () => { onRetry() } } }))
    expect(harness.container.textContent).toContain('pr.commentsFailed')
    expect(harness.container.textContent).not.toContain('pr.noComments')
    harness.container.querySelector<HTMLButtonElement>('[data-read-failed] button')!.click()
    expect(onRetry).toHaveBeenCalledOnce()
    harness.cleanup()
  })

  it('a section whose count is not read yet draws a placeholder, ❌ 0', async () => {
    const harness = createReactHarness()
    await harness.render(createElement(SectionHeader, { label: null, count: null }))
    expect(harness.container.querySelectorAll('[data-unknown]')).toHaveLength(2)
    expect(harness.container.textContent).not.toContain('0')
    harness.cleanup()
  })
})
