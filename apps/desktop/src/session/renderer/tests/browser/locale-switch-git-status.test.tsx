/**
 * The git status line (an `observer`) words its detached-head tooltip in the app's language after a switch, without a
 * reload. Its workspace is stubbed: the case is about the words, not the repository.
 */
import { afterEach, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n, setLocalePreference } from '@/i18n'
import { registerSessionLocaleResources } from '@renderer/localization/locale-store'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useWorkspace: () => ({ gitWorktree: { headDisplay: 'a1b2c3d', headKind: 'detached' }, gitRepository: null }),
  useSessionViewContext: () => ({ projectId: 'p', sessionId: 's' }),
}))
registerSessionLocaleResources()
/** A session word in a given language (the session namespace interpolates `{x}`). */
const say = (key: string, locale: 'en-US' | 'zh-CN', values: Record<string, string> = {}) =>
  i18n.t(key, { ns: 'session', lng: locale, ...values, interpolation: { prefix: '{', suffix: '}' } })
const { GitStatusSection } = await import('@renderer/features/sessions/diff-view/changes-panel/git-status-section')

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined; setLocalePreference('system') })

it('the detached-head tooltip follows a language switch', async () => {
  setLocalePreference('en-US')
  await page.viewport(900, 600)
  harness = createReactHarness()
  harness.container.className = 'emlight gugu-skin'
  await harness.render(<GitStatusSection />)
  await userEvent.hover(page.getByText('a1b2c3d'))
  const words = (locale: 'en-US' | 'zh-CN') => say('git.detachedAt', locale, { ref: 'a1b2c3d' })
  const tooltip = () => [...document.querySelectorAll('[role="tooltip"], [data-slot="tooltip-content"]')].map((node) => node.textContent).join('')
  await until('drawn in English', tooltip, (text) => text.includes(words('en-US')))
  setLocalePreference('zh-CN')
  await until('the tooltip speaks Chinese', tooltip, (text) => text.includes(words('zh-CN')))
  setLocalePreference('en-US')
  await until('and English again', tooltip, (text) => text.includes(words('en-US')))
})
