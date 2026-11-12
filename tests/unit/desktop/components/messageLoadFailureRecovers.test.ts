// @vitest-environment jsdom
// A failed chat read retries on the backend-recovered edge (backendReachability), like failed sends do — and only on it.
import { expect, it, vi } from 'vitest'
import { MessageLoadFailure } from '../../../../apps/desktop/src/components/chat/MessageLoadFailure'
import { bindBackendProbe, noteBackendAnswer } from '../../../../packages/core/src/cloud/backendReachability'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const harness = createReactHarness()
const unbind = bindBackendProbe(() => {})

it('reads the line again when the backend answers after failing; not while it keeps answering; not after unmount', async () => {
  const onRetry = vi.fn(async () => {})
  await renderWithAppProviders(harness, createNode(MessageLoadFailure, { error: new Error('history unavailable'), onRetry, inline: true }), { toast: vi.fn() })
  noteBackendAnswer(true)
  expect(onRetry).not.toHaveBeenCalled()
  noteBackendAnswer(false)
  noteBackendAnswer(true)
  expect(onRetry).toHaveBeenCalledOnce()
  harness.cleanup()
  noteBackendAnswer(false)
  noteBackendAnswer(true)
  expect(onRetry).toHaveBeenCalledOnce()
  unbind()
})
