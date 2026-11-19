import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { ExtensionViewLayer } from '@renderer/features/extensions/extension-view-layer'
import { publishSelfIdentity } from '@/lib/selfIdentityBridge'

const accounts = vi.hoisted(() => ({ set: vi.fn(async () => {}) }))
vi.mock('@/lib/widgetSnapshots', async original => ({ ...(await original<object>()), widgetSnapshots: { setAccount: accounts.set, capture: () => null } }))

let harness: ReturnType<typeof createReactHarness>

afterEach(() => {
  harness?.cleanup()
  publishSelfIdentity(null)
})

// The layer is in the task workspace's own React root, outside the shell's AuthContext: the signed-in account reaches
// it through the shell's identity bridge. Widget pictures follow that account (a widget's page itself is in its bubble).
it('keeps widget pictures under the signed-in account and moves them when it changes', async () => {
  publishSelfIdentity({ userId: 'reader', displayName: null, guguNumber: null })
  harness = createReactHarness()
  await harness.render(<ExtensionViewLayer />)
  expect(accounts.set).toHaveBeenLastCalledWith('reader')
  await act(async () => publishSelfIdentity({ userId: 'other', displayName: null, guguNumber: null }))
  expect(accounts.set).toHaveBeenLastCalledWith('other')
})
