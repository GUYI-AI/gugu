import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import { ChatComposer, type ComposerEffortOption, type ComposerModelOption } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
import { resolveModelProvider } from '@renderer/features/sessions/session-config/model-provider'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@gugu/session-ui/styles/overflow-fade.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * The composer's model button names the model and its thinking level, e.g. "Opus 5.5 中" (owner 2026-11-26): the level
 * in the secondary text colour, under the same name the "思考强度" row of the model menu shows; only the name when the
 * model has no levels to choose from; in a narrow row the name gives way to an ellipsis and the level stays whole.
 */

const icon = (id: string, name: string) => modelProviderIcon(resolveModelProvider(id, name))
const MODELS: Record<string, ComposerModelOption> = {
  'claude-opus-5-5': { name: 'Opus 5.5', icon: icon('claude-opus-5-5', 'Opus 5.5') },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', icon: icon('claude-sonnet-5-5', 'Claude Sonnet 5.5') },
  'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', icon: icon('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash') },
}
/** The host hands the menu localized level names (`localizeEffortOptions`); these are its zh-CN words. */
const EFFORTS: Record<string, ComposerEffortOption> = {
  low: { name: '低' },
  medium: { name: '中' },
  high: { name: '高' },
}

const TOOLBAR = '[data-slot="composer-toolbar"]'
const trigger = () => document.querySelector<HTMLElement>('[data-testid="composer-model-trigger"]')!
const label = () => trigger().querySelector<HTMLElement>('[data-slot="composer-model-trigger-label"]')!
const effort = () => trigger().querySelector<HTMLElement>('[data-slot="composer-effort"]')
const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))

let root: Root | null = null
let container: HTMLDivElement | null = null
let previousLanguage = 'zh-CN'

beforeEach(async () => {
  previousLanguage = i18n.language
  await i18n.changeLanguage('zh-CN')
  await page.viewport(1200, 700)
  document.body.style.margin = '0'
  container = document.createElement('div')
  container.className = 'emlight gugu-skin bg-background'
  container.style.cssText = 'position:fixed;right:24px;bottom:24px'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
  await i18n.changeLanguage(previousLanguage)
})

async function renderComposer(input: {
  width?: number
  model?: string
  efforts?: Record<string, ComposerEffortOption> | null
  selectedEffort?: string
  defaultEffort?: string
  agentLocked?: boolean
}) {
  container!.style.width = `${input.width ?? 640}px`
  root!.render(
    <SessionLocalizationProvider>
      <ChatComposer
        modelOptions={MODELS}
        selectedModel={input.model ?? 'claude-opus-5-5'}
        onModelChange={() => {}}
        effortOptions={input.efforts === undefined ? EFFORTS : input.efforts}
        selectedEffort={input.selectedEffort}
        defaultEffort={input.defaultEffort}
        onEffortChange={() => {}}
        agentOptions={[{ id: 'claude', name: 'Claude', icon: <svg width="14" height="14" /> }]}
        selectedAgent="claude"
        agentLocked={input.agentLocked}
        permissionModeOptions={{ full: { name: '完全访问', destructive: true } }}
        selectedPermissionMode="full"
        onAttach={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>
  )
  await until('model trigger mounted', () => document.querySelector('[data-testid="composer-model-trigger"]') !== null)
  // The narrow-row ladder climbs one tier per layout; wait until it stops.
  let last: string | null = null
  for (let same = 0, frames = 0; same < 3 && frames < 120; frames++) {
    await settle()
    const now = document.querySelector(TOOLBAR)?.getAttribute('data-disclosure') ?? null
    same = now !== null && now === last ? same + 1 : 0
    last = now
  }
}

describe('composer model button: model name and thinking level', () => {
  it('reads "Opus 5.5 中", the level a separate slot after the name', async () => {
    await renderComposer({ selectedEffort: 'medium' })
    expect(label().textContent).toBe('Opus 5.5')
    expect(effort()?.textContent).toBe('中')
    // The vendor mark before the name carries its own text for screen readers.
    expect(trigger().textContent?.endsWith('Opus 5.5 中')).toBe(true)
    expect(effort()!.getBoundingClientRect().left).toBeGreaterThan(label().getBoundingClientRect().right)
  })

  it('uses the level the menu shows: with no pick, the model default', async () => {
    await renderComposer({ defaultEffort: 'high' })
    expect(effort()?.textContent).toBe('高')
  })

  it('shows only the name when the model has no level to choose from, or none applies', async () => {
    await renderComposer({ model: 'deepseek-v4.1-flash', efforts: null })
    expect(effort()).toBeNull()
    expect(trigger().textContent?.endsWith('DeepSeek V4.1 Flash')).toBe(true)
    await renderComposer({ efforts: { high: { name: '高' } }, selectedEffort: 'high' })
    expect(effort(), 'a single level is no choice: the menu has no 思考强度 row either').toBeNull()
    await renderComposer({ efforts: EFFORTS })
    expect(effort(), 'no pick and no default').toBeNull()
  })

  it('keeps the level in the secondary colour while the name lights up on hover', async () => {
    await renderComposer({ selectedEffort: 'medium' })
    const rest = getComputedStyle(effort()!).color
    expect(rest).toBe(getComputedStyle(trigger()).color)
    await page.elementLocator(trigger()).hover()
    await until('trigger hover colour applied', () => getComputedStyle(label()).color !== rest)
    expect(getComputedStyle(effort()!).color).toBe(rest)
  })

  it('in the narrowest row the name takes the ellipsis and the level stays whole', async () => {
    // A session's composer (its agent fixed) in a 236px pane.
    await renderComposer({ width: 236, model: 'claude-sonnet-5-5', selectedEffort: 'medium', agentLocked: true })
    expect(document.querySelector(TOOLBAR)!.getAttribute('data-disclosure')).toBe('6')
    expect(label().scrollWidth, 'the name is cut').toBeGreaterThan(label().clientWidth)
    expect(label().clientWidth, 'part of the name still shows').toBeGreaterThan(0)
    const level = effort()!
    expect(level.getBoundingClientRect().width).toBeGreaterThan(0)
    expect(level.scrollWidth, 'the level is not cut').toBeLessThanOrEqual(level.clientWidth)
    expect(level.getBoundingClientRect().right, 'nor clipped by the button').toBeLessThanOrEqual(trigger().getBoundingClientRect().right)
    const bar = document.querySelector(TOOLBAR)!.getBoundingClientRect()
    const buttons = [...document.querySelectorAll<HTMLElement>(`${TOOLBAR} button`)]
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .sort((a, b) => a.left - b.left)
    expect(buttons.at(-1)!.right).toBeLessThanOrEqual(bar.right + 0.5)
    for (let i = 1; i < buttons.length; i++) expect(buttons[i].left).toBeGreaterThanOrEqual(buttons[i - 1].right - 1)
  })
})
