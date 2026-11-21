// @vitest-environment jsdom
// A session menu's 「旧聊天」 entry: a failed read keeps it (the dialog says why) — also a read again failing over "none".
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const io = vi.hoisted(() => ({ has: vi.fn(async () => false) }))
vi.mock('../../../../apps/desktop/src/components/legacy-dm-history/useLegacyDmOwner', () => ({ useLegacyDmOwner: () => 'owner' }))
vi.mock('../../../../apps/desktop/src/components/legacy-dm-history/data', () => ({ hasLegacyDmHistory: io.has }))

const { useLegacyDmHistoryEntry } = await import('../../../../apps/desktop/src/components/legacy-dm-history/useLegacyDmHistoryEntry')
const { legacyDmHistoryAvailable } = await import('../../../../apps/desktop/src/components/legacy-dm-history/legacyDmReplicas')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')

let harness: ReturnType<typeof createReactHarness>
let entry: ReturnType<typeof useLegacyDmHistoryEntry>
function Menu() { entry = useLegacyDmHistoryEntry('session-1'); return createElement('p', null, String(entry.isAvailable())) }
beforeEach(() => { queryClient.clear(); followRendererSession('SIGNED_IN', 'owner'); harness = createReactHarness(); io.has.mockReset().mockResolvedValue(false) })
afterEach(() => harness.cleanup())

it('"none" read before, a read again that fails offers the entry (as a plain failure does), ❌ hidden by the old answer', async () => {
  await harness.render(createElement(Menu))
  await act(async () => { entry.onMenuOpen() })
  await vi.waitFor(() => expect(io.has).toHaveBeenCalled())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(harness.container.textContent).toBe('false')
  io.has.mockRejectedValue(new Error('offline'))
  await act(async () => { await legacyDmHistoryAvailable.refresh('session-1').catch(() => undefined) })
  await vi.waitFor(() => expect(harness.container.textContent).toBe('true'))
})
