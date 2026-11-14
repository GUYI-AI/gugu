import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer, MessageProvider, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null })

function render(props: { queue: boolean }, api: React.RefObject<PromptEditorRef | null>, queued: () => void, stop: () => void) {
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;bottom:0;left:0;width:900px'
  root = createRoot(host)
  root.render(<ThemeProvider><MessageProvider locale="en-US" translate={translateSessionMessage}>
    <ChatComposer isWorking canSubmit editorApiRef={api} editorOptions={{ clearOnSubmit: false }}
      onSubmit={() => {}} onSubmitWhileWorking={props.queue ? queued : undefined} onStop={stop} />
  </MessageProvider></ThemeProvider>)
}

it('a running desktop composer that can queue shows Send once text is typed, and Stop again when empty', async () => {
  await page.viewport(1000, 700)
  const api = createRef<PromptEditorRef>()
  const queued = vi.fn(); const stop = vi.fn()
  render({ queue: true }, api, queued, stop)
  await until('empty working composer shows Stop', () => !!host?.querySelector('[data-composer-action="stop"]'))
  await page.getByTestId('prompt-editor').fill('queued while working')
  const name = translateSessionMessage('composer.sendMessage')
  await until('typed text swaps Stop for Send', () => !host?.querySelector('[data-composer-action="stop"]') && !!host?.querySelector(`button[aria-label="${name}"]`))
  await page.getByRole('button', { name }).click()
  await until('Send queues the input', () => queued.mock.calls.length === 1)
  expect(stop).not.toHaveBeenCalled()
  api.current!.clear()
  await until('empty again shows Stop', () => !!host?.querySelector('[data-composer-action="stop"]'))
})

it('a running desktop composer that cannot queue keeps Stop while text is typed', async () => {
  await page.viewport(1000, 700)
  const api = createRef<PromptEditorRef>()
  render({ queue: false }, api, vi.fn(), vi.fn())
  await page.getByTestId('prompt-editor').fill('cannot queue')
  expect(host!.querySelector('[data-composer-action="stop"]')).not.toBeNull()
})
