// @vitest-environment jsdom
import { act } from 'react'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { contactsService } from '../../../../apps/desktop/src/lib/contacts'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, typeInto, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/imRepository', async (original) => ({
  ...await original<object>(),
  openedImRepository: async () => ({ putIdentities: async () => undefined }),
}))

vi.mock('../../../../apps/desktop/src/lib/referrals', () => ({ getMyReferral: vi.fn(async () => { throw new Error('unavailable') }) }))

let AddFriendSearch: typeof import('../../../../apps/desktop/src/components/AddFriendSearch')['AddFriendSearch']
let harness: ReturnType<typeof createReactHarness>

beforeAll(async () => {
  vi.stubEnv('VITE_REFERRAL_ENTRY_PREVIEW', '1')
  ;({ AddFriendSearch } = await import('../../../../apps/desktop/src/components/AddFriendSearch'))
})
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })
afterAll(() => { vi.unstubAllEnvs() })

describe('empty contact search referral suggestion', () => {
  it('shows the empty result before offering an invitation after a completed search', async () => {
    const searchUsers = vi.spyOn(contactsService, 'searchUsers').mockResolvedValue([])
    await renderWithAppProviders(harness, createNode(AddFriendSearch), { contacts: {} })
    const input = harness.container.querySelector('input')!
    await typeInto(input, 'missing-person@example.test')
    expect(harness.container.querySelector('[data-testid="referral-preview-search"]')).toBeNull()

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(searchUsers).toHaveBeenCalledWith('missing-person@example.test', 'user-1')
    await waitForCondition(() => harness.container.querySelector('[data-testid="referral-preview-search"]') !== null, 'no invitation')
    const emptyText = i18n.t('friendSearch.noResultsFor', { ns: 'contacts', query: 'missing-person@example.test' })
    const empty = [...harness.container.querySelectorAll('div')].find(element => element.textContent === emptyText)
    const invitation = harness.container.querySelector('[data-testid="referral-preview-search"]')
    expect(empty).toBeDefined()
    expect(invitation).not.toBeNull()
    expect(empty!.compareDocumentPosition(invitation!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await typeInto(input, 'another-person@example.test')
    expect(harness.container.querySelector('[data-testid="referral-preview-search"]')).toBeNull()
  })

  it('opens the disconnected invitation from the empty-search suggestion', async () => {
    vi.spyOn(contactsService, 'searchUsers').mockResolvedValue([])
    await renderWithAppProviders(harness, createNode(AddFriendSearch), { contacts: {} })
    const input = harness.container.querySelector('input')!
    await typeInto(input, 'missing-person@example.test')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await waitForCondition(() => harness.container.querySelector('[data-testid="referral-preview-search"]') !== null, 'no invitation')

    await clickElement(harness.container.querySelector('[data-testid="referral-preview-search"]')!)

    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    for (const key of ['copyCode', 'copyLink'] as const) {
      const label = i18n.t(`referralPreview.${key}`, { ns: 'main' })
      const button = [...dialog!.querySelectorAll('button')].find(element => element.textContent === label)
      expect(button?.disabled).toBe(true)
    }
  })
})
