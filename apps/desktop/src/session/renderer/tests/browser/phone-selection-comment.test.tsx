import { afterEach, expect, it, vi } from 'vitest'
import { PhoneTextSelection } from '@/components/chat/PhoneTextSelection'
import { capturePhoneTextSelection } from '@/components/chat/phoneTextSelectionSource'
import type { NativeTextSelectionRequest } from '@/platform/nativeTextSelection'
import { platform } from '@/platform'
import { i18n } from '@/i18n'
import '@/i18n/registerMessagingCatalog'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))

// The phone's native selection page (Android, iOS) offers Comment beside the OS's Copy when the bubble asks for it, and
// hands the selected words back when Comment closes the page; Copy and a dismissal close it with nothing.
let bubble: HTMLDivElement | undefined
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); bubble?.remove(); delete (platform as { textSelection?: unknown }).textSelection })

async function select(closed: { comment?: string } | undefined, onComment?: (words: string) => void) {
  bubble = document.createElement('div')
  bubble.style.cssText = 'position:fixed;left:16px;top:16px;width:300px;font:16px/24px sans-serif'
  bubble.textContent = 'The harbor opens at six.'
  document.body.append(bubble)
  const box = bubble.getBoundingClientRect()
  const source = capturePhoneTextSelection(bubble, box.x + 40, box.y + box.height / 2)!
  const requests: NativeTextSelectionRequest[] = []
  Object.assign(platform, { textSelection: { open: vi.fn(async (request: NativeTextSelectionRequest) => { requests.push(request); return closed }), close: vi.fn(async () => {}) } })
  const onDone = vi.fn()
  harness = createReactHarness()
  await renderWithAppProviders(harness, <PhoneTextSelection source={source} onDone={onDone} onComment={onComment} />)
  await until('the native page closed', () => onDone.mock.calls.length === 1)
  return requests
}

it.each([['zh-CN', '评论'], ['en-US', 'Comment']] as const)('offers Comment in %s and hands the selected words back', async (locale, label) => {
  await i18n.changeLanguage(locale)
  const onComment = vi.fn()
  const requests = await select({ comment: 'harbor opens' }, onComment)
  expect(requests[0]?.commentLabel).toBe(label)
  expect(onComment).toHaveBeenCalledWith('harbor opens')
})

it('a page closed by Copy or a dismissal comments on nothing', async () => {
  const onComment = vi.fn()
  await select(undefined, onComment)
  expect(onComment).not.toHaveBeenCalled()
})

it('without a comment to open, the page offers only the OS\'s own actions', async () => {
  const requests = await select(undefined)
  expect(requests[0]).not.toHaveProperty('commentLabel')
})
