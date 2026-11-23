// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddFriendSearch } from '../../../../apps/desktop/src/components/AddFriendSearch'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { contactsService } from '../../../../apps/desktop/src/lib/contacts'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, typeInto, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/imRepository', async (original) => ({
  ...await original<object>(),
  openedImRepository: async () => ({ putIdentities: async () => undefined }),
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })

const noResults = (query: string) => i18n.t('friendSearch.noResultsFor', { ns: 'contacts', query })
const input = () => harness.container.querySelector('input') as HTMLInputElement
const submit = () => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
const rowTitles = () => [...harness.container.querySelectorAll('.gg-row .gg-list-row-title')].map((row) => row.textContent)

// The user search is a reading of the submitted query (lib/contactsReplicas.ts userSearch), ❌ the contacts store's state.
describe('AddFriendSearch reads the submitted search', () => {

  it('says a failed search where the hits go, and Retry reads again', async () => {
    const search = vi.spyOn(contactsService, 'searchUsers')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([contact({ id: 'bob', display_name: 'Bob' })])
    const toast = vi.fn()
    await renderWithAppProviders(harness, createNode(AddFriendSearch), { contacts: {}, toast })
    await typeInto(input(), 'bob')
    await submit()
    await waitForCondition(() => harness.container.querySelector('[data-testid="friend-search-failed"]') !== null, 'failure not said')
    const failed = harness.container.querySelector('[data-testid="friend-search-failed"]')!
    expect(failed.textContent).toContain('network down')
    expect(harness.container.textContent).not.toContain(noResults('bob'))
    await clickElement(failed.querySelector('button')!)
    await waitForCondition(() => rowTitles().includes('Bob'), 'retry did not read again')
    expect(search).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('[data-testid="friend-search-failed"]')).toBeNull()
  })

  it('reads again when the same query is submitted again', async () => {
    const search = vi.spyOn(contactsService, 'searchUsers')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([contact({ id: 'carol', display_name: 'Carol' })])
    await renderWithAppProviders(harness, createNode(AddFriendSearch), { contacts: {} })
    await typeInto(input(), 'carol')
    await submit()
    await waitForCondition(() => harness.container.textContent?.includes(noResults('carol')) ?? false, 'no empty answer')
    await submit()
    await waitForCondition(() => rowTitles().includes('Carol'), 'the same query was not read again')
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('searches what a scanned code seeds', async () => {
    const search = vi.spyOn(contactsService, 'searchUsers').mockResolvedValue([contact({ id: 'dave', display_name: 'Dave' })])
    await renderWithAppProviders(harness, createNode(AddFriendSearch, { seed: { query: '109601', token: 1 } }), { contacts: {} })
    await waitForCondition(() => rowTitles().includes('Dave'), 'seeded search not shown')
    expect(input().value).toBe('109601')
    expect(search).toHaveBeenCalledWith('109601', 'user-1')
  })
})
