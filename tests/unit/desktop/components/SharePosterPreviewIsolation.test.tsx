// @vitest-environment jsdom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, setLocalePreference } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerContactsCatalog'
import { createNode, createReactHarness } from '../../../support/testHarness'

const poster = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => ({ toDataURL: () => 'data:image/png;base64,cG9zdGVy' })))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,cXI=') } }))
vi.mock('../../../../apps/desktop/src/components/sharePosterCanvas', () => ({
  createSharePosterCanvas: poster, copyPosterToClipboard: vi.fn(), downloadPoster: vi.fn(),
}))

let SharePosterDialog: typeof import('../../../../apps/desktop/src/components/SharePosterDialog')['SharePosterDialog']
let PersonalSharePreview: typeof import('../../../../apps/desktop/src/components/referralPreview/ReferralPreview')['PersonalSharePreview']
let harness: ReturnType<typeof createReactHarness>
beforeAll(async () => {
  vi.stubEnv('VITE_REFERRAL_ENTRY_PREVIEW', '0')
  ;({ SharePosterDialog } = await import('../../../../apps/desktop/src/components/SharePosterDialog'))
  ;({ PersonalSharePreview } = await import('../../../../apps/desktop/src/components/referralPreview/ReferralPreview'))
})
beforeEach(async () => {
  poster.mockClear(); harness = createReactHarness()
  await act(async () => { setLocalePreference('zh-CN'); await i18n.changeLanguage('zh-CN') })
})
afterEach(() => harness.cleanup())
afterAll(() => vi.unstubAllEnvs())

describe('default sharing with the referral preview disabled', () => {
  for (const surface of ['default share', 'personal card fallback'] as const) {
    it(`preserves the existing shared copy and poster options for ${surface}`, async () => {
      const Component = surface === 'default share' ? SharePosterDialog : PersonalSharePreview
      await harness.render(createNode(Component, { title: 'Existing card', subtitle: 'Existing subtitle', qrValue: 'gugu://contact/123', onClose: () => {} }))
      await act(async () => { await Promise.resolve() })
      expect(poster).toHaveBeenCalled()
      expect(poster.mock.calls.at(-1)![0]).toMatchObject({
        title: 'Existing card', subtitle: 'Existing subtitle',
        qrCaption: '扫码加入 咕咕', ctaText: '用 咕咕 连接你的 AI 协作网络', variant: undefined,
      })
      expect(document.body.textContent).not.toContain('建议 · 待审核')
    })
  }
})
