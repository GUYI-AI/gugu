import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

// gugu-dev#1556 The red row of #3974's evidence: a session on a model with no levels, switched to a Gugu platform model,
// showed only the model name through its first restart. The directory now gives each platform model a default level;
// the model menu arms a model's `defaultEffortId` when the current level does not carry over, so the switch records the
// directory's level and the restart shows it ("GPT-6 Luna 中"). Without the field, the switch is what it was.
//
// The options go through the product's own pipeline (`composerModelOptions`), from a directory row as the catalog sends it.

const LEVELS = { low: { name: '低' }, medium: { name: '中' }, high: { name: '高' } }
const STUB = 'custom:conn:stub/model-401'
const LUNA = 'platform:gpt-6-luna'

const optionsWith = (defaultReasoningEffort?: string) => composerModelOptions(
  { [STUB]: { name: 'stub/model-401' } },
  [{
    id: 'gpt-6-luna',
    displayName: 'GPT-6 Luna',
    protocol: 'openai-responses',
    creditMultiplier: null,
    contextWindow: null,
    reasoningEfforts: ['low', 'medium', 'high'],
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  }],
)

let root: Root | null = null
let container: HTMLDivElement | null = null
let previousLanguage = 'en-US'
const onModelChange = vi.fn()

const render = (models: ReturnType<typeof optionsWith>, selectedModel: string, selectedEffort?: string) => {
  root!.render(
    <SessionLocalizationProvider>
      <ChatComposer
        modelOptions={models}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        effortOptions={selectedModel === LUNA ? LEVELS : undefined}
        effortOptionsForModel={(id) => (id === LUNA ? LEVELS : null)}
        selectedEffort={selectedEffort}
        onEffortChange={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>,
  )
}

const pickLuna = async () => {
  await page.getByTestId('composer-model-trigger').click()
  await until('model panel lists options', () => document.querySelectorAll('[data-slot="combobox-content"] [role="option"]').length > 0)
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-content"] [role="option"]')]
    .find((element) => element.getAttribute('data-model-option-id') === LUNA)
  expect(option, 'GPT-6 Luna is listed').toBeTruthy()
  option!.click()
  await until('the switch is asked for', () => onModelChange.mock.calls.length > 0)
}

const triggerText = () =>
  document.querySelector('[data-testid="composer-model-trigger"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

describe('platform model default level from the directory (gugu-dev#1556)', () => {
  beforeEach(async () => {
    previousLanguage = i18n.language
    await i18n.changeLanguage('en-US')
    onModelChange.mockReset()
    container = document.createElement('div')
    container.className = 'emlight gugu-skin bg-background'
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await i18n.changeLanguage(previousLanguage)
    document.body.classList.remove('emlight', 'gugu-skin')
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('switching from a model with no levels arms the directory default, so the restart reads "GPT-6 Luna 中"', async () => {
    const models = optionsWith('medium')
    render(models, STUB)
    await until('trigger mounted', () => triggerText().endsWith('stub/model-401'))
    await pickLuna()
    expect(onModelChange).toHaveBeenCalledWith(LUNA, 'medium')
    // The level travels with the switch onto the session record; while the session restarts the composer reads it there.
    render(models, LUNA, onModelChange.mock.calls[0]![1])
    await until('trigger names the level', () => triggerText().endsWith('GPT-6 Luna 中'))
    expect(document.querySelector('[data-slot="composer-effort"]')?.textContent).toBe('中')
  })

  it('without the field (an older server), the switch carries no level, as before', async () => {
    const models = optionsWith()
    render(models, STUB)
    await until('trigger mounted', () => triggerText().endsWith('stub/model-401'))
    await pickLuna()
    expect(onModelChange).toHaveBeenCalledWith(LUNA)
    render(models, LUNA)
    await until('trigger shows the model', () => triggerText().endsWith('GPT-6 Luna'))
    expect(document.querySelector('[data-slot="composer-effort"]')).toBeNull()
  })
})
