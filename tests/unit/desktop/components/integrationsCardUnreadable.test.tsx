// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/** This desktop's integration list unreadable: said with a retry, ❌ an empty 「可用」 section as if nothing could be connected. */
const api = vi.hoisted(() => ({
  list: vi.fn(),
  checkAllConnections: vi.fn(async () => ({})),
  checkConfiguredConnections: vi.fn(async () => ({})),
}))
const host = vi.hoisted(() => ({ run: 0, value: null as null | Record<string, unknown> }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host', () => ({
  isTooOld: () => false, useLibraryHost: () => host.value, keepLibraryHost: (h: unknown) => h, libraryHostOf: () => host.value, peekLibraryHost: () => host.value,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/useGithubAccounts', () => ({ useGitHubAccounts: () => ({ state: 'unknown' }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/settings/components/use-library-sheet-selection', () => ({ useLibrarySheetSelection: () => [null, vi.fn()] }))

const { IntegrationsProvider } = await import('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider')
const { default: IntegrationsCard } = await import('../../../../apps/desktop/src/session/renderer/features/settings/components/IntegrationsCard')

let h: ReturnType<typeof createReactHarness>
beforeEach(() => {
  h = createReactHarness()
  host.run += 1
  host.value = { key: `local-${host.run}`, integrations: api }
  api.list.mockReset().mockRejectedValue(new Error('main could not list them'))
})
afterEach(() => h.cleanup())

it('says the list could not be read, and its retry reads it', async () => {
  await h.render(<IntegrationsProvider><IntegrationsCard /></IntegrationsProvider>)
  const failed = () => h.container.querySelector('[data-read-failed]')
  await vi.waitFor(() => expect(failed()).not.toBeNull())
  api.list.mockResolvedValue([])
  ;(failed()!.querySelector('button') as HTMLButtonElement).click()
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
})
