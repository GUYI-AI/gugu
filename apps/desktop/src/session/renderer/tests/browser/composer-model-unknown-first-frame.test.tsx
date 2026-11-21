import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * A new-task box opens before what decides its model (the remembered choice, the Gugu catalog) is read; until then the
 * selected id is the harness default, a guess. The trigger holds the name's place in that frame, ❌ draws the default
 * and then switches to the remembered model.
 */
const MODELS = {
  'gpt-6.1-sol': { name: 'GPT-6.1-Sol', groupLabel: 'Codex' },
  'platform:gpt-6-luna': { name: 'GPT-6 Luna', groupLabel: 'Gugu' },
}
const EFFORTS = { low: { name: 'Low' }, high: { name: 'High' } }

let root: Root | null = null
let container: HTMLDivElement | null = null

const trigger = () => document.querySelector<HTMLElement>('[data-testid="composer-model-trigger"]')

function render(selectedModel: string, modelUnknown: boolean) {
  flushSync(() => root!.render(
    <SessionLocalizationProvider>
      <ChatComposer
        modelOptions={MODELS}
        selectedModel={selectedModel}
        modelUnknown={modelUnknown}
        effortOptions={EFFORTS}
        selectedEffort="low"
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>
  ))
}

beforeEach(async () => {
  await page.viewport(1400, 800)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
})

it('holds the model name place while the choice is unknown, then draws the remembered model', () => {
  render('gpt-6.1-sol', true)
  const first = trigger()!
  expect(first.textContent).not.toContain('GPT-6.1-Sol')
  expect(first.textContent).not.toContain('Low')
  expect(first.querySelector('[data-unknown]')).not.toBeNull()

  render('platform:gpt-6-luna', false)
  expect(trigger()!.textContent).toContain('GPT-6 Luna')
  expect(trigger()!.querySelector('[data-unknown]')).toBeNull()
})
