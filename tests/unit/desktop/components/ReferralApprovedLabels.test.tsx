// @vitest-environment jsdom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'

let AddFriendSearch: typeof import('../../../../apps/desktop/src/components/AddFriendSearch')['AddFriendSearch']
let ReferralAccountPreview: typeof import('../../../../apps/desktop/src/components/referralPreview/ReferralPreview')['ReferralAccountPreview']
let harness: ReturnType<typeof createReactHarness>

beforeAll(async () => {
  vi.stubEnv('VITE_REFERRAL_ENTRY_PREVIEW', '1')
  ;({ AddFriendSearch } = await import('../../../../apps/desktop/src/components/AddFriendSearch'))
  ;({ ReferralAccountPreview } = await import('../../../../apps/desktop/src/components/referralPreview/ReferralPreview'))
})
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); delete document.documentElement.dataset.theme })
afterAll(() => { vi.unstubAllEnvs() })

const variants = [
  ['zh-CN', 'light'], ['zh-CN', 'dark'], ['en-US', 'light'], ['en-US', 'dark'],
] as const

describe.each(variants)('approved referral entry labels (%s, %s)', (locale, theme) => {
  beforeEach(async () => {
    document.documentElement.dataset.theme = theme
    await act(async () => { setLocalePreference(locale); await i18n.changeLanguage(locale) })
  })

  it('shows the completed empty-search invitation without a review qualifier', async () => {
    await renderWithAppProviders(harness, createNode(AddFriendSearch), { contacts: { searchResults: [] } })
    const input = harness.container.querySelector('input')!
    await typeInto(input, 'missing-person@example.test')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    const invitation = harness.container.querySelector('[data-testid="referral-preview-search"]')
    expect(invitation).not.toBeNull()
    expect(invitation!.textContent).toBe(i18n.t('referralPreview.inviteToGugu', { ns: 'main' }))
    expect(invitation!.textContent).not.toContain(i18n.t('referralPreview.proposal', { ns: 'main' }))
  })

  it('keeps the account title, disconnected status and View action without a review qualifier', async () => {
    await harness.render(createNode(ReferralAccountPreview))
    const account = harness.container.querySelector('.gg-referral-account-preview')
    expect(account).not.toBeNull()
    expect(account!.querySelector('.gg-settings-row-title')!.textContent).toBe(i18n.t('referralPreview.code', { ns: 'main' }))
    expect(account!.querySelector('.gg-settings-row-description')!.textContent).toBe(i18n.t('referralPreview.disconnected', { ns: 'main' }))
    expect(account!.querySelector('button')!.textContent).toBe(i18n.t('referralPreview.view', { ns: 'main' }))
    expect(account!.textContent).not.toContain(i18n.t('referralPreview.proposal', { ns: 'main' }))
  })
})
