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

// gugu-dev#1579 (owner 2026-11-27 「B」) Only a level the person picked follows a model switch. A level the app filled in
// (the directory default of the model before, the fixed medium) stays with its model: the new model starts at its own
// default. Before, the menu carried whatever level was shown, so a model whose directory default is low started at the
// medium the previous model had been given.
//
// The options go through the product's own pipeline (`composerModelOptions`), from directory rows as the catalog sends them.

const LUNA = 'platform:gpt-6-luna'
const FLASH = 'platform:glm-5.3-flash'
const LUNA_LEVELS = { low: { name: '低' }, medium: { name: '中' }, high: { name: '高' } }
const FLASH_LEVELS = { low: { name: '低' }, high: { name: '高' }, max: { name: '最大' } }
const levelsOf = (id: string) => (id === LUNA ? LUNA_LEVELS : id === FLASH ? FLASH_LEVELS : null)

const optionsWith = (flashDefault?: string) => composerModelOptions({}, [
  {
    id: 'gpt-6-luna', displayName: 'GPT-6 Luna', protocol: 'openai-responses', creditMultiplier: null, contextWindow: null,
    reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium',
  },
  {
    id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', protocol: 'openai-chat-completions', creditMultiplier: null, contextWindow: null,
    reasoningEfforts: ['low', 'high', 'max'], ...(flashDefault ? { defaultReasoningEffort: flashDefault } : {}),
  },
])

let root: Root | null = null
let container: HTMLDivElement | null = null
let previousLanguage = 'en-US'
const onModelChange = vi.fn()

const render = (models: ReturnType<typeof optionsWith>, selectedEffort: string, pickedEffort?: string) => {
  root!.render(
    <SessionLocalizationProvider>
      <ChatComposer
        modelOptions={models}
        selectedModel={LUNA}
        onModelChange={onModelChange}
        effortOptions={LUNA_LEVELS}
        effortOptionsForModel={levelsOf}
        selectedEffort={selectedEffort}
        pickedEffort={pickedEffort}
        onEffortChange={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>,
  )
}

const switchToFlash = async () => {
  await until('trigger mounted', () => !!document.querySelector('[data-testid="composer-model-trigger"]'))
  await page.getByTestId('composer-model-trigger').click()
  await until('model panel lists options', () => document.querySelectorAll('[data-slot="combobox-content"] [role="option"]').length > 0)
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-content"] [role="option"]')]
    .find((element) => element.getAttribute('data-model-option-id') === FLASH)
  expect(option, 'GLM 5.3 Flash is listed').toBeTruthy()
  option!.click()
  await until('the switch is asked for', () => onModelChange.mock.calls.length > 0)
}

describe('only a picked thinking level follows a model switch (gugu-dev#1579)', () => {
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

  it('a level picked by hand follows when the new model offers it', async () => {
    render(optionsWith('low'), 'high', 'high')
    await switchToFlash()
    expect(onModelChange).toHaveBeenCalledWith(FLASH, 'high')
  })

  it('a level the app filled in does not follow: the new model starts at its own default', async () => {
    // GPT-6 Luna started at its directory default (low is on offer on both, so before this change low would carry too).
    render(optionsWith('low'), 'high')
    await switchToFlash()
    expect(onModelChange).toHaveBeenCalledWith(FLASH, 'low')
  })

  it('a picked level the new model does not offer gives way to the new model\'s default', async () => {
    render(optionsWith('low'), 'medium', 'medium')
    await switchToFlash()
    expect(onModelChange).toHaveBeenCalledWith(FLASH, 'low')
  })

  it('without a directory default (an older server), an unpicked level is not carried: the host\'s own rule decides', async () => {
    render(optionsWith(), 'high')
    await switchToFlash()
    expect(onModelChange).toHaveBeenCalledWith(FLASH)
  })
})
